// leaves.js — Leave management routes (flat structure)
const router = require('express').Router();
const db     = require('./db');
const { authenticate, authorize, requirePermission } = require('./authmw');
const { logAction } = require('./audit');

router.use(authenticate);

const REPORT_VIEWERS = authorize('admin', 'hr'); // full-roster leave views
const DECIDERS       = authorize('admin', 'manager'); // who can approve/reject

// GET /api/leaves/types — active leave types, for the "Leave Type" dropdown.
router.get('/types', async (req, res) => {
  try {
    const { rows } = await db.query(`SELECT id, name, annual_quota_days, requires_document FROM leave_types WHERE is_active=true ORDER BY name`);
    res.json({ success:true, data: rows });
  } catch (e) {
    console.error('GET /leaves/types failed:', e);
    res.status(500).json({ success:false, message:'Could not load leave types' });
  }
});

// Compute inclusive calendar days between two dates (no working-day/holiday
// calendar exists in this schema yet — see notes in the QA report).
function daysBetween(from, to) {
  const ms = new Date(to) - new Date(from);
  return Math.floor(ms / 86400000) + 1;
}

// Remaining balance = leave_type's annual quota minus days already
// APPROVED this calendar year for that employee+type. There's no separate
// leave_balances table (per the "don't duplicate existing structures"
// instruction, and because there's no carry-forward/accrual policy defined
// yet) — this computes the balance live instead of maintaining a stored
// counter that could drift out of sync.
async function getRemainingBalance(employeeId, leaveTypeId) {
  const quota = await db.query(`SELECT annual_quota_days FROM leave_types WHERE id=$1`, [leaveTypeId]);
  if (!quota.rows.length) return null;
  const used = await db.query(`
    SELECT COALESCE(SUM(number_of_days),0) AS used
    FROM leave_requests
    WHERE employee_id=$1 AND leave_type_id=$2 AND status='approved'
      AND EXTRACT(YEAR FROM from_date) = EXTRACT(YEAR FROM CURRENT_DATE)
  `, [employeeId, leaveTypeId]);
  return quota.rows[0].annual_quota_days - Number(used.rows[0].used);
}

// GET /api/leaves/balance — the logged-in employee's remaining balance per type.
router.get('/balance', async (req, res) => {
  try {
    const types = await db.query(`SELECT id, name, annual_quota_days FROM leave_types WHERE is_active=true ORDER BY name`);
    const data = [];
    for (const t of types.rows) {
      const remaining = await getRemainingBalance(req.user.employeeId, t.id);
      data.push({ leaveTypeId: t.id, leaveType: t.name, quota: t.annual_quota_days, remaining });
    }
    res.json({ success:true, data });
  } catch (e) {
    console.error('GET /leaves/balance failed:', e);
    res.status(500).json({ success:false, message:'Could not load leave balance' });
  }
});

