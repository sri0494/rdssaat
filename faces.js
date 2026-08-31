// faces.js — Face routes (flat structure)
const router = require('express').Router();
const db     = require('./db');
const { authenticate, adminOnly, authorize } = require('./authmw');

router.use(authenticate);

// HR does the physical enrollment day-to-day; admin can too. Managers are
// read-only (they view reports, they don't onboard staff).
const ENROLLERS = authorize('admin', 'hr');

router.post('/enroll', ENROLLERS, async (req, res) => {
  try {
    const { employeeId, descriptor } = req.body;
    if (!employeeId || !Array.isArray(descriptor) || descriptor.length !== 128)
      return res.status(400).json({ success:false, message:'employeeId + 128-float descriptor required' });

    await db.query(`
      INSERT INTO face_descriptors (employee_id, descriptor)
      VALUES ($1, $2::jsonb)
      ON CONFLICT (employee_id)
      DO UPDATE SET descriptor=$2::jsonb, updated_at=NOW()
    `, [employeeId, JSON.stringify(descriptor)]);

    res.json({ success:true, message:'Face enrolled successfully' });
  } catch (e) { console.error('POST /faces/enroll failed:', e); res.status(500).json({ success:false, message:'Could not save face enrollment' }); }
});

router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT f.employee_id, f.descriptor, e.name
      FROM face_descriptors f
      JOIN employees e ON e.employee_id=f.employee_id
    `);
    res.json({
      success: true,
      data: rows.map(r => ({
        employeeId:  r.employee_id,
        name:        r.name,
        descriptor:  typeof r.descriptor==='string' ? JSON.parse(r.descriptor) : r.descriptor,
      }))
    });
  } catch (e) { console.error('GET /faces failed:', e); res.status(500).json({ success:false, message:'Could not load face data' }); }
});

router.delete('/:id', ENROLLERS, async (req, res) => {
  try {
    await db.query(`DELETE FROM face_descriptors WHERE employee_id=$1`, [req.params.id]);
    res.json({ success:true, message:'Face descriptor removed' });
  } catch (e) { console.error('DELETE /faces failed:', e); res.status(500).json({ success:false, message:'Could not remove face descriptor' }); }
});

module.exports = router;
