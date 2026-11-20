# Admin changes 19 Nov 2026: curl / Postman steps (deletion confirmation email, 30-day retained email, email login code, admin invites)

Base URL `http://localhost:3000/api/v1` (start the server with `npm run dev`; with `MAIL_TRANSPORT=console` every
email is printed in the server console). In Postman: *Import → Raw text* and paste any command below.
Run `npm run migrate` first (migration 012 retained email, 014 admin login codes, 015 admin invites). New setting: `ADMIN_PANEL_URL` (default `http://localhost:5173`; must be `https://` in production). New setting: `RETAINED_EMAIL_DAYS` (default `30`).

What changed (client approved):
- When an account deletion completes (in the app, or a Full Admin approves a web-page request, or deletes from the
  Users page), the owner gets the email **"Your Satsang Spark account has been deleted"**. A parent account's email goes
  to the parent (child profiles have no email). If sending fails, the error is logged and the deletion still completes.
- The deleted account's email is kept on its deletion request for `RETAINED_EMAIL_DAYS` days, and **only Full Admins**
  see it (a Users-page delete of an account with no deletion request leaves no request row, so nothing is kept
  there). After that the API returns `email: null` and the purge job erases it (server start, every 24 hours, and
  `npm run purge:retained-emails`). Nothing else personal is kept.

## 1. Delete an account in the app → confirmation email
Register + verify an adult (see `postman-signup.md`), then:
```bash
curl -s -X DELETE http://localhost:3000/api/v1/me -H "Authorization: Bearer <accessToken>" -H "Content-Type: application/json" -d '{
  "password": "Secret123", "confirm": true }'
```
Expected: `200 { "deleted": true, "profilesDeleted": 1 }`. The server console shows
`[mail:console] to=<email> subject="Your Satsang Spark account has been deleted"` with the text
"Your account has been successfully removed. Everything linked to it has been deleted and you have been logged out on
every device. Thank you for being part of Satsang Spark."

## 2. Web-page request approved by a Full Admin → email to the parent
```bash
curl -s -X POST http://localhost:3000/api/v1/public/delete-account -H "Content-Type: application/json" -d '{
  "email": "parent@example.org", "password": "Secret123", "confirm": true }'

curl -s -X POST http://localhost:3000/api/v1/admin/deletion-requests/<requestId>/approve -H "Authorization: Bearer <full admin token>" -H "Content-Type: application/json" -d '{
  "confirm": true }'
```
Expected: `202` (no email yet: the request is only pending), then `200 { "status": "completed", ... }` and one email to
`parent@example.org`.

## 3. Deletion requests list (Completed tab): the retained email
```bash
curl -s "http://localhost:3000/api/v1/admin/deletion-requests?status=completed" -H "Authorization: Bearer <full admin token>"
```
Expected for a deletion in the last 30 days: `rows[].email` = the deleted account's email and
`rows[].emailRetainedUntil` = the UTC date it will be erased (deletion time + 30 days). `username` stays `null`.
Older rows (or rows with no email kept): `email: null`, `emailRetainedUntil: null`.
Pending / rejected rows are unchanged: `email` is the live account email and `emailRetainedUntil` is `null`.
The Admin Panel can show "— (account deleted)" only when `email` is `null`.

## 4. Deletion request detail
```bash
curl -s http://localhost:3000/api/v1/admin/deletion-requests/<requestId> -H "Authorization: Bearer <full admin token>"
```
Expected for a completed request within 30 days: `request.email` and `request.emailRetainedUntil` as above;
`account: null` and `profiles: []` as before.

## 5. Content Editor
```bash
curl -s "http://localhost:3000/api/v1/admin/deletion-requests?status=completed" -H "Authorization: Bearer <content editor token>"
```
Expected: `403 ROLE_FORBIDDEN`. Content Editors never see any email.

## 6. After 30 days
To try it without waiting, in MySQL: `UPDATE account_deletion_requests SET email_retained_until = UTC_TIMESTAMP() - INTERVAL 1 DAY WHERE id = <requestId>;`
Step 3 then shows `email: null` straight away. Run the purge:
```bash
npm run purge:retained-emails
```
Expected: `Erased 1 retained email(s).`; the row's `email_retained` is now `NULL`, and the audit log has one
`retained_emails.purged` entry with `details: { "count": 1 }` (no emails). A run that erases nothing writes no entry.
On cPanel, add a daily cron job: `cd <app folder> && npm run purge:retained-emails`.

