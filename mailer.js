// mailer.js — outbound email (flat structure)
// If SMTP_HOST is configured, sends real email via nodemailer. Otherwise
// (no SMTP credentials set — the common case in local/dev), logs the email
// to the console instead of silently failing, so the reset flow is still
// testable end-to-end without a real mail provider.
const nodemailer = require('nodemailer');

let transporter = null;
if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}

async function sendPasswordResetEmail(toEmail, resetLink) {
  const subject = 'Reset your RD-SSAAT password';
  const text = `Hello,

We received a request to reset your RD-SSAAT account password.

Open this link to create a new password:
${resetLink}

This link will expire soon and can only be used once.

If you did not request this password reset, you can safely ignore this email.

Regards,
RD-SSAAT`;

  if (!transporter) {
    // Dev/test fallback — no SMTP configured. Do NOT do this in production;
    // set SMTP_HOST/SMTP_USER/SMTP_PASS to actually deliver email.
    console.log('\n📧 [DEV MODE — no SMTP configured] Password reset email:');
    console.log('   To:', toEmail);
    console.log('   Link:', resetLink);
    console.log('   (Set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS in .env to send real email)\n');
    return { delivered: false, devMode: true };
  }

  await transporter.sendMail({
    from: process.env.SMTP_FROM || 'RD-SSAAT <no-reply@rdssaat.local>',
    to: toEmail,
    subject,
    text,
  });
  return { delivered: true, devMode: false };
}

module.exports = { sendPasswordResetEmail };
