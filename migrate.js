// migrate.js — PostgreSQL schema setup (flat structure)
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

async function migrate() {
  const client = await pool.connect();
  console.log('🔧 Running PostgreSQL migration...');
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS employees (
        employee_id   VARCHAR(50)  PRIMARY KEY,
        name          VARCHAR(100) NOT NULL,
        mobile        VARCHAR(15)  NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        role          VARCHAR(20)  NOT NULL DEFAULT 'employee'
                        CHECK (role IN ('admin','manager','hr','employee')),
        designation   VARCHAR(100) DEFAULT '',
        district      VARCHAR(100) DEFAULT '',
        is_active     BOOLEAN      DEFAULT true,
        created_at    TIMESTAMPTZ  DEFAULT NOW(),
        updated_at    TIMESTAMPTZ  DEFAULT NOW()
      )
    `);

    // Re-runnable on a DB that was migrated before manager/hr existed:
    // widen the CHECK constraint instead of erroring out if it already exists.
    await client.query(`
      ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_role_check;
      ALTER TABLE employees ADD CONSTRAINT employees_role_check
        CHECK (role IN ('admin','manager','hr','employee'));
    `);

    // ── Extend employees: email (mandatory going forward, used for password
    // reset) + manager_id (self-referencing, powers "my team" for managers).
    // Both added as nullable ALTERs so this is safe to run against an existing,
    // populated table — nothing existing breaks.
    await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS email VARCHAR(255);`);
    await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS manager_id VARCHAR(50) REFERENCES employees(employee_id) ON DELETE SET NULL;`);
    // Partial unique index instead of a plain UNIQUE constraint, so existing
    // rows with a NULL email (created before this change) don't collide with
    // each other — only actual duplicate email *values* are rejected.
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_email_unique ON employees (LOWER(email)) WHERE email IS NOT NULL;`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS face_descriptors (
        id            SERIAL       PRIMARY KEY,
        employee_id   VARCHAR(50)  NOT NULL UNIQUE
                        REFERENCES employees(employee_id) ON DELETE CASCADE,
        descriptor    JSONB        NOT NULL,
        enrolled_at   TIMESTAMPTZ  DEFAULT NOW(),
        updated_at    TIMESTAMPTZ  DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS attendance (
        id            SERIAL       PRIMARY KEY,
        employee_id   VARCHAR(50)  NOT NULL
                        REFERENCES employees(employee_id) ON DELETE CASCADE,
        employee_name VARCHAR(100),
        designation   VARCHAR(100),
        district      VARCHAR(100),
        village       VARCHAR(100),
        mandal        VARCHAR(100),
        audit_type    VARCHAR(50),
        notes         TEXT         DEFAULT '',
        gps_lat       NUMERIC(10,7),
        gps_lng       NUMERIC(10,7),
        gps_accuracy  INTEGER,
        face_verified BOOLEAN      DEFAULT true,
        face_score    NUMERIC(5,2),
        display_time  VARCHAR(80),
        created_at    TIMESTAMPTZ  DEFAULT NOW()
      )
    `);

    // otp_tokens is preserved as-is (existing table, not dropped) but is no
    // longer wired into the password-reset flow — see auth.js. Left in place
    // in case anything else ever needs OTP, per "don't remove unrelated OTP
    // functionality."
    await client.query(`
      CREATE TABLE IF NOT EXISTS otp_tokens (
        id         SERIAL       PRIMARY KEY,
        mobile     VARCHAR(15)  NOT NULL,
        otp_hash   VARCHAR(255) NOT NULL,
        expires_at TIMESTAMPTZ  NOT NULL,
        used       BOOLEAN      DEFAULT false,
        created_at TIMESTAMPTZ  DEFAULT NOW()
      )
    `);

    // ── NEW: password_reset_tokens — replaces OTP for password recovery.
    // Stores a hash of a random token (never the token itself), single-use,
    // time-limited. Keyed to employee_id (found via email lookup at request time).
    await client.query(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id          SERIAL       PRIMARY KEY,
        employee_id VARCHAR(50)  NOT NULL REFERENCES employees(employee_id) ON DELETE CASCADE,
        token_hash  VARCHAR(255) NOT NULL,
        expires_at  TIMESTAMPTZ  NOT NULL,
        used        BOOLEAN      DEFAULT false,
        created_at  TIMESTAMPTZ  DEFAULT NOW()
      )
    `);

    // ── NEW: leave_types — configurable leave categories with an annual quota.
    await client.query(`
      CREATE TABLE IF NOT EXISTS leave_types (
        id                    SERIAL       PRIMARY KEY,
        name                  VARCHAR(50)  NOT NULL UNIQUE,
        annual_quota_days     INTEGER      NOT NULL DEFAULT 12,
        requires_document     BOOLEAN      DEFAULT false,
        is_active             BOOLEAN      DEFAULT true
      )
    `);
    await client.query(`
      INSERT INTO leave_types (name, annual_quota_days, requires_document) VALUES
        ('Casual Leave', 12, false),
        ('Sick Leave', 8, true),
        ('Earned Leave', 15, false)
      ON CONFLICT (name) DO NOTHING;
    `);

    // ── NEW: leave_requests
    await client.query(`
      CREATE TABLE IF NOT EXISTS leave_requests (
        id                SERIAL       PRIMARY KEY,
        employee_id       VARCHAR(50)  NOT NULL REFERENCES employees(employee_id) ON DELETE CASCADE,
        leave_type_id     INTEGER      NOT NULL REFERENCES leave_types(id),
        from_date         DATE         NOT NULL,
        to_date           DATE         NOT NULL,
        number_of_days    NUMERIC(4,1) NOT NULL,
        reason            TEXT         NOT NULL,
        attachment_path   VARCHAR(255),
        status            VARCHAR(20)  NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','approved','rejected','cancelled')),
        submitted_at      TIMESTAMPTZ  DEFAULT NOW(),
        approved_by       VARCHAR(50)  REFERENCES employees(employee_id),
        approved_at       TIMESTAMPTZ,
        rejection_reason  TEXT,
        created_at        TIMESTAMPTZ  DEFAULT NOW(),
        updated_at        TIMESTAMPTZ  DEFAULT NOW(),
        CHECK (to_date >= from_date)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_leave_emp    ON leave_requests(employee_id);
      CREATE INDEX IF NOT EXISTS idx_leave_status ON leave_requests(status);
    `);

    // ── NEW: role_permissions — module/action access, DB-driven (not
    // hard-coded in the frontend). Admin can view/edit this via the API.
    await client.query(`
      CREATE TABLE IF NOT EXISTS role_permissions (
        id          SERIAL       PRIMARY KEY,
        role        VARCHAR(20)  NOT NULL,
        module      VARCHAR(50)  NOT NULL,
        can_view    BOOLEAN      DEFAULT false,
        can_create  BOOLEAN      DEFAULT false,
        can_edit    BOOLEAN      DEFAULT false,
        can_delete  BOOLEAN      DEFAULT false,
        can_approve BOOLEAN      DEFAULT false,
        can_reject  BOOLEAN      DEFAULT false,
        can_export  BOOLEAN      DEFAULT false,
        UNIQUE (role, module)
      )
    `);
    // Seed a sensible default matrix (matches the module-access table in the spec).
    // Scope for this pass: 'employees', 'leaves', 'attendance', 'users' modules.
    // Field-level permissions (per-column, e.g. Salary/Bank/PAN) are NOT included —
    // those fields don't exist in this schema yet; see the QA notes for why that's
    // deliberately deferred rather than bolted on unreviewed.
    await client.query(`
      INSERT INTO role_permissions (role, module, can_view, can_create, can_edit, can_delete, can_approve, can_reject, can_export) VALUES
        ('admin',    'employees',  true,  true,  true,  true,  false, false, true),
        ('admin',    'leaves',     true,  true,  true,  true,  true,  true,  true),
        ('admin',    'attendance', true,  false, false, false, false, false, true),
        ('admin',    'users',      true,  true,  true,  true,  false, false, true),
        ('hr',       'employees',  true,  true,  true,  false, false, false, true),
        ('hr',       'leaves',     true,  false, false, false, false, false, true),
        ('hr',       'attendance', true,  false, false, false, false, false, true),
        ('hr',       'users',      true,  false, false, false, false, false, false),
        ('manager',  'employees',  true,  false, false, false, false, false, false),
        ('manager',  'leaves',     true,  false, false, false, true,  true,  false),
        ('manager',  'attendance', true,  false, false, false, false, false, false),
        ('manager',  'users',      false, false, false, false, false, false, false),
        ('employee', 'employees',  true,  false, false, false, false, false, false),
        ('employee', 'leaves',     true,  true,  false, false, false, false, false),
        ('employee', 'attendance', true,  false, false, false, false, false, false),
        ('employee', 'users',      false, false, false, false, false, false, false)
      ON CONFLICT (role, module) DO NOTHING;
    `);

    // ── NEW: audit_logs
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id          SERIAL       PRIMARY KEY,
        employee_id VARCHAR(50)  REFERENCES employees(employee_id) ON DELETE SET NULL,
        action      VARCHAR(100) NOT NULL,
        module      VARCHAR(50)  NOT NULL,
        record_id   VARCHAR(50),
        old_value   JSONB,
        new_value   JSONB,
        created_at  TIMESTAMPTZ  DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);`);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_att_emp  ON attendance(employee_id);
      CREATE INDEX IF NOT EXISTS idx_att_date ON attendance(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_otp_mob  ON otp_tokens(mobile);
    `);

    // Seed admin
    const adminHash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'Admin@123', 12);
    await client.query(`
      INSERT INTO employees (employee_id,name,mobile,password_hash,role,designation,district)
      VALUES ($1,$2,$3,$4,'admin','Administrator','HQ')
      ON CONFLICT (employee_id) DO NOTHING
    `, [
      process.env.ADMIN_ID     || 'admin',
      process.env.ADMIN_NAME   || 'Administrator',
      process.env.ADMIN_MOBILE || '9999999999',
      adminHash,
    ]);

    await client.query('COMMIT');
    console.log('✅ Migration complete!');
    console.log('   Admin → ID:', process.env.ADMIN_ID || 'admin');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', e.message);
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(e => { console.error(e); process.exit(1); });
