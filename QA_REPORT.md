# RD-SSAAT — Responsive Dashboard Redesign — QA Report

This covers the dashboard redesign requested after the RBAC/leave/email-reset phase.
Unlike the previous phase, this one involves real visual/layout behavior, so I got an
actual headless Chromium running in this environment (not just static code review) and
used it to log in, click through every view, and screenshot the app at desktop, tablet,
and mobile widths. Screenshots and real interaction results are below, not just claims.

## 1. What changed

- Replaced the old fixed 600px centered column (which made every dashboard look like a
  stretched mobile page on desktop) with a real sidebar + topbar app shell.
- **Desktop (≥1024px):** full persistent sidebar, topbar with title/user/logout, content
  in a responsive card grid.
- **Tablet/Mobile (<1024px):** sidebar becomes off-canvas, a hamburger button appears,
  clicking it slides the sidebar in over a dimmed overlay.
- **Mobile (<768px):** card grid collapses to a single column, touch targets enlarged,
  user name/role text hidden from the topbar to save space (avatar still shows).
- Role-scoped sidebar navigation:
  - **Admin:** Dashboard, Employee Management, Leave Management, Roles & Permissions,
    Audit Logs, Change Password
  - **HR:** Dashboard, Employee Management, Leave Management, Change Password
  - **Manager:** Dashboard, My Team (read-only), Team Leave, Change Password
  - **Employee:** Mark Attendance, Leave Management, Change Password
- New views wired to backend APIs that already existed but had no UI: a live-editable
  permissions matrix (checkboxes that call `PUT /admin/permissions/:role/:module`
  directly — verified changes persist and re-render correctly) and an audit log viewer.
- Added Change Password to both dashboards (backend endpoint existed, had no UI before).

## 2. Real browser verification (not just code review)

Installed Puppeteer + downloaded an actual Chromium binary in this sandbox, then:

- Logged in as admin with a real captcha solve, real credentials, against the live API
- Screenshotted the dashboard at **1440px** (desktop), **900px** (tablet), **390px** (mobile)
- Confirmed via computed styles, not guesses: hamburger button is `display:none` at
  1440px and `display:flex` at 900px; sidebar geometry is 250px wide and flush left at
  desktop; clicking the hamburger at 900px actually toggles the sidebar's `.open` class
- Confirmed the card grid's computed `grid-template-columns` is a single `1fr` at 390px
- Clicked through every admin sidebar view (Dashboard, Employee Management, Leave
  Management, Roles & Permissions, Audit Logs, Change Password) and screenshotted each —
  all render with live data, not placeholders
- Logged in as an employee and confirmed their dashboard (Mark Attendance, Leave
  Management, Change Password) renders correctly with their real name/leave balance/history

## 3. Bugs found and fixed during this pass (real ones, not hypothetical)

1. **Login was hard-gated on face-recognition models finishing loading.** `submitLogin()`
   checked `if (!modelsLoaded) return ...` before allowing login at all — meaning if the
   face-api.js CDN was ever slow, blocked, or unreachable (which is exactly what happened
   in my test sandbox — the CDN wasn't reachable), **no one could log in at all**, even
   though login has nothing to do with face recognition. Fixed by decoupling login from
   `modelsLoaded` entirely, and instead adding a proper guard (with a retry) at the two
   places that actually need the models: `startEnroll()` and `startRec()`.
2. **A genuine pre-existing ID collision**, found while restructuring: the Add-Staff
   form's Name/Designation inputs and the employee dashboard's name/designation display
   both used `id="empName"`/`id="empDesig"`. Since both dashboards exist in the DOM at
   once (only one is shown via CSS at a time), `getElementById` was silently grabbing the
   admin form's `<input>` instead of the employee's display `<div>` — meaning **the
   logged-in employee's own name/designation never actually rendered in their dashboard,
   this whole time**, invisibly. Confirmed fixed via screenshot: the employee dashboard
   now correctly shows "Team X" / "x | x" in the topbar.
3. **The fixed "Powered By" badge overlapped form content on mobile.** It's
   `position:fixed` at a high z-index, so on a tall scrolling form (Add Staff, 9 fields)
   it visually sat on top of the last couple of fields on narrow screens. Fixed with a
   mobile-specific override that drops it out of fixed positioning below 768px, plus
   `pointer-events:none` everywhere as a defensive measure so it can never block a click
   even where it does overlap something.
4. **Leave dates rendered as raw ISO timestamps** (`2026-11-28T00:00:00.000Z`) instead of
   a readable date, in both the employee's own leave list and the admin/manager/HR leave
   queue. Added a `fmtDate()` helper and confirmed via screenshot: now shows "28 Nov 2026".

## 4. Regression testing after the restructuring

Ran the full backend regression suite (10 core checks covering manager/team hierarchy,
leave apply/approve, audit logging, and forgot-password) against the restructured
frontend's exact API calls — all pass. The dashboard markup/CSS changes didn't touch any
backend route or JS data-loading logic, only the container/layout around existing
elements (confirmed no duplicate IDs, balanced HTML, and equivalent function wiring
before and after).

## 5. What's still not done, and why

- **Full 7-breakpoint sweep from the original spec** (1920/1440/1280/1024/768/390/360px).
  I verified 1440/900/390 directly with screenshots — the same CSS rules apply
  continuously across the untested widths in between (there's nothing that only
  triggers at, say, exactly 1280px), but I haven't screenshotted every single one.
- **Light/Dark mode** — not implemented this pass. This is a distinct, sizable feature
  (theme tokens throughout, a persisted preference, contrast-checking both themes) I'd
  rather scope and build deliberately than bolt on at the end of an already-large change.
- **Collapsible sidebar on desktop** (spec asks for both "off-canvas on mobile" and
  "collapsible" generally) — implemented as off-canvas on tablet/mobile; a desktop
  icon-only collapse toggle was not added. Small, addable if you want it.
- **Field-level permissions, leave attachment upload, notifications** — still deferred
  from the prior phase for the same reasons noted there (sensitive PII columns, no
  upload endpoint, no notification delivery mechanism).

## 6. Files changed

Only `index.html` (frontend) was touched in this pass. No backend files changed — the
10/10 regression pass confirms the API contract the frontend depends on is unaffected.