## 7. Admin login with an emailed code (20 Nov 2026, client approved)
The authenticator app is gone: `/admin/auth/totp/setup`, `/totp/enable`, `/totp/verify` and
`/admin/admins/{id}/reset-2fa` now return 404, and `totpEnabled` is no longer in admin responses.
`ADMIN_TOTP_ENC_KEY` is not needed any more. Create a first admin with
`npm run seed:admin -- you@example.org "a passphrase of 12+ characters" "Your Name"`.

**Step 1: password**
```bash
curl -s -X POST http://localhost:3000/api/v1/admin/auth/login -H "Content-Type: application/json" -d '{
  "email": "you@example.org", "password": "a passphrase of 12+ characters" }'
```
Expected: `200 { "step": "email_otp", "challengeToken": "<challengeToken>", "expiresInSeconds": 600, "resendAfterSeconds": 60 }`
(no admin token yet). The server console shows `[mail:console] to=you@example.org subject="Your Satsang Spark admin login code"`
with the text "Your login code is 123456. It expires in 10 minutes. If you didn't try to log in, change your password."
Wrong email or wrong password: `401 INVALID_CREDENTIALS` "Email or password is incorrect" (the same for both).

**Step 2: the code**
```bash
curl -s -X POST http://localhost:3000/api/v1/admin/auth/verify-otp -H "Content-Type: application/json" -d '{
  "challengeToken": "<challengeToken>", "code": "123456" }'
```
Expected: `200 { "token": "<adminToken>", "admin": { "id", "email", "name", "role" } }`. Use
`Authorization: Bearer <adminToken>` on every other admin call. The same challenge token cannot be used again
(`401 CHALLENGE_INVALID`).
- Wrong code: `401 OTP_INVALID` with `details.attemptsLeft` (4, 3, 2, 1). The 5th wrong code: `429 OTP_LOCKED`
  "Too many wrong codes. Please log in again." (the account is also locked for 15 minutes: `429 ADMIN_LOCKED`).
- Code older than 10 minutes: `401 OTP_EXPIRED` "This code has expired. Request a new code or log in again."
- Challenge token older than 10 minutes, or replaced by a newer login: `401 CHALLENGE_INVALID` (log in again).

**New code**
```bash
curl -s -X POST http://localhost:3000/api/v1/admin/auth/resend-otp -H "Content-Type: application/json" -d '{
  "challengeToken": "<challengeToken>" }'
```
Expected: `200 { "sent": true, "expiresInSeconds": 600, "resendAfterSeconds": 60, "resendsLeft": 4 }` and a new
email; the previous code stops working. Within 60 seconds of the last email: `429 RESEND_TOO_SOON` with
`details.retryAfterSeconds`. After 5 resends for one login: `429 RESEND_LIMIT` (log in again).

Audit log (Full Admin, `GET /admin/audit-log`): `admin.login_code_sent` (`details.resend: true` for a resend),
`admin.login_code_failed` (`details.attemptsLeft`), `admin.login_success`; wrong passwords stay
`admin.login_failed`, a lock is `admin.locked`. No code is ever in the log or in a response.

## 8. Add admins by email invite (20 Nov 2026, client approved)
`npm run seed:admin` is now only for the very first Full Admin (or an emergency). Everyone else is invited from the
Admin Panel. All calls below except 8.2 and 8.3 need `Authorization: Bearer <full admin token>` (section 7); a
Content Editor gets `403 ROLE_FORBIDDEN`.

