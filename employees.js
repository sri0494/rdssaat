// employees.js — Employee & staff routes (flat structure)
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db     = require('./db');
const { authenticate, adminOnly, authorize, ROLES, canAssignRole, requirePermission } = require('./authmw');
const { passwordPolicyError } = require('./password-policy');
const { logAction } = require('./audit');

router.use(authenticate);

// Roles that may VIEW the staff list (read-only for manager/hr, full for admin).
const VIEWERS = authorize('admin', 'manager', 'hr');
// Roles that may create/edit plain employee records day-to-day.
const STAFF_MANAGERS = authorize('admin', 'hr');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// GET /api/employees?role=employee|manager|hr|admin
// - admin: sees everyone (optionally filtered by ?role=)
// - hr:    sees plain employees only, regardless of ?role=
// - manager: sees ONLY their own team (employees where manager_id = self) —
//   this is the "My Team" scoping from the spec, enforced server-side, not
//   just a frontend filter.
router.get('/', VIEWERS, async (req, res) => {
  try {
    const roleFilter = ROLES.includes(req.query.role) ? req.query.role : null;
    const conds = [];
    const params = [];

    if (req.user.role === 'manager') {
      params.push(req.user.employeeId);
      conds.push(`e.manager_id=$${params.length}`);
    } else if (req.user.role !== 'admin') {
      // hr
      conds.push(`e.role='employee'`);
    } else if (roleFilter) {
      params.push(roleFilter);
      conds.push(`e.role=$${params.length}`);
    }

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const { rows } = await db.query(`
      SELECT e.employee_id,e.name,e.mobile,e.email,e.role,e.designation,e.district,
             e.manager_id,e.is_active,e.created_at,
             CASE WHEN f.employee_id IS NOT NULL THEN true ELSE false END AS face_enrolled
      FROM employees e
      LEFT JOIN face_descriptors f ON f.employee_id=e.employee_id
      ${where}
      ORDER BY e.created_at DESC
    `, params);
    res.json({ success:true, data:rows });
  } catch (e) {
    console.error('GET /employees failed:', e);
    res.status(500).json({ success:false, message:'Could not load employees' });
  }
});

// GET /api/employees/:id — single profile. Self, admin, hr, or that
// employee's own manager may view it; anyone else is blocked.
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT employee_id,name,mobile,email,role,designation,district,manager_id,is_active,created_at
       FROM employees WHERE employee_id=$1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success:false, message:'Not found' });
    const target = rows[0];

    const isSelf    = req.user.employeeId === target.employee_id;
    const isAdminHr = ['admin','hr'].includes(req.user.role);
    const isTheirManager = req.user.role === 'manager' && target.manager_id === req.user.employeeId;
    if (!isSelf && !isAdminHr && !isTheirManager)
      return res.status(403).json({ success:false, message:'You do not have access to this profile' });

    res.json({ success:true, data:target });
  } catch (e) {
    console.error('GET /employees/:id failed:', e);
    res.status(500).json({ success:false, message:'Could not load profile' });
  }
});

