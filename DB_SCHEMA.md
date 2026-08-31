# RD-SSAAT — Database Schema Reference (v2)

9 tables, verified against a live instance built fresh by `migrate.js` (or `schema.sql`
for a pure-SQL setup). Unchanged since the RBAC/leave-management/email-reset phase —
this dashboard-redesign pass only touched the frontend (`index.html`).

## 1. `employees` — staff accounts (admin, manager, hr, employee)

| Column | Purpose |
|---|---|
| `employee_id` | Primary key and login ID. |
| `mobile` | Unique. |
| `password_hash` | bcrypt hash. |
| `role` | `admin`/`manager`/`hr`/`employee` — drives every permission check. |
| `email` | Mandatory going forward (partial unique index tolerates existing NULLs). Used for the password-reset link. |
| `manager_id` | Self-referencing FK to `employee_id`. Powers "My Team" — a manager's employee/leave queries are scoped to `WHERE manager_id = <their own ID>`, enforced server-side. |
| `designation`, `district` | Descriptive/reporting fields. |
| `is_active` | Checked at login; no UI wired to toggle it yet (only hard delete exists). |

## 2. `face_descriptors` — one enrolled face per employee (unchanged).
## 3. `attendance` — one row per attendance/audit visit (unchanged).

## 4. `otp_tokens` — preserved, unused

No longer wired into password recovery (see `auth.js`). Left in place in case
anything else in the system ever needs OTP.

## 5. `password_reset_tokens` — replaces OTP for password recovery

```sql
CREATE TABLE password_reset_tokens (
    id          SERIAL       PRIMARY KEY,
    employee_id VARCHAR(50)  NOT NULL REFERENCES employees(employee_id) ON DELETE CASCADE,
    token_hash  VARCHAR(255) NOT NULL,
    expires_at  TIMESTAMPTZ  NOT NULL,
    used        BOOLEAN      DEFAULT false,
    created_at  TIMESTAMPTZ  DEFAULT NOW()
);
```

Raw token is never stored — only a bcrypt hash. Single-use, time-limited.

## 6. `leave_types` — configurable leave categories

Seeded: Casual Leave (12 days), Sick Leave (8 days, requires document — not yet
enforced in the UI), Earned Leave (15 days).

## 7. `leave_requests`

```sql
CREATE TABLE leave_requests (
    id               SERIAL       PRIMARY KEY,
    employee_id      VARCHAR(50)  NOT NULL REFERENCES employees(employee_id) ON DELETE CASCADE,
    leave_type_id    INTEGER      NOT NULL REFERENCES leave_types(id),
    from_date        DATE         NOT NULL,
    to_date          DATE         NOT NULL,
    number_of_days   NUMERIC(4,1) NOT NULL,
    reason           TEXT         NOT NULL,
    attachment_path  VARCHAR(255),
    status           VARCHAR(20)  NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','approved','rejected','cancelled')),
    submitted_at     TIMESTAMPTZ  DEFAULT NOW(),
    approved_by      VARCHAR(50)  REFERENCES employees(employee_id),
    approved_at      TIMESTAMPTZ,
    rejection_reason TEXT,
    created_at       TIMESTAMPTZ  DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  DEFAULT NOW(),
    CHECK (to_date >= from_date)
);
```

No separate `leave_balances` table — remaining balance is computed live (quota minus
approved days this calendar year) to avoid a stored counter drifting out of sync.
`attachment_path` exists but has no upload endpoint/UI wired to it yet.

## 8. `role_permissions` — the module/action permission matrix

```sql
CREATE TABLE role_permissions (
    id SERIAL PRIMARY KEY, role VARCHAR(20) NOT NULL, module VARCHAR(50) NOT NULL,
    can_view BOOLEAN DEFAULT false, can_create BOOLEAN DEFAULT false,
    can_edit BOOLEAN DEFAULT false, can_delete BOOLEAN DEFAULT false,
    can_approve BOOLEAN DEFAULT false, can_reject BOOLEAN DEFAULT false,
    can_export BOOLEAN DEFAULT false, UNIQUE (role, module)
);
```

Now has a real admin UI (Roles & Permissions sidebar view) — checkboxes call
`PUT /admin/permissions/:role/:module` directly; verified live that toggling a
permission takes effect on the very next API request. Admin's own row is protected
from edits through that endpoint.

Seeded for 4 roles × 4 modules = 16 rows. Field-level permissions (Salary/Bank/PAN/
Aadhaar) are not implemented — those columns don't exist in `employees`.

## 9. `audit_logs`

Now has a real admin UI (Audit Logs sidebar view). Written from employee/role/
permission/leave changes and password-reset events; verified no password or token
fields ever land in `old_value`/`new_value`.

## Useful queries

**Everyone's role and manager:**
```sql
SELECT e.employee_id, e.name, e.role, e.email, m.name AS manager_name
FROM employees e LEFT JOIN employees m ON m.employee_id = e.manager_id
ORDER BY e.role, e.name;
```

**Pending leave requests:**
```sql
SELECT l.id, e.name, t.name AS leave_type, l.from_date, l.to_date, l.reason
FROM leave_requests l
JOIN employees e ON e.employee_id = l.employee_id
JOIN leave_types t ON t.id = l.leave_type_id
WHERE l.status = 'pending' ORDER BY l.submitted_at ASC;
```

**View or edit the permission matrix directly:**
```sql
SELECT * FROM role_permissions ORDER BY role, module;
UPDATE role_permissions SET can_approve = true WHERE role='hr' AND module='leaves';
```

**Clean up expired tokens** (recommended periodic job — nothing purges these automatically):
```sql
DELETE FROM password_reset_tokens WHERE used = true OR expires_at < NOW() - INTERVAL '1 day';
DELETE FROM otp_tokens WHERE used = true OR expires_at < NOW() - INTERVAL '1 day';
```
