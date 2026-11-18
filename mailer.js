// mailer.js — outbound email (flat structure)
// If SMTP_HOST is configured, sends real email via nodemailer. Otherwise
// (no SMTP credentials set — the common case in local/dev), logs the email
// to the console instead of silently failing, so the flows are still
// testable end-to-end without a real mail provider.
const nodemailer = require('nodemailer');

let transporter = null;
if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true', // true for port 465, false for 587 (STARTTLS)
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    // Fail fast instead of hanging a request when the SMTP host is unreachable
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function htmlWrap(bodyHtml) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#222;line-height:1.5">
  <div style="background:#1B5E20;color:#fff;padding:14px 20px;border-radius:10px 10px 0 0;font-weight:700">RD-SSAAT</div>
  <div style="border:1px solid #e5e5e5;border-top:0;padding:20px;border-radius:0 0 10px 10px">${bodyHtml}</div>
</div>`;
}

function button(link, label) {
  return `<p style="margin:22px 0"><a href="${esc(link)}" style="background:#2E7D32;color:#fff;text-decoration:none;padding:12px 22px;border-radius:24px;font-weight:700;display:inline-block">${esc(label)}</a></p>
<p style="font-size:12px;color:#777">If the button doesn't work, copy this link into your browser:<br><span style="word-break:break-all">${esc(link)}</span></p>`;
}

async function deliver({ to, subject, text, html, devLabel, devLink }) {
  if (!transporter) {
    // Dev/test fallback — no SMTP configured. Do NOT rely on this in production;
    // set SMTP_HOST/SMTP_USER/SMTP_PASS to actually deliver email.
    console.log(`\n📧 [DEV MODE — no SMTP configured] ${devLabel}:`);
    console.log('   To:', to);
    console.log('   Link:', devLink);
    console.log('   (Set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS in env to send real email)\n');
    return { delivered: false, devMode: true };
  }
  await transporter.sendMail({
    from: process.env.SMTP_FROM || 'RD-SSAAT <no-reply@rdssaat.local>',
    to, subject, text, html,
  });
  return { delivered: true, devMode: false };
}

async function sendPasswordResetEmail(toEmail, resetLink, expiresMinutes = 30) {
  const subject = 'Reset your RD-SSAAT password';
  const text = `Hello,

We received a request to reset your RD-SSAAT account password.

Open this link to create a new password:
${resetLink}

This link expires in ${expiresMinutes} minutes and can only be used once.

If you did not request this password reset, you can safely ignore this email.

Regards,
RD-SSAAT`;
  const html = htmlWrap(`<p>Hello,</p>
<p>We received a request to reset your RD-SSAAT account password.</p>
${button(resetLink, 'Create a new password')}
<p style="font-size:13px">This link expires in ${expiresMinutes} minutes and can only be used once. If you did not request this, you can safely ignore this email.</p>`);
  return deliver({ to: toEmail, subject, text, html, devLabel: 'Password reset email', devLink: resetLink });
}

// Sent to staff created through the Excel bulk upload (no password was supplied).
async function sendWelcomeEmail(toEmail, { name, employeeId, link, expiresHours = 72 }) {
  const subject = 'Your RD-SSAAT account is ready — set your password';
  const text = `Hello ${name},

An RD-SSAAT account has been created for you.

Employee ID: ${employeeId}

Open this link to set your password:
${link}

This link expires in ${expiresHours} hours and can only be used once. If it expires, use "Forgot Password" on the login page.

Regards,
RD-SSAAT`;
  const html = htmlWrap(`<p>Hello ${esc(name)},</p>
<p>An RD-SSAAT account has been created for you.</p>
<p><b>Employee ID:</b> ${esc(employeeId)}</p>
${button(link, 'Set your password')}
<p style="font-size:13px">This link expires in ${expiresHours} hours and can only be used once. If it expires, use “Forgot Password” on the login page.</p>`);
  return deliver({ to: toEmail, subject, text, html, devLabel: 'Welcome / set-password email', devLink: link });
}

module.exports = { sendPasswordResetEmail, sendWelcomeEmail };