### 8.1 Invite
```bash
curl -s -X POST http://localhost:3000/api/v1/admin/admins -H "Authorization: Bearer <full admin token>" -H "Content-Type: application/json" -d '{
  "email": "priya@example.org", "name": "Priya", "role": "content_editor" }'
```
Expected: `201 { "admin": { "id": <newId>, "status": "invited", "isActive": false, "inviteExpiresAt": "<now + 48 h, UTC>", ... } }`.
The server console shows `[mail:console] to=priya@example.org subject="You've been invited to the Satsang Spark Admin Panel"`
with "Hello Priya, <your name> has invited you to the Satsang Spark Admin Panel as Content Editor.", the link
`http://localhost:5173/accept-invite?token=<inviteToken>` and "This link expires in 48 hours.". Copy `<inviteToken>` from it.
The same email again (any admin, any status): `409 ADMIN_EXISTS`. An invited admin cannot log in yet (`401 INVALID_CREDENTIALS`).

### 8.2 Check the link (public, what the panel's accept-invite page calls first)
```bash
curl -s http://localhost:3000/api/v1/admin/auth/invite/<inviteToken>
```
Expected: `200 { "email": "priya@example.org", "name": "Priya", "role": "content_editor" }`.
Unknown / used / replaced / cancelled link: `404 INVITE_INVALID`; older than 48 hours: `410 INVITE_EXPIRED`.

### 8.3 Accept: choose a password (public)
```bash
curl -s -X POST http://localhost:3000/api/v1/admin/auth/accept-invite -H "Content-Type: application/json" -d '{
  "token": "<inviteToken>", "password": "a passphrase of 12+ characters" }'
```
Expected: `200 { "ok": true, "email": "priya@example.org", "message": "Your password is set. You can now log in." }`.
Shorter than 12 characters: `400 VALIDATION_ERROR`. The link now returns `404 INVITE_INVALID`. Priya then logs in as in
section 7 (password, then the emailed code).

### 8.4 List admins
```bash
curl -s http://localhost:3000/api/v1/admin/admins -H "Authorization: Bearer <full admin token>"
```
Expected: every admin with `status` `"active"` | `"invited"` | `"inactive"` and `inviteExpiresAt` (only for invited
admins, otherwise `null`).

### 8.5 Resend or cancel an invite (invited admins only)
```bash
curl -s -X POST http://localhost:3000/api/v1/admin/admins/<id>/resend-invite -H "Authorization: Bearer <full admin token>"
curl -s -X DELETE http://localhost:3000/api/v1/admin/admins/<id> -H "Authorization: Bearer <full admin token>"
```
Resend: `200 { "admin": { "status": "invited", "inviteExpiresAt": "<now + 48 h>" } }`, a new email; the old link stops
working. Cancel: `200 { "ok": true, "cancelled": true }`; the admin and the link are gone. For an admin who has
accepted: `409 ADMIN_NOT_INVITED` (deactivate them instead).

### 8.6 Change role, deactivate, reactivate
```bash
curl -s -X PATCH http://localhost:3000/api/v1/admin/admins/<id> -H "Authorization: Bearer <full admin token>" -H "Content-Type: application/json" -d '{ "role": "full_admin" }'
curl -s -X PATCH http://localhost:3000/api/v1/admin/admins/<id> -H "Authorization: Bearer <full admin token>" -H "Content-Type: application/json" -d '{ "active": false }'
curl -s -X PATCH http://localhost:3000/api/v1/admin/admins/<id> -H "Authorization: Bearer <full admin token>" -H "Content-Type: application/json" -d '{ "active": true }'
```
Expected: `200 { "admin": { ... } }` with the new `role` / `status` (`"inactive"`, then `"active"`). A role change or
deactivation ends that admin's sessions at once; a deactivated admin's login gives `401 INVALID_CREDENTIALS`.
- Your own role: `400 CANNOT_DEMOTE_SELF`; deactivating yourself: `400 CANNOT_DEACTIVATE_SELF`.
- Would leave no active Full Admin: `409 LAST_FULL_ADMIN`.
- `active` on an invited admin: `409 ADMIN_INVITED` (only accepting the invite activates them).

Audit log: `admin.invited`, `admin.invite_resent`, `admin.invite_accepted`, `admin.invite_cancelled`,
`admin.role_changed` (`details: { from, to }`), `admin.deactivated`, `admin.reactivated`. No invite token or password
is ever in the audit log, in a response, or in the server's access log (the invite path is logged as `/invite/[redacted]`).