// POST /api/leaves — apply for leave (any authenticated employee, for themselves).
router.post('/', async (req, res) => {
  try {
    const { leaveTypeId, fromDate, toDate, reason, attachmentPath } = req.body;
    if (!leaveTypeId || !fromDate || !toDate || !reason)
      return res.status(400).json({ success:false, message:'leaveTypeId, fromDate, toDate and reason are required' });

    const from = new Date(fromDate), to = new Date(toDate);
    if (isNaN(from) || isNaN(to))
      return res.status(400).json({ success:false, message:'Invalid date' });
    if (to < from)
      return res.status(400).json({ success:false, message:'To Date cannot be before From Date' });
    if (from < new Date(new Date().toDateString()))
      return res.status(400).json({ success:false, message:'From Date cannot be in the past' });

    const numberOfDays = daysBetween(fromDate, toDate);

    // Overlap check — no two non-rejected/cancelled requests for the same
    // employee may cover overlapping dates.
    const overlap = await db.query(`
      SELECT id FROM leave_requests
      WHERE employee_id=$1 AND status IN ('pending','approved')
        AND from_date <= $3 AND to_date >= $2
    `, [req.user.employeeId, fromDate, toDate]);
    if (overlap.rows.length)
      return res.status(409).json({ success:false, message:'You already have a leave request overlapping these dates' });

    const remaining = await getRemainingBalance(req.user.employeeId, leaveTypeId);
    if (remaining === null)
      return res.status(400).json({ success:false, message:'Invalid leave type' });
    if (numberOfDays > remaining)
      return res.status(400).json({ success:false, message:`Insufficient leave balance — ${remaining} day(s) remaining` });

    const { rows } = await db.query(`
      INSERT INTO leave_requests (employee_id, leave_type_id, from_date, to_date, number_of_days, reason, attachment_path)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
    `, [req.user.employeeId, leaveTypeId, fromDate, toDate, numberOfDays, reason, attachmentPath || null]);

    await logAction({ employeeId: req.user.employeeId, action:'leave_submitted', module:'leaves', recordId: rows[0].id, newValue:{ leaveTypeId, fromDate, toDate, numberOfDays } });

    res.status(201).json({ success:true, message:'Leave request submitted', data:{ id: rows[0].id, numberOfDays } });
  } catch (e) {
    console.error('POST /leaves failed:', e);
    res.status(500).json({ success:false, message:'Could not submit leave request' });
  }
});

