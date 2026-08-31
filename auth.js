// auth.js — Auth routes (flat structure)
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const db     = require('./db');
const { authenticate } = require('./authmw');
const { sendPasswordResetEmail } = require('./mailer');
const { logAction } = require('./audit');
const { passwordPolicyError } = require('./password-policy');

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { employeeId, password } = req.body;
    if (!employeeId || !password)
      return res.status(400).json({ success: false, message: 'Employee ID and password required' });

    const { rows } = await db.query(
      `SELECT * FROM employees WHERE employee_id=$1 AND is_active=true`, [employeeId]
    );
    if (!rows.length)
      return res.status(401).json({ success: false, message: 'Invalid Employee ID or password' });

    const user  = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid)
      return res.status(401).json({ success: false, message: 'Invalid Employee ID or password' });

    const token = jwt.sign(
      { employeeId: user.employee_id, role: user.role, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    const face = await db.query(
      `SELECT employee_id FROM face_descriptors WHERE employee_id=$1`, [user.employee_id]
    );

    res.json({
      success: true, token,
      user: {
        employeeId:   user.employee_id,
        name:         user.name,
        mobile:       user.mobile,
        email:        user.email,
        role:         user.role,
        designation:  user.designation,
        district:     user.district,
        managerId:    user.manager_id,
        faceEnrolled: face.rows.length > 0,
      }
    });
  } catch (e) {
    console.error('POST /auth/login failed:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// Password reset — EMAIL LINK ONLY. The previous OTP-based flow
// (/otp/send, /otp/verify + SMS OTP) has been removed from password
// recovery entirely, per spec. otp.js/otp_tokens are left in place
// untouched in case anything else in the system ever needs OTP — they're
// just no longer wired into this flow.
// ═══════════════════════════════════════════════════════════════════

// POST /api/auth/forgot-password  { email }
// Always returns the same generic message whether or not the email exists,
// so this endpoint can't be used to enumerate registered accounts.
router.post('/forgot-password', async (req, res) => {
  const GENERIC = { success: true, message: 'If an account exists for this email address, a password reset link has been sent.' };
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required' });

    const { rows } = await db.query(
      `SELECT employee_id, email FROM employees WHERE LOWER(email)=LOWER($1) AND is_active=true`,
      [email]
    );
    if (!rows.length) return res.json(GENERIC); // don't reveal non-existence

    const user = rows[0];
    const rawToken  = crypto.randomBytes(32).toString('hex');
    const tokenHash = await bcrypt.hash(rawToken, 10);
    const minutes   = Number(process.env.PASSWORD_RESET_EXPIRY_MINUTES) || 30;

    // Invalidate any earlier outstanding tokens for this account first.
    await db.query(`UPDATE password_reset_tokens SET used=true WHERE employee_id=$1 AND used=false`, [user.employee_id]);
    await db.query(
      `INSERT INTO password_reset_tokens (employee_id, token_hash, expires_at) VALUES ($1,$2, NOW() + INTERVAL '${minutes} minutes')`,
      [user.employee_id, tokenHash]
    );

    // Use the configured production URL — never hard-code a domain.
    const baseUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const resetLink = `${baseUrl}/reset-password?token=${rawToken}&id=${encodeURIComponent(user.employee_id)}`;

    await sendPasswordResetEmail(user.email, resetLink);
    await logAction({ employeeId: user.employee_id, action: 'password_reset_requested', module: 'auth', recordId: user.employee_id });

    res.json(GENERIC);
  } catch (e) {
    console.error('POST /auth/forgot-password failed:', e);
    // Still return the generic message — don't leak internal errors on an
    // unauthenticated endpoint that already avoids revealing account existence.
    res.json(GENERIC);
  }
});

// POST /api/auth/reset-password  { employeeId, token, newPassword }
// employeeId comes from the emailed link (?id=...) so we don't have to scan
// every outstanding token hash — token itself is still what's verified.
router.post('/reset-password', async (req, res) => {
  try {
    const { employeeId, token, newPassword } = req.body;
    if (!employeeId || !token || !newPassword)
      return res.status(400).json({ success: false, message: 'employeeId, token and newPassword are required' });

    const policyError = passwordPolicyError(newPassword);
    if (policyError) return res.status(400).json({ success: false, message: policyError });

    const { rows } = await db.query(
      `SELECT * FROM password_reset_tokens
       WHERE employee_id=$1 AND used=false AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [employeeId]
    );
    if (!rows.length)
      return res.status(400).json({ success: false, message: 'This reset link is invalid or has expired' });

    const match = await bcrypt.compare(token, rows[0].token_hash);
    if (!match)
      return res.status(400).json({ success: false, message: 'This reset link is invalid or has expired' });

    const hash = await bcrypt.hash(newPassword, 12);
    await db.query(`UPDATE employees SET password_hash=$1 WHERE employee_id=$2`, [hash, employeeId]);
    // Single-use: invalidate immediately after successful use.
    await db.query(`UPDATE password_reset_tokens SET used=true WHERE id=$1`, [rows[0].id]);

    await logAction({ employeeId, action: 'password_reset_completed', module: 'auth', recordId: employeeId });

    res.json({ success: true, message: 'Password successfully changed' });
  } catch (e) {
    console.error('POST /auth/reset-password failed:', e);
    res.status(500).json({ success: false, message: 'Password reset failed' });
  }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT employee_id, name, mobile, email, role, designation, district, manager_id
       FROM employees WHERE employee_id=$1`,
      [req.user.employeeId]
    );
    if (!rows.length)
      return res.status(404).json({ success: false, message: 'User not found' });

    // Include this role's module/action permission matrix so the frontend
    // can hide buttons the backend would reject anyway — convenience only,
    // the backend re-checks on every request regardless (see authmw.js).
    const perms = await db.query(
      `SELECT module, can_view, can_create, can_edit, can_delete, can_approve, can_reject, can_export
       FROM role_permissions WHERE role=$1`,
      [req.user.role]
    );

    res.json({ success: true, user: rows[0], permissions: perms.rows });
  } catch (e) {
    console.error('GET /auth/me failed:', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