// POST /api/employees — create staff. `role` defaults to 'employee'.
// Only admin can create admin/manager/hr accounts; hr can only create plain employees.
// Email is mandatory (used for password-reset links).
router.post('/', STAFF_MANAGERS, async (req, res) => {
  try {
    const { employeeId, name, mobile, email, password, designation, district, managerId } = req.body;
    const role = req.body.role || 'employee';

    if (!employeeId||!name||!mobile||!email||!password)
      return res.status(400).json({ success:false, message:'employeeId, name, mobile, email, password required' });
    if (!/^\d{10}$/.test(mobile))
      return res.status(400).json({ success:false, message:'Invalid mobile number' });
    if (!EMAIL_RE.test(email))
      return res.status(400).json({ success:false, message:'Invalid email address' });
    const pwError = passwordPolicyError(password);
    if (pwError) return res.status(400).json({ success:false, message: pwError });
    if (!ROLES.includes(role))
      return res.status(400).json({ success:false, message:`Role must be one of: ${ROLES.join(', ')}` });
    if (!canAssignRole(req.user.role, role))
      return res.status(403).json({ success:false, message:`You are not allowed to create a "${role}" account` });

    if (managerId) {
      const mgr = await db.query(`SELECT role FROM employees WHERE employee_id=$1`, [managerId]);
      if (!mgr.rows.length || mgr.rows[0].role !== 'manager')
        return res.status(400).json({ success:false, message:'managerId must reference an existing manager account' });
    }

    const hash = await bcrypt.hash(password, 12);
    await db.query(`
      INSERT INTO employees (employee_id,name,mobile,email,password_hash,role,designation,district,manager_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [employeeId, name, mobile, email, hash, role, designation||'', district||'', managerId||null]);

    await logAction({ employeeId: req.user.employeeId, action:'employee_created', module:'employees', recordId:employeeId, newValue:{ name, email, role, designation, district, managerId } });

    res.status(201).json({ success:true, message:`${role[0].toUpperCase()}${role.slice(1)} added successfully` });
  } catch (e) {
    if (e.code==='23505') {
      const field = /email/i.test(e.constraint || '') ? 'Email address' : 'Employee ID or mobile';
      return res.status(409).json({ success:false, message:`${field} already exists` });
    }
    console.error('POST /employees failed:', e);
    res.status(500).json({ success:false, message:'Could not create the account' });
  }
});

// PUT /api/employees/:id — edit staff, optionally changing role/manager/email.
router.put('/:id', STAFF_MANAGERS, async (req, res) => {
  try {
    const { name, mobile, email, designation, district, password, managerId } = req.body;
    if (!name||!mobile)
      return res.status(400).json({ success:false, message:'Name and mobile required' });
    if (!/^\d{10}$/.test(mobile))
      return res.status(400).json({ success:false, message:'Invalid mobile' });
    if (email && !EMAIL_RE.test(email))
      return res.status(400).json({ success:false, message:'Invalid email address' });

    const before = await db.query(`SELECT name,email,role,designation,district,manager_id FROM employees WHERE employee_id=$1`, [req.params.id]);
    if (!before.rows.length) return res.status(404).json({ success:false, message:'Not found' });

    const params = [name, mobile];
    let setClause = 'name=$1,mobile=$2';

    if (email) { params.push(email); setClause += `,email=$${params.length}`; }
    if (designation !== undefined) { params.push(designation); setClause += `,designation=$${params.length}`; }
    if (district !== undefined) { params.push(district); setClause += `,district=$${params.length}`; }
    if (managerId !== undefined) { params.push(managerId || null); setClause += `,manager_id=$${params.length}`; }

    // Role changes are optional on edit, and gated the same way as creation.
    if (req.body.role) {
      const role = req.body.role;
      if (!ROLES.includes(role))
        return res.status(400).json({ success:false, message:`Role must be one of: ${ROLES.join(', ')}` });
      if (!canAssignRole(req.user.role, role))
        return res.status(403).json({ success:false, message:`You are not allowed to set the "${role}" role` });
      params.push(role);
      setClause += `,role=$${params.length}`;
    }

    if (password) {
      const pwError = passwordPolicyError(password);
      if (pwError) return res.status(400).json({ success:false, message: pwError });
      const hash = await bcrypt.hash(password, 12);
      params.push(hash);
      setClause += `,password_hash=$${params.length}`;
    }

    params.push(req.params.id);
    await db.query(`UPDATE employees SET ${setClause} WHERE employee_id=$${params.length}`, params);

    await logAction({
      employeeId: req.user.employeeId, action:'employee_updated', module:'employees', recordId:req.params.id,
      oldValue: before.rows[0],
      newValue: { name, email, designation, district, managerId, role: req.body.role },
    });
    if (req.body.role && req.body.role !== before.rows[0].role) {
      await logAction({ employeeId: req.user.employeeId, action:'role_changed', module:'roles', recordId:req.params.id, oldValue:{role:before.rows[0].role}, newValue:{role:req.body.role} });
    }

    res.json({ success:true, message:'Employee updated' });
  } catch (e) {
    if (e.code==='23505') {
      const field = /email/i.test(e.constraint || '') ? 'Email address' : 'Mobile';
      return res.status(409).json({ success:false, message:`${field} already in use` });
    }
    console.error('PUT /employees failed:', e);
    res.status(500).json({ success:false, message:'Could not update the account' });
  }
});

// DELETE /api/employees/:id — gated by the DB-driven role_permissions matrix
// (module='employees', action='delete') rather than a hardcoded role check,
// so the permission is genuinely admin-configurable, not frontend-only.
// Admin accounts can never be deleted through this route regardless of who
// technically has delete permission — that's a separate hard business rule.
router.delete('/:id', requirePermission('employees', 'delete'), async (req, res) => {
  try {
    const before = await db.query(`SELECT name,role FROM employees WHERE employee_id=$1`, [req.params.id]);
    const { rowCount } = await db.query(
      `DELETE FROM employees WHERE employee_id=$1 AND role<>'admin'`, [req.params.id]
    );
    if (!rowCount) return res.status(404).json({ success:false, message:'Account not found (or is an admin account)' });

    await logAction({ employeeId: req.user.employeeId, action:'employee_deleted', module:'employees', recordId:req.params.id, oldValue: before.rows[0] });
    res.json({ success:true, message:'Account deleted' });
  } catch (e) {
    console.error('DELETE /employees failed:', e);
    res.status(500).json({ success:false, message:'Could not delete the account' });
  }
});

router.patch('/:id/change-password', async (req, res) => {
  try {
    if (req.user.employeeId!==req.params.id && req.user.role!=='admin')
      return res.status(403).json({ success:false, message:'Forbidden' });

    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
      return res.status(400).json({ success:false, message:'Both current and new password are required' });
    const pwError = passwordPolicyError(newPassword);
    if (pwError) return res.status(400).json({ success:false, message: pwError });

    const { rows } = await db.query(
      `SELECT password_hash FROM employees WHERE employee_id=$1`, [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success:false, message:'Not found' });
    if (!await bcrypt.compare(currentPassword, rows[0].password_hash))
      return res.status(401).json({ success:false, message:'Current password incorrect' });

    const hash = await bcrypt.hash(newPassword, 12);
    await db.query(`UPDATE employees SET password_hash=$1 WHERE employee_id=$2`, [hash, req.params.id]);
    await logAction({ employeeId: req.user.employeeId, action:'password_changed', module:'auth', recordId:req.params.id });
    res.json({ success:true, message:'Your password has been changed successfully' });
  } catch (e) {
    console.error('PATCH /change-password failed:', e);
    res.status(500).json({ success:false, message:'Could not change the password' });
  }
});

module.exports = router;
