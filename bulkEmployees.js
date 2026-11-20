// bulkEmployees.js — bulk employee import from Excel/CSV (flat structure)
//
// Mount BEFORE the existing /api/employees router:
//   app.use('/api/employees/bulk', createBulkEmployeesRouter({ pool, authenticate }));
//
//   GET  /api/employees/bulk/template   → downloadable .xlsx template
//   POST /api/employees/bulk            → multipart: file (.xlsx/.csv), sendInvites ('true'|'false')
//
// Valid rows are imported in ONE transaction; invalid / duplicate rows are reported per row.
// Existing Employee IDs are "skipped", so re-uploading a corrected file is safe.
const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const { Readable } = require('stream');
const { issueResetToken, buildResetLink, PASSWORD_RE, PASSWORD_MSG, EMAIL_RE } = require('./passwordReset');
const { sendWelcomeEmail } = require('./mailer');

const MAX_ROWS = 200;
const INVITE_TTL_HOURS = 72;
const ROLES = ['employee', 'manager', 'hr', 'admin'];

// key → header shown in the template, whether required, and accepted header spellings
const COLUMNS = [
  { key: 'employeeId',  header: 'Employee ID',   required: true,  width: 16, aliases: ['employeeid', 'empid', 'id', 'employeecode'] },
  { key: 'name',        header: 'Name',          required: true,  width: 26, aliases: ['name', 'fullname', 'employeename', 'staffname'] },
  { key: 'mobile',      header: 'Mobile',        required: true,  width: 16, aliases: ['mobile', 'mobileno', 'mobilenumber', 'phone'] },
  { key: 'email',       header: 'Email',         required: true,  width: 32, aliases: ['email', 'emailid', 'emailaddress'] },
  { key: 'designation', header: 'Designation',   required: true,  width: 22, aliases: ['designation', 'title'] },
  { key: 'district',    header: 'District',      required: true,  width: 20, aliases: ['district'] },
  { key: 'role',        header: 'Role (optional)',       required: false, width: 16, aliases: ['role', 'employee', 'userrole'] },
  { key: 'managerId',   header: 'Manager ID (optional)', required: false, width: 20, aliases: ['managerid', 'manager', 'assignmanager', 'managercode'] },
  { key: 'password',    header: 'Password (optional)',   required: false, width: 22, aliases: ['password'] },
];

const normHeader = (h) => String(h || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]/g, '');

// ExcelJS cell values can be strings, numbers, dates, rich text, hyperlinks or formulas
function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString();
    if (v.richText) return v.richText.map((t) => t.text).join('').trim();
    if (v.text != null) return cellText(v.text);
    if (v.result != null) return cellText(v.result);
    if (v.hyperlink) return String(v.hyperlink).replace(/^mailto:/i, '').trim();
    return '';
  }
  return String(v).trim();
}

async function readSheet(file) {
  const wb = new ExcelJS.Workbook();
  const ext = path.extname(file.originalname || '').toLowerCase();
  let ws;
  if (ext === '.csv') ws = await wb.csv.read(Readable.from(file.buffer));
  else { await wb.xlsx.load(file.buffer); ws = wb.getWorksheet('Employees') || wb.worksheets[0]; }
  if (!ws) throw new Error('The file has no sheets');

  // header row → column index per key
  const colIndex = {};
  const ignored = [];
  ws.getRow(1).eachCell((cell, n) => {
    const raw = cellText(cell.value);
    const h = normHeader(raw);
    const col = COLUMNS.find((c) => c.aliases.includes(h));
    if (col && !colIndex[col.key]) colIndex[col.key] = n;
    else if (raw) ignored.push(raw);
  });
  const missing = COLUMNS.filter((c) => c.required && !colIndex[c.key]).map((c) => c.header);
  if (missing.length) {
    const err = new Error(`Missing column(s): ${missing.join(', ')}. Please use the template.`);
    err.userFacing = true; throw err;
  }

  const rows = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const data = {};
    let any = false;
    for (const c of COLUMNS) {
      data[c.key] = colIndex[c.key] ? cellText(ws.getRow(r).getCell(colIndex[c.key]).value) : '';
      if (data[c.key]) any = true;
    }
    if (any) rows.push({ row: r, ...data });
  }
  return { rows, ignored };
}

