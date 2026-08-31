// attendance.js — Attendance routes (flat structure)
const router = require('express').Router();
const db     = require('./db');
const { authenticate, adminOnly, authorize } = require('./authmw');

router.use(authenticate);

// Manager and HR get read access to reports/exports/stats; only admin can be
// implied by "adminOnly" alone. Kept as its own const so it's easy to widen/narrow.
const REPORT_VIEWERS = authorize('admin', 'manager', 'hr');

router.post('/', async (req, res) => {
  try {
    const { village,mandal,auditType,designation,notes,gps,faceVerified,faceScore,displayTime } = req.body;
    if (!village||!mandal||!auditType)
      return res.status(400).json({ success:false, message:'village, mandal, auditType required' });

    const emp = await db.query(
      `SELECT district,designation FROM employees WHERE employee_id=$1`, [req.user.employeeId]
    );

    await db.query(`
      INSERT INTO attendance
        (employee_id,employee_name,designation,district,
         village,mandal,audit_type,notes,
         gps_lat,gps_lng,gps_accuracy,
         face_verified,face_score,display_time)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    `, [
      req.user.employeeId, req.user.name,
      designation || emp.rows[0]?.designation || '',
      emp.rows[0]?.district || '',
      village, mandal, auditType, notes || '',
      gps?.lat||null, gps?.lng||null, gps?.accuracy||null,
      faceVerified !== false,
      faceScore||null,
      displayTime || new Date().toLocaleString('en-IN',{timeZone:'Asia/Kolkata'}),
    ]);

    res.status(201).json({ success:true, message:'Attendance marked successfully' });
  } catch (e) { console.error('POST /attendance failed:', e); res.status(500).json({ success:false, message:'Could not save attendance' }); }
});

router.get('/stats', REPORT_VIEWERS, async (req, res) => {
  try {
    const [totalEmp, todayAtt, totalAtt, enrolled] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM employees WHERE role='employee'`),
      db.query(`SELECT COUNT(*) FROM attendance WHERE created_at::date = CURRENT_DATE`),
      db.query(`SELECT COUNT(*) FROM attendance`),
      db.query(`SELECT COUNT(*) FROM face_descriptors`),
    ]);
    res.json({
      success: true,
      stats: {
        totalEmployees:  Number(totalEmp.rows[0].count),
        todayAttendance: Number(todayAtt.rows[0].count),
        totalAttendance: Number(totalAtt.rows[0].count),
        faceEnrolled:    Number(enrolled.rows[0].count),
      }
    });
  } catch (e) { console.error('GET /attendance/stats failed:', e); res.status(500).json({ success:false, message:'Could not load stats' }); }
});

router.get('/my', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT id,village,mandal,audit_type,designation,notes,
             gps_lat,gps_lng,gps_accuracy,
             face_verified,face_score,display_time,created_at
      FROM attendance WHERE employee_id=$1
      ORDER BY created_at DESC LIMIT 10
    `, [req.user.employeeId]);
    res.json({ success:true, data:rows });
  } catch (e) { console.error('GET /attendance/my failed:', e); res.status(500).json({ success:false, message:'Could not load your attendance history' }); }
});

router.get('/', REPORT_VIEWERS, async (req, res) => {
  try {
    const { from,to,district,employeeId } = req.query;

    // Sanitize pagination input — raw query params were passed straight into
    // Number()/arithmetic before, so ?page=abc or ?limit=xyz produced NaN and
    // a raw Postgres error ("invalid input syntax for type bigint: NaN") leaked
    // straight to the client. Clamp to sane bounds instead.
    let page  = parseInt(req.query.page, 10);
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(page)  || page  < 1)   page  = 1;
    if (!Number.isFinite(limit) || limit < 1)   limit = 50;
    if (limit > 200) limit = 200; // avoid someone requesting the whole table in one page
    const offset = (page - 1) * limit;

    const conds=[], params=[];
    let pIdx=1;

    if (from)       { conds.push(`a.created_at >= $${pIdx++}`); params.push(from+' 00:00:00'); }
    if (to)         { conds.push(`a.created_at <= $${pIdx++}`); params.push(to+' 23:59:59'); }
    if (district)   { conds.push(`a.district = $${pIdx++}`);    params.push(district); }
    if (employeeId) { conds.push(`a.employee_id = $${pIdx++}`); params.push(employeeId); }

    const where = conds.length ? 'WHERE '+conds.join(' AND ') : '';
    const { rows } = await db.query(`
      SELECT a.*,e.mobile FROM attendance a
      JOIN employees e ON e.employee_id=a.employee_id
      ${where} ORDER BY a.created_at DESC
      LIMIT $${pIdx++} OFFSET $${pIdx}
    `, [...params, limit, offset]);

    const total = await db.query(
      `SELECT COUNT(*) FROM attendance a ${where}`, params
    );
    res.json({ success:true, data:rows, total:Number(total.rows[0].count), page, limit });
  } catch (e) {
    console.error('GET /attendance failed:', e);
    res.status(500).json({ success:false, message:'Could not load attendance records' });
  }
});

router.get('/export', REPORT_VIEWERS, async (req, res) => {
  try {
    const { from,to } = req.query;
    const conds=[], params=[];
    if (from) { conds.push(`a.created_at >= $1`); params.push(from+' 00:00:00'); }
    if (to)   { conds.push(`a.created_at <= $${params.length+1}`); params.push(to+' 23:59:59'); }

    const { rows } = await db.query(`
      SELECT a.employee_id,a.employee_name,e.mobile,a.designation,
             a.district,a.village,a.mandal,a.audit_type,
             a.gps_lat,a.gps_lng,a.gps_accuracy,
             a.face_verified,a.face_score,a.notes,a.display_time
      FROM attendance a
      JOIN employees e ON e.employee_id=a.employee_id
      ${conds.length?'WHERE '+conds.join(' AND '):''}
      ORDER BY a.created_at DESC
    `, params);

    const headers = ['Employee ID','Name','Mobile','Designation','District',
      'Village','Mandal','Audit Type','GPS Lat','GPS Lng','Accuracy(m)',
      'Face Verified','Match %','Notes','Date Time'];
    const csv = [
      headers.join(','),
      ...rows.map(r => [
        r.employee_id,r.employee_name,r.mobile,r.designation,
        r.district,r.village,r.mandal,r.audit_type,
        r.gps_lat||'',r.gps_lng||'',r.gps_accuracy||'',
        r.face_verified?'Yes':'No',r.face_score||'',
        `"${(r.notes||'').replace(/"/g,'""')}"`,r.display_time
      ].join(','))
    ].join('\n');

    res.setHeader('Content-Type','text/csv');
    res.setHeader('Content-Disposition',`attachment; filename="attendance_${Date.now()}.csv"`);
    res.send(csv);
  } catch (e) { console.error('GET /attendance/export failed:', e); res.status(500).json({ success:false, message:'Could not export CSV' }); }
});

module.exports = router;
