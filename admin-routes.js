// admin-routes.js — role/module permission matrix + audit log viewing (flat structure)
const router = require('express').Router();
const db     = require('./db');
const { authenticate, adminOnly } = require('./authmw');
const { logAction } = require('./audit');

router.use(authenticate);

// GET /api/admin/permissions — the full role x module x action matrix.
router.get('/permissions', adminOnly, async (req, res) => {
  try {
    const { rows } = await db.query(`SELECT * FROM role_permissions ORDER BY role, module`);
    res.json({ success:true, data: rows });
  } catch (e) {
    console.error('GET /admin/permissions failed:', e);
    res.status(500).json({ success:false, message:'Could not load permissions' });
  }
});

// PUT /api/admin/permissions/:role/:module — update one row of the matrix.
// Admin's own role permissions can't be edited here — protects against an
// admin accidentally (or maliciously, if compromised) locking out all admins.
const COLS = ['can_view','can_create','can_edit','can_delete','can_approve','can_reject','can_export'];
router.put('/permissions/:role/:module', adminOnly, async (req, res) => {
  try {
    const { role, module } = req.params;
    if (role === 'admin')
      return res.status(400).json({ success:false, message:'Admin permissions are fixed and cannot be edited' });

    const before = await db.query(`SELECT * FROM role_permissions WHERE role=$1 AND module=$2`, [role, module]);
    if (!before.rows.length) return res.status(404).json({ success:false, message:'No such role/module permission row' });

    const setClauses = [];
    const params = [];
    for (const col of COLS) {
      if (typeof req.body[col] === 'boolean') {
        params.push(req.body[col]);
        setClauses.push(`${col}=$${params.length}`);
      }
    }
    if (!setClauses.length) return res.status(400).json({ success:false, message:'No valid permission fields provided' });

    params.push(role, module);
    await db.query(
      `UPDATE role_permissions SET ${setClauses.join(',')} WHERE role=$${params.length-1} AND module=$${params.length}`,
      params
    );
    await logAction({ employeeId: req.user.employeeId, action:'permissions_updated', module:'permissions', recordId:`${role}:${module}`, oldValue: before.rows[0], newValue: req.body });

    res.json({ success:true, message:'Permissions updated' });
  } catch (e) {
    console.error('PUT /admin/permissions failed:', e);
    res.status(500).json({ success:false, message:'Could not update permissions' });
  }
});

// GET /api/admin/audit-logs?limit=&module=&employeeId=
router.get('/audit-logs', adminOnly, async (req, res) => {
  try {
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit < 1) limit = 100;
    if (limit > 500) limit = 500;

    const conds = [], params = [];
    if (req.query.module)     { params.push(req.query.module);     conds.push(`module=$${params.length}`); }
    if (req.query.employeeId) { params.push(req.query.employeeId); conds.push(`employee_id=$${params.length}`); }
    const where = conds.length ? 'WHERE '+conds.join(' AND ') : '';

    params.push(limit);
    const { rows } = await db.query(
      `SELECT a.*, e.name AS employee_name FROM audit_logs a
       LEFT JOIN employees e ON e.employee_id=a.employee_id
       ${where} ORDER BY a.created_at DESC LIMIT $${params.length}`,
      params
    );
    res.json({ success:true, data: rows });
  } catch (e) {
    console.error('GET /admin/audit-logs failed:', e);
    res.status(500).json({ success:false, message:'Could not load audit logs' });
  }
});

module.exports = router;
