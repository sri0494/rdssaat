// otp.js — OTP utilities (flat structure, no SMS)
const bcrypt = require('bcryptjs');
const db     = require('./db');

function generateOTP() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function saveOTP(mobile, otp) {
  const hash    = await bcrypt.hash(otp, 8);
  const minutes = Number(process.env.OTP_EXPIRY_MINUTES) || 5;
  await db.query(`UPDATE otp_tokens SET used=true WHERE mobile=$1 AND used=false`, [mobile]);
  await db.query(
    `INSERT INTO otp_tokens (mobile, otp_hash, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '${minutes} minutes')`,
    [mobile, hash]
  );
}

async function verifyOTP(mobile, enteredOtp) {
  const { rows } = await db.query(
    `SELECT * FROM otp_tokens
     WHERE mobile=$1 AND used=false AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
    [mobile]
  );
  if (!rows.length) return { valid: false, reason: 'OTP expired or not found' };
  const match = await bcrypt.compare(enteredOtp, rows[0].otp_hash);
  if (!match)   return { valid: false, reason: 'Incorrect OTP' };
  await db.query(`UPDATE otp_tokens SET used=true WHERE id=$1`, [rows[0].id]);
  return { valid: true };
}

module.exports = { generateOTP, saveOTP, verifyOTP };
