// passwordReset.js — forgot-password / reset-password by emailed link (flat structure)
//
// Mount:  app.use('/api/auth', createPasswordResetRouter(pool));
//   POST /api/auth/forgot-password  { email }
//   POST /api/auth/reset-password   { employeeId, token, newPassword }
//
// Tokens: 32 random bytes, only the SHA-256 is stored (password_reset_tokens.token_hash),
// single-use, 30-minute expiry. The reset link is built from APP_URL (never from the
// request's Host header, which an attacker can spoof to poison reset links).
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { sendPasswordResetEmail } = require('./mailer');

const RESET_TTL_MIN = 30;
const COOLDOWN_SEC = 60; // at most one reset email per account per minute
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Same rule the UI states: 8+ chars, upper, lower, digit, special
const PASSWORD_RE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;
const PASSWORD_MSG = 'Password must be at least 8 characters with an uppercase letter, lowercase letter, number and special character';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
function safeEqual(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function baseUrl() {
  // APP_URL e.g. https://rd-ssaat.onrender.com — Render also provides RENDER_EXTERNAL_URL automatically
  const u = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
  return u.replace(/\/+$/, '');
}

function buildResetLink(employeeId, token) {
  return `${baseUrl()}/reset-password?token=${encodeURIComponent(token)}&id=${encodeURIComponent(employeeId)}`;
}

// Creates a token row (using any pg client/pool) and returns the raw token.
// Older unused tokens for the same employee are invalidated.
async function issueResetToken(db, employeeId, ttlMinutes = RESET_TTL_MIN) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.query('UPDATE password_reset_tokens SET used = true WHERE employee_id = $1 AND used = false', [employeeId]);
  await db.query(
    `INSERT INTO password_reset_tokens (employee_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + make_interval(mins => $3::int))`,
    [employeeId, sha256(token), ttlMinutes]
  );
  return token;
}

function createPasswordResetRouter(pool) {
  const router = express.Router();

  router.post('/forgot-password', async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ success: false, message: 'Enter a valid email address' });

    // Same response whether or not the email exists, sent before any work is done,
    // so neither the body nor the timing reveals which emails are registered.
    res.json({ success: true, message: 'If an account exists for that email address, a password reset link has been sent.' });

    try {
      const { rows } = await pool.query(
        'SELECT employee_id, email FROM employees WHERE LOWER(email) = $1 AND is_active = true', [email]);
      if (!rows.length) return;
      const emp = rows[0];

      const recent = await pool.query(
        `SELECT 1 FROM password_reset_tokens
          WHERE employee_id = $1 AND created_at > NOW() - make_interval(secs => $2::int) LIMIT 1`,
        [emp.employee_id, COOLDOWN_SEC]);
      if (recent.rowCount) return;

      const token = await issueResetToken(pool, emp.employee_id);
      await sendPasswordResetEmail(emp.email, buildResetLink(emp.employee_id, token), RESET_TTL_MIN);
    } catch (err) {
      console.error('forgot-password failed:', err.message);
    }
  });

  router.post('/reset-password', async (req, res) => {
    const { employeeId, token, newPassword } = req.body || {};
    if (!employeeId || !token || !newPassword)
      return res.status(400).json({ success: false, message: 'Missing reset details' });
    if (!PASSWORD_RE.test(String(newPassword)))
      return res.status(400).json({ success: false, message: PASSWORD_MSG });

    const invalid = { success: false, message: 'This reset link is invalid or has expired. Please request a new one.' };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT id, token_hash FROM password_reset_tokens
          WHERE employee_id = $1 AND used = false AND expires_at > NOW() FOR UPDATE`,
        [String(employeeId)]);
      const h = sha256(String(token));
      if (!rows.some((r) => safeEqual(r.token_hash, h))) { await client.query('ROLLBACK'); return res.status(400).json(invalid); }

      const hash = await bcrypt.hash(String(newPassword), 12);
      const upd = await client.query(
        'UPDATE employees SET password_hash = $1, updated_at = NOW() WHERE employee_id = $2 AND is_active = true',
        [hash, String(employeeId)]);
      if (!upd.rowCount) { await client.query('ROLLBACK'); return res.status(400).json(invalid); }

      await client.query('UPDATE password_reset_tokens SET used = true WHERE employee_id = $1 AND used = false', [String(employeeId)]);
      await client.query(
        `INSERT INTO audit_logs (employee_id, action, module, record_id) VALUES ($1, 'password_reset_via_email', 'users', $1)`,
        [String(employeeId)]);
      await client.query('COMMIT');
      res.json({ success: true, message: 'Password successfully changed' });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('reset-password failed:', err.message);
      res.status(500).json({ success: false, message: 'Could not reset password. Please try again.' });
    } finally {
      client.release();
    }
  });

  return router;
}

module.exports = { createPasswordResetRouter, issueResetToken, buildResetLink, PASSWORD_RE, PASSWORD_MSG, EMAIL_RE };
