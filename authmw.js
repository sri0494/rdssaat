// authmw.js — JWT middleware + role-based authorization (flat structure)
const jwt = require('jsonwebtoken');
const db  = require('./db');

// All roles the system understands, and who's allowed to grant which.
// Keep this as the single source of truth — employees.js imports it too.
const ROLES = ['admin', 'manager', 'hr', 'employee'];

// Who is allowed to *assign* which role when creating/editing an account.
// admin can assign any role. hr can only create/edit plain employees
// (HR shouldn't be able to mint themselves or others an admin/manager account).
const ROLE_ASSIGNABLE_BY = {
  admin:    ['admin'],
  manager:  ['admin'],
  hr:       ['admin'],
  employee: ['admin', 'hr'],
};

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer '))
    return res.status(401).json({ success: false, message: 'No token provided' });
  try {
    req.user = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}

// Generic role gate: authorize('admin','manager') lets either role through.
function authorize(...allowedRoles) {
  return (req, res, next) => {
    if (!allowedRoles.includes(req.user?.role))
      return res.status(403).json({ success: false, message: 'You do not have access to this action' });
    next();
  };
}

// Back-compat alias — existing routes use adminOnly; keep it working.
const adminOnly = authorize('admin');

function canAssignRole(assignerRole, targetRole) {
  return (ROLE_ASSIGNABLE_BY[targetRole] || []).includes(assignerRole);
}

// ═══════════════════════════════════════════════════════════════════
// DB-driven module/action permissions (role_permissions table).
// This is the "don't hard-code this only in frontend" requirement — the
// matrix lives in the database and is checked on every request, not just
// used to decide what buttons the UI shows.
//
// action must match one of the boolean columns: view/create/edit/delete/
// approve/reject/export (mapped to can_view/can_create/... below).
// ═══════════════════════════════════════════════════════════════════
const ACTION_COLUMN = {
  view: 'can_view', create: 'can_create', edit: 'can_edit', delete: 'can_delete',
  approve: 'can_approve', reject: 'can_reject', export: 'can_export',
};

function requirePermission(module, action) {
  const column = ACTION_COLUMN[action];
  if (!column) throw new Error(`Unknown permission action "${action}"`);
  return async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT ${column} AS allowed FROM role_permissions WHERE role=$1 AND module=$2`,
        [req.user.role, module]
      );
      // No row = no permission on record for that role/module; fail closed.
      if (!rows.length || !rows[0].allowed)
        return res.status(403).json({ success: false, message: `You do not have "${action}" access to ${module}` });
      next();
    } catch (e) {
      console.error('Permission check failed:', e);
      res.status(500).json({ success: false, message: 'Could not verify permissions' });
    }
  };
}

module.exports = { authenticate, adminOnly, authorize, ROLES, canAssignRole, requirePermission };