// GET /api/leaves/my — the logged-in employee's own requests.
router.get('/my', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT l.*, t.name AS leave_type
      FROM leave_requests l JOIN leave_types t ON t.id=l.leave_type_id
      WHERE l.employee_id=$1
      ORDER BY l.submitted_at DESC
    `, [req.user.employeeId]);
    res.json({ success:true, data: rows });
  } catch (e) {
    console.error('GET /leaves/my failed:', e);
    res.status(500).json({ success:false, message:'Could not load your leave requests' });
  }
});

// GET /api/leaves/team — manager's team requests only (server-side scoped by
// manager_id, not a frontend filter on the full list).
router.get('/team', authorize('admin', 'manager'), async (req, res) => {
  try {
    const { status } = req.query;
    const params = [req.user.employeeId];
    let where = `e.manager_id=$1`;
    if (req.user.role === 'admin') { where = `TRUE`; params.length = 0; } // admin viewing "team" sees all, same as /leaves
    if (status) { params.push(status); where += ` AND l.status=$${params.length}`; }

    const { rows } = await db.query(`
      SELECT l.*, t.name AS leave_type, e.name AS employee_name, e.district
      FROM leave_requests l
      JOIN employees e ON e.employee_id=l.employee_id
      JOIN leave_types t ON t.id=l.leave_type_id
      WHERE ${where}
      ORDER BY l.submitted_at DESC
    `, params);
    res.json({ success:true, data: rows });
  } catch (e) {
    console.error('GET /leaves/team failed:', e);
    res.status(500).json({ success:false, message:'Could not load team leave requests' });
  }
});

// GET /api/leaves — full roster view for admin/hr, with filters.
// (district is used as the "department" filter — see DB_SCHEMA notes: this
// app doesn't have a separate departments table, district is the closest
// existing equivalent, reused rather than duplicated.)
router.get('/', REPORT_VIEWERS, async (req, res) => {
  try {
    const { status, district, managerId, leaveTypeId, employeeId } = req.query;
    const conds = [], params = [];
    if (status)      { params.push(status);      conds.push(`l.status=$${params.length}`); }
    if (district)    { params.push(district);    conds.push(`e.district=$${params.length}`); }
    if (managerId)    { params.push(managerId);    conds.push(`e.manager_id=$${params.length}`); }
    if (leaveTypeId)  { params.push(leaveTypeId);  conds.push(`l.leave_type_id=$${params.length}`); }
    if (employeeId)   { params.push(employeeId);   conds.push(`l.employee_id=$${params.length}`); }
    const where = conds.length ? 'WHERE '+conds.join(' AND ') : '';

    const { rows } = await db.query(`
      SELECT l.*, t.name AS leave_type, e.name AS employee_name, e.district, e.manager_id
      FROM leave_requests l
      JOIN employees e ON e.employee_id=l.employee_id
      JOIN leave_types t ON t.id=l.leave_type_id
      ${where}
      ORDER BY l.submitted_at DESC
    `, params);
    res.json({ success:true, data: rows });
  } catch (e) {
    console.error('GET /leaves failed:', e);
    res.status(500).json({ success:false, message:'Could not load leave requests' });
  }
});

// PATCH /api/leaves/:id/approve
router.patch('/:id/approve', requirePermission('leaves', 'approve'), async (req, res) => {
  try {
    const existing = await db.query(`SELECT l.*, e.manager_id FROM leave_requests l JOIN employees e ON e.employee_id=l.employee_id WHERE l.id=$1`, [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ success:false, message:'Leave request not found' });
    const lr = existing.rows[0];

    if (req.user.role === 'manager' && lr.manager_id !== req.user.employeeId)
      return res.status(403).json({ success:false, message:'You can only approve requests from your own team' });
    if (lr.status !== 'pending')
      return res.status(400).json({ success:false, message:`Request is already ${lr.status}` });

    await db.query(
      `UPDATE leave_requests SET status='approved', approved_by=$1, approved_at=NOW(), updated_at=NOW() WHERE id=$2`,
      [req.user.employeeId, req.params.id]
    );
    await logAction({ employeeId: req.user.employeeId, action:'leave_approved', module:'leaves', recordId:req.params.id, oldValue:{status:'pending'}, newValue:{status:'approved'} });
    res.json({ success:true, message:'Leave request approved' });
  } catch (e) {
    console.error('PATCH /leaves/approve failed:', e);
    res.status(500).json({ success:false, message:'Could not approve leave request' });
  }
});

// PATCH /api/leaves/:id/reject  { reason }
router.patch('/:id/reject', requirePermission('leaves', 'reject'), async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ success:false, message:'Rejection reason is required' });

    const existing = await db.query(`SELECT l.*, e.manager_id FROM leave_requests l JOIN employees e ON e.employee_id=l.employee_id WHERE l.id=$1`, [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ success:false, message:'Leave request not found' });
    const lr = existing.rows[0];

    if (req.user.role === 'manager' && lr.manager_id !== req.user.employeeId)
      return res.status(403).json({ success:false, message:'You can only reject requests from your own team' });
    if (lr.status !== 'pending')
      return res.status(400).json({ success:false, message:`Request is already ${lr.status}` });

    await db.query(
      `UPDATE leave_requests SET status='rejected', approved_by=$1, approved_at=NOW(), rejection_reason=$2, updated_at=NOW() WHERE id=$3`,
      [req.user.employeeId, reason, req.params.id]
    );
    await logAction({ employeeId: req.user.employeeId, action:'leave_rejected', module:'leaves', recordId:req.params.id, oldValue:{status:'pending'}, newValue:{status:'rejected', reason} });
    res.json({ success:true, message:'Leave request rejected' });
  } catch (e) {
    console.error('PATCH /leaves/reject failed:', e);
    res.status(500).json({ success:false, message:'Could not reject leave request' });
  }
});

// PATCH /api/leaves/:id/cancel — the requester can cancel their own still-pending request.
router.patch('/:id/cancel', async (req, res) => {
  try {
    const { rowCount } = await db.query(
      `UPDATE leave_requests SET status='cancelled', updated_at=NOW()
       WHERE id=$1 AND employee_id=$2 AND status='pending'`,
      [req.params.id, req.user.employeeId]
    );
    if (!rowCount) return res.status(400).json({ success:false, message:'Only your own pending requests can be cancelled' });
    await logAction({ employeeId: req.user.employeeId, action:'leave_cancelled', module:'leaves', recordId:req.params.id });
    res.json({ success:true, message:'Leave request cancelled' });
  } catch (e) {
    console.error('PATCH /leaves/cancel failed:', e);
    res.status(500).json({ success:false, message:'Could not cancel leave request' });
  }
});

module.exports = router;
