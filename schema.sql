-- RD-SSAAT — Database Schema (pure SQL, safe to run directly in psql / any SQL client)
-- v2: adds indexes for the email password-reset flow and Excel bulk upload, plus
--     optional maintenance / data-fix queries at the bottom (all commented out).
--     No table or column changes — an existing database upgrades in place by re-running this file.
-- This matches migrate.js exactly and was verified against a live instance,
-- including a from-scratch run against a brand-new database.
-- Run top to bottom. Safe to re-run against an existing database — uses
-- IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / DROP+ADD for constraints.

BEGIN;

-- ══════════════════════════════════════════════════════════════
-- 1. employees — staff accounts (admin, manager, hr, employee)
-- ══════════════════════════════════════════════════════════════
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
);

ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_role_check;
ALTER TABLE employees ADD CONSTRAINT employees_role_check
    CHECK (role IN ('admin','manager','hr','employee'));

ALTER TABLE employees ADD COLUMN IF NOT EXISTS email VARCHAR(255);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS manager_id VARCHAR(50) REFERENCES employees(employee_id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_email_unique ON employees (LOWER(email)) WHERE email IS NOT NULL;

-- ══════════════════════════════════════════════════════════════
-- 2. face_descriptors
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS face_descriptors (
    id            SERIAL       PRIMARY KEY,
    employee_id   VARCHAR(50)  NOT NULL UNIQUE
                    REFERENCES employees(employee_id) ON DELETE CASCADE,
    descriptor    JSONB        NOT NULL,
    enrolled_at   TIMESTAMPTZ  DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  DEFAULT NOW()
);

-- ══════════════════════════════════════════════════════════════
-- 3. attendance
-- ══════════════════════════════════════════════════════════════
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
);

-- ══════════════════════════════════════════════════════════════
-- 4. otp_tokens — preserved, no longer used for password reset (see auth.js)
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS otp_tokens (
    id         SERIAL       PRIMARY KEY,
    mobile     VARCHAR(15)  NOT NULL,
    otp_hash   VARCHAR(255) NOT NULL,
    expires_at TIMESTAMPTZ  NOT NULL,
    used       BOOLEAN      DEFAULT false,
    created_at TIMESTAMPTZ  DEFAULT NOW()
);

-- ══════════════════════════════════════════════════════════════
-- 5. password_reset_tokens — replaces OTP for password recovery
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id          SERIAL       PRIMARY KEY,
    employee_id VARCHAR(50)  NOT NULL REFERENCES employees(employee_id) ON DELETE CASCADE,
    token_hash  VARCHAR(255) NOT NULL,
    expires_at  TIMESTAMPTZ  NOT NULL,
    used        BOOLEAN      DEFAULT false,
    created_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- ══════════════════════════════════════════════════════════════
-- 6. leave_types
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS leave_types (
    id                    SERIAL       PRIMARY KEY,
    name                  VARCHAR(50)  NOT NULL UNIQUE,
    annual_quota_days     INTEGER      NOT NULL DEFAULT 12,
    requires_document     BOOLEAN      DEFAULT false,
    is_active             BOOLEAN      DEFAULT true
);

INSERT INTO leave_types (name, annual_quota_days, requires_document) VALUES
    ('Casual Leave', 12, false),
    ('Sick Leave', 8, true),
    ('Earned Leave', 15, false)
ON CONFLICT (name) DO NOTHING;

-- ══════════════════════════════════════════════════════════════
-- 7. leave_requests
-- ══════════════════════════════════════════════════════════════
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
);

-- ══════════════════════════════════════════════════════════════
-- 8. role_permissions
-- ══════════════════════════════════════════════════════════════
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
);

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

-- ══════════════════════════════════════════════════════════════
-- 9. audit_logs
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS audit_logs (
    id          SERIAL       PRIMARY KEY,
    employee_id VARCHAR(50)  REFERENCES employees(employee_id) ON DELETE SET NULL,
    action      VARCHAR(100) NOT NULL,
    module      VARCHAR(50)  NOT NULL,
    record_id   VARCHAR(50),
    old_value   JSONB,
    new_value   JSONB,
    created_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- ══════════════════════════════════════════════════════════════
-- Indexes
-- ══════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_att_emp      ON attendance(employee_id);
CREATE INDEX IF NOT EXISTS idx_att_date     ON attendance(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_otp_mob      ON otp_tokens(mobile);
CREATE INDEX IF NOT EXISTS idx_leave_emp    ON leave_requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_leave_status ON leave_requests(status);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);

-- v2: password reset / "set your password" invite links
-- (lookup of open tokens per employee, 60-second resend cooldown check, expiry cleanup)
CREATE INDEX IF NOT EXISTS idx_prt_employee_open ON password_reset_tokens(employee_id) WHERE used = false;
CREATE INDEX IF NOT EXISTS idx_prt_employee_created ON password_reset_tokens(employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prt_expires ON password_reset_tokens(expires_at);

-- v2: bulk upload checks manager references and lists staff per manager
CREATE INDEX IF NOT EXISTS idx_employees_manager ON employees(manager_id);
CREATE INDEX IF NOT EXISTS idx_employees_role ON employees(role) WHERE is_active = true;

-- ══════════════════════════════════════════════════════════════
-- Seed the admin account (no separate "users"/"admin" table — admin/manager/
-- hr/employee are all rows in `employees`, distinguished by `role`). Uses
-- pgcrypto's bcrypt as a pure-SQL substitute for migrate.js's Node bcryptjs —
-- verified compatible.
--
-- CHANGE 'Admin@123' below before running against anything but a local test DB.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO employees (employee_id, name, mobile, email, password_hash, role, designation, district)
VALUES (
    'admin', 'Administrator', '9999999999', 'admin@example.com',
    crypt('Admin@123', gen_salt('bf', 12)), 'admin', 'Administrator', 'HQ'
)
ON CONFLICT (employee_id) DO NOTHING;

COMMIT;

-- ══════════════════════════════════════════════════════════════
-- OPTIONAL — run these by hand when needed (not part of the migration)
-- ══════════════════════════════════════════════════════════════

-- 1) The seeded admin email (admin@example.com) cannot receive reset emails.
--    Put a real address on the admin account, then "Forgot Password" works for admin too:
--    UPDATE employees SET email = 'you@yourdomain.com', updated_at = NOW() WHERE employee_id = 'admin';

-- 2) Staff with no email can't use email reset. List them, then fix via Edit/SQL:
--    SELECT employee_id, name, mobile FROM employees WHERE email IS NULL OR email = '' ORDER BY employee_id;

-- 3) Housekeeping: delete reset/invite tokens that expired or were used over a week ago:
--    DELETE FROM password_reset_tokens WHERE (expires_at < NOW() - INTERVAL '7 days') OR (used AND created_at < NOW() - INTERVAL '7 days');

-- 4) Review recent bulk uploads:
--    SELECT created_at, employee_id AS uploaded_by, new_value FROM audit_logs WHERE action = 'bulk_create_employees' ORDER BY id DESC LIMIT 20;