function createBulkEmployeesRouter({ pool, authenticate }) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });

  // Uses the same role_permissions matrix the Roles & Permissions screen edits
  async function requireCreateEmployees(req, res, next) {
    try {
      const role = req.user && req.user.role;
      const { rows } = await pool.query(
        `SELECT can_create FROM role_permissions WHERE role = $1 AND module = 'employees'`, [role]);
      if (!rows.length || !rows[0].can_create)
        return res.status(403).json({ success: false, message: 'You do not have permission to add employees' });
      next();
    } catch (e) { next(e); }
  }

  const guard = [authenticate, requireCreateEmployees];

  // Open /api/employees/bulk/ping in a browser to confirm this router is deployed and mounted
  router.get('/ping', (req, res) => res.json({ success: true, bulkUpload: 'mounted' }));

  // ───────────── Template ─────────────
  router.get('/template', guard, async (req, res) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Employees', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width, style: { numFmt: '@' } })); // text: keeps leading zeros
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    COLUMNS.forEach((c, i) => {
      head.getCell(i + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c.required ? 'FF1B5E20' : 'FF607D8B' } };
    });
    const roleCol = COLUMNS.findIndex((c) => c.key === 'role') + 1;
    const L = String.fromCharCode(64 + roleCol); // column letter
    ws.dataValidations.add(`${L}2:${L}${MAX_ROWS + 1}`, { type: 'list', allowBlank: true, formulae: ['"employee,manager,hr,admin"'] });

    const info = wb.addWorksheet('Instructions');
    info.columns = [{ width: 24 }, { width: 90 }];
    [
      ['How to fill', `One employee per row on the "Employees" sheet (max ${MAX_ROWS} rows per upload). Green headers are required.`],
      ['Employee ID', 'Unique, letters/numbers/dash/underscore only. Example: EMP1001'],
      ['Mobile', '10 digits, unique per employee. Example: 9876543210'],
      ['Email', 'Unique. This is where password-reset links are sent.'],
      ['Role', 'employee (default), manager, hr or admin. Only admins can create non-employee roles.'],
      ['Manager ID', 'Employee ID of an existing manager (or a manager listed in the same file).'],
      ['Password', `Optional. If blank, a random password is set and (if you tick the option) the employee gets an email link to choose their own. Otherwise: ${PASSWORD_MSG.toLowerCase()}.`],
      ['Re-uploading', 'Rows whose Employee ID already exists are skipped, so you can fix failed rows and upload the same file again.'],
    ].forEach((r) => info.addRow(r));
    info.getColumn(1).font = { bold: true };
    info.getColumn(2).alignment = { wrapText: true, vertical: 'top' };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="RD-SSAAT-Employee-Template.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  });

  // ───────────── Import ─────────────
  function handleUpload(req, res, next) {
    upload.single('file')(req, res, (err) => {
      if (!err) return next();
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 2 MB)' : 'Upload failed: ' + err.message;
      res.status(400).json({ success: false, message: msg });
    });
  }

  router.post('/', guard, handleUpload, async (req, res) => {
    const actor = req.user || {};
    const actorId = actor.employeeId || actor.employee_id || actor.id || null;
    const isAdmin = actor.role === 'admin';
    const sendInvites = String(req.body?.sendInvites) === 'true';

    if (!req.file) return res.status(400).json({ success: false, message: 'Choose an .xlsx or .csv file' });
    const ext = path.extname(req.file.originalname || '').toLowerCase();
    if (!['.xlsx', '.csv'].includes(ext))
      return res.status(400).json({ success: false, message: 'Only .xlsx or .csv files are supported (in Excel use Save As → .xlsx)' });

    let sheetRows, ignoredHeaders;
    try { ({ rows: sheetRows, ignored: ignoredHeaders } = await readSheet(req.file)); }
    catch (e) {
      return res.status(400).json({ success: false, message: e.userFacing ? e.message : 'Could not read the file — is it a valid .xlsx/.csv?' });
    }
    if (!sheetRows.length) return res.status(400).json({ success: false, message: 'No employee rows found in the file' });
    if (sheetRows.length > MAX_ROWS)
      return res.status(400).json({ success: false, message: `Too many rows (${sheetRows.length}). Maximum is ${MAX_ROWS} per upload — please split the file.` });

    // ── 1. Per-row validation ──
    const results = new Map(); // row number → { row, employeeId, status, message }
    const fail = (r, message, status = 'failed') => results.set(r.row, { row: r.row, employeeId: r.employeeId, status, message });
    let ok = [];
    for (const r of sheetRows) {
      r.email = r.email.toLowerCase();
      r.role = (r.role || 'employee').toLowerCase();
      const errs = [];
      if (!r.employeeId) errs.push('Employee ID is required');
      else if (!/^[A-Za-z0-9_-]{1,50}$/.test(r.employeeId)) errs.push('Employee ID may only contain letters, numbers, - and _ (max 50)');
      if (!r.name) errs.push('Name is required'); else if (r.name.length > 100) errs.push('Name is too long (max 100)');
      if (!/^\d{10}$/.test(r.mobile)) errs.push(`Mobile "${r.mobile}" must be exactly 10 digits`);
      if (!EMAIL_RE.test(r.email) || r.email.length > 255) errs.push(`Email "${r.email}" is not valid (needs a full address like name@domain.com)`);
      if (!r.designation) errs.push('Designation is required');
      if (!r.district) errs.push('District is required');
      if (!ROLES.includes(r.role)) errs.push(`Role "${r.role}" must be employee, manager, hr or admin`);
      else if (!isAdmin && r.role !== 'employee') errs.push('Only admins can create manager/hr/admin accounts');
      if (r.password && !PASSWORD_RE.test(r.password)) errs.push(PASSWORD_MSG);
      if (errs.length) fail(r, errs.join('; ')); else ok.push(r);
    }

    // ── 2. Duplicates: inside the file, then against the database ──
    const seen = { id: new Map(), mobile: new Map(), email: new Map() };
    ok = ok.filter((r) => {
      const dup = [['id', r.employeeId, 'Employee ID'], ['mobile', r.mobile, 'Mobile'], ['email', r.email, 'Email']]
        .find(([k, v]) => seen[k].has(v));
      if (dup) { fail(r, `${dup[2]} is repeated (same as row ${seen[dup[0]].get(dup[1])})`); return false; }
      seen.id.set(r.employeeId, r.row); seen.mobile.set(r.mobile, r.row); seen.email.set(r.email, r.row);
      return true;
    });

    let dbManagers;
    try {
      const { rows: existing } = await pool.query(
        `SELECT employee_id, mobile, LOWER(email) AS email FROM employees
          WHERE employee_id = ANY($1) OR mobile = ANY($2) OR LOWER(email) = ANY($3)`,
        [ok.map((r) => r.employeeId), ok.map((r) => r.mobile), ok.map((r) => r.email)]);
      const ids = new Set(existing.map((e) => e.employee_id));
      const mobiles = new Set(existing.map((e) => e.mobile));
      const emails = new Set(existing.map((e) => e.email));
      ok = ok.filter((r) => {
        if (ids.has(r.employeeId)) { fail(r, 'Employee ID already exists — skipped', 'skipped'); return false; }
        if (mobiles.has(r.mobile)) { fail(r, 'Mobile is already registered to another employee'); return false; }
        if (emails.has(r.email)) { fail(r, 'Email is already registered to another employee'); return false; }
        return true;
      });
      const m = await pool.query(`SELECT employee_id FROM employees WHERE role = 'manager' AND is_active = true`);
      dbManagers = new Set(m.rows.map((x) => x.employee_id));
    } catch (e) {
      console.error('bulk import lookup failed:', e.message);
      return res.status(500).json({ success: false, message: 'Database error while checking existing employees' });
    }

    // ── 3. Manager references (DB managers, or managers being created in this same file) ──
    let changed = true;
    while (changed) {
      changed = false;
      const fileManagers = new Set(ok.filter((r) => r.role === 'manager').map((r) => r.employeeId));
      ok = ok.filter((r) => {
        if (r.managerId && !dbManagers.has(r.managerId) && !fileManagers.has(r.managerId)) {
          fail(r, `Manager ID "${r.managerId}" is not an existing manager`); changed = true; return false;
        }
        if (r.managerId && r.managerId === r.employeeId) { fail(r, 'An employee cannot be their own manager'); changed = true; return false; }
        return true;
      });
    }

    // ── 4. Hash passwords (blank → random placeholder; cost 4 is fine since nobody knows it) ──
    for (const r of ok) {
      r.needsInvite = !r.password;
      const plain = r.password || crypto.randomBytes(24).toString('base64url');
      r.hash = await bcrypt.hash(plain, r.password ? 10 : 4);
    }

    // ── 5. Insert everything in one transaction ──
    const invites = [];
    if (ok.length) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const r of ok) {
          await client.query(
            `INSERT INTO employees (employee_id, name, mobile, email, password_hash, role, designation, district)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [r.employeeId, r.name, r.mobile, r.email, r.hash, r.role, r.designation, r.district]);
        }
        // managers are linked after all rows exist, so order inside the file doesn't matter
        for (const r of ok.filter((x) => x.managerId)) {
          await client.query('UPDATE employees SET manager_id = $1 WHERE employee_id = $2', [r.managerId, r.employeeId]);
        }
        if (sendInvites) {
          for (const r of ok.filter((x) => x.needsInvite)) {
            const token = await issueResetToken(client, r.employeeId, INVITE_TTL_HOURS * 60);
            invites.push({ email: r.email, name: r.name, employeeId: r.employeeId, link: buildResetLink(r.employeeId, token) });
          }
        }
        await client.query('COMMIT');
        ok.forEach((r) => results.set(r.row, { row: r.row, employeeId: r.employeeId, status: 'created', message: 'Created' }));
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('bulk import insert failed:', e.message);
        const msg = e.code === '23505'
          ? 'Another admin added a matching employee at the same moment — nothing was imported. Please upload again.'
          : 'Database error — nothing was imported. Please try again.';
        return res.status(e.code === '23505' ? 409 : 500).json({ success: false, message: msg });
      } finally {
        client.release();
      }
    }

    // ── 6. Audit + invite emails (after the response; failures are only logged) ──
    const list = [...results.values()].sort((a, b) => a.row - b.row);
    const summary = {
      total: list.length,
      created: list.filter((x) => x.status === 'created').length,
      skipped: list.filter((x) => x.status === 'skipped').length,
      failed: list.filter((x) => x.status === 'failed').length,
      invitesQueued: invites.length,
    };
    const warnings = ignoredHeaders.length ? [`Ignored column(s) not recognised: ${ignoredHeaders.join(', ')}. Use the template headers if you wanted these imported.`] : [];
    res.json({ success: true, message: `Imported ${summary.created} of ${summary.total} rows`, summary, warnings, results: list });

    pool.query(
      `INSERT INTO audit_logs (employee_id, action, module, new_value) VALUES ($1, 'bulk_create_employees', 'employees', $2)`,
      [actorId, JSON.stringify({ file: req.file.originalname, ...summary })]
    ).catch((e) => console.error('bulk audit log failed:', e.message));

    (async () => {
      for (const inv of invites) {
        try { await sendWelcomeEmail(inv.email, { name: inv.name, employeeId: inv.employeeId, link: inv.link, expiresHours: INVITE_TTL_HOURS }); }
        catch (e) { console.error(`welcome email to ${inv.email} failed:`, e.message); }
        await new Promise((r) => setTimeout(r, 250)); // gentle on SMTP rate limits
      }
    })();
  });

  return router;
}

module.exports = { createBulkEmployeesRouter };
