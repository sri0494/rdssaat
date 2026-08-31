// audit.js — audit log helper (flat structure)
// Never pass passwords, tokens, or OTP/reset secrets into oldValue/newValue —
// callers are responsible for that; this module just persists what it's given.
const db = require('./db');

async function logAction({ employeeId, action, module, recordId, oldValue, newValue }) {
  try {
    await db.query(`
      INSERT INTO audit_logs (employee_id, action, module, record_id, old_value, new_value)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [
      employeeId || null,
      action,
      module,
      recordId ? String(recordId) : null,
      oldValue ? JSON.stringify(oldValue) : null,
      newValue ? JSON.stringify(newValue) : null,
    ]);
  } catch (e) {
    // Auditing must never break the primary action it's logging.
    console.error('Audit log write failed:', e.message);
  }
}

module.exports = { logAction };
