// password-policy.js — shared password complexity rule (flat structure)
// Applied going forward to password reset and change-password. NOT retroactively
// enforced on existing accounts — only new/changed passwords need to satisfy it.
function passwordPolicyError(pw) {
  if (!pw || pw.length < 8) return 'Password must be at least 8 characters';
  if (!/[A-Z]/.test(pw))    return 'Password must include an uppercase letter';
  if (!/[a-z]/.test(pw))    return 'Password must include a lowercase letter';
  if (!/[0-9]/.test(pw))    return 'Password must include a number';
  if (!/[^A-Za-z0-9]/.test(pw)) return 'Password must include a special character';
  return null;
}

module.exports = { passwordPolicyError };
