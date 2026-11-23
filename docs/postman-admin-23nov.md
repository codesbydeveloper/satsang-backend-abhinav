# Admin login changes 23 Nov 2026: curl / Postman steps (trusted devices, remember me, login alerts, Full Admin limit)

Base URL `http://localhost:3000/api/v1` (start the server with `npm run dev`; with `MAIL_TRANSPORT=console` every
email is printed in the server console). In Postman: *Import → Raw text* and paste any command below.
Run `npm run migrate` first (migration 017: `admin_trusted_devices`, `admin_refresh_tokens`, `admins.last_login_alert_at`).
New settings: `ADMIN_REFRESH_DAYS` (default `30`), `MAX_FULL_ADMINS` (default `3`).

What changed (client approved):
- The emailed code is asked **only on the first login from a new browser**, if the admin ticks "Trust this device".
  That browser then logs in with the password only, with no expiry, until the device is revoked.
- **Remember me** keeps the admin signed in for 30 days (rolling) using a refresh token. Without it, the session
  is the 8-hour admin token, as before.
- Every new sign-in emails **all active Full Admins** "Satsang Spark Admin – new sign-in" (at most once per admin per 10 minutes).
- At most **3 Full Admins** (active + invited). Everyone else is a Content Editor.

## 1. First login from a new browser: password, code, trust the device
```bash
curl -s -X POST http://localhost:3000/api/v1/admin/auth/login -H "Content-Type: application/json" -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36" -d '{
  "email": "boss@example.org", "password": "<password>", "rememberMe": true }'
```
Expected: `200 { "step": "email_otp", "challengeToken": "...", "expiresInSeconds": 600, "resendAfterSeconds": 60 }`
and the code email in the server console.
```bash
curl -s -X POST http://localhost:3000/api/v1/admin/auth/verify-otp -H "Content-Type: application/json" -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36" -d '{
  "challengeToken": "<challengeToken>", "code": "<6-digit code>", "trustDevice": true }'
```
Expected: `200 { "step": "done", "token": "...", "admin": {...}, "rememberMe": true, "refreshToken": "...",
"refreshExpiresAt": "<30 days from now>", "deviceToken": "<long URL-safe string>", "device": { "id": 1, "label": "Chrome on Windows", ... } }`.
The panel keeps `deviceToken` (it is never shown again) and `refreshToken`. The audit log has `admin.device_trusted`
and `admin.login_success` `{ "method": "otp" }`. All active Full Admins get the sign-in alert email (section 5).

Without `"trustDevice": true` no device is stored and the next login asks for a code again.

## 2. Next login from the same browser: password only
```bash
curl -s -X POST http://localhost:3000/api/v1/admin/auth/login -H "Content-Type: application/json" -d '{
  "email": "boss@example.org", "password": "<password>", "deviceToken": "<deviceToken>" }'
```
Expected: `200 { "step": "done", "token": "...", "admin": {...}, "rememberMe": false, "refreshToken": null, "device": {...} }`.
No code email. Audit: `admin.login_success` `{ "method": "trusted_device" }`.
A wrong password is still `401 INVALID_CREDENTIALS` (and counts towards the 15-minute lock).
An unknown or revoked `deviceToken`: `step: "email_otp"` as in section 1, plus `"deviceTokenInvalid": true` (the panel can forget it).

## 3. Remember me: refresh
```bash
curl -s -X POST http://localhost:3000/api/v1/admin/auth/refresh -H "Content-Type: application/json" -d '{
  "refreshToken": "<refreshToken>" }'
```
Expected: `200 { "token": "...", "admin": {...}, "refreshToken": "<new>", "refreshExpiresAt": "<30 days from now>" }`.
Store the new refresh token; the old one now gives `401 REFRESH_INVALID`. A refresh sends **no** alert email and writes
no audit entry. Logout, a password change or reset, a role change or deactivation also make it `401 REFRESH_INVALID`.

## 4. Logout
```bash
curl -s -X POST http://localhost:3000/api/v1/admin/auth/logout -H "Authorization: Bearer <token>"
```
Expected: `200 { "ok": true }`. The admin token and the refresh tokens stop working. The trusted device is kept
(section 2 still works).

## 5. The sign-in alert email
After section 1 or 2 the server console shows one email per active Full Admin:
```
subject="Satsang Spark Admin – new sign-in"
An admin has just signed in to the Satsang Spark Admin Panel.

Who: boss (boss@example.org), Full Admin
When: 23 Nov 2026, 20:34:05 IST (Asia/Kolkata) · 23 Nov 2026, 15:04:05 UTC
Device: Chrome on Windows

If this wasn't expected, deactivate the admin in the panel.
```
(The HTML version uses the shared branded layout.) Logging in again within 10 minutes sends no new alert.
If sending fails, the error is logged and the login still succeeds.

## 6. My trusted devices
```bash
curl -s http://localhost:3000/api/v1/admin/me/devices -H "Authorization: Bearer <token>"
curl -s -X DELETE http://localhost:3000/api/v1/admin/me/devices/<deviceId> -H "Authorization: Bearer <token>"
```
Expected: `200 { "devices": [ { "id", "label", "createdAt", "lastUsedAt" } ] }`, then `200 { "ok": true, "revoked": true }`
(`404 DEVICE_NOT_FOUND` for a device that is not yours or already revoked). Works for both roles. At most 10 devices
are kept per admin: trusting an 11th revokes the oldest.

## 7. Another admin's devices (Full Admin)
```bash
curl -s http://localhost:3000/api/v1/admin/admins/<adminId>/devices -H "Authorization: Bearer <full admin token>"
curl -s -X DELETE http://localhost:3000/api/v1/admin/admins/<adminId>/devices/<deviceId> -H "Authorization: Bearer <full admin token>"
curl -s -X DELETE http://localhost:3000/api/v1/admin/admins/<adminId>/devices -H "Authorization: Bearer <full admin token>"
```
Expected: the list; `{ "ok": true, "revoked": true }`; `{ "ok": true, "revoked": <count> }`. Content Editor: `403 ROLE_FORBIDDEN`.
Every device of an admin is also revoked automatically when their password changes or is reset, when they are
deactivated, and when their role changes (audit `admin.device_revoked` with the reason).

## 8. Full Admin limit
```bash
curl -s http://localhost:3000/api/v1/admin/admins -H "Authorization: Bearer <full admin token>"
```
Expected: `admins` plus `"fullAdminLimit": { "max": 3, "used": <active + invited Full Admins> }`.
With 3 already:
```bash
curl -s -X POST http://localhost:3000/api/v1/admin/admins -H "Authorization: Bearer <full admin token>" -H "Content-Type: application/json" -d '{
  "email": "fourth@example.org", "name": "Fourth", "role": "full_admin" }'
```
Expected: `409 FULL_ADMIN_LIMIT` (nothing created, no email). The same for `PATCH /admin/admins/<id>` `{ "role": "full_admin" }`
and for reactivating a deactivated Full Admin (`{ "active": true }`). Inviting a `content_editor` always works.
Deactivated Full Admins do not count; invited ones do.

## 9. Content Editor access check
With a Content Editor token, every one of these is `403 ROLE_FORBIDDEN`: `/admin/users` (list, detail, delete, age
group), `/admin/profiles/:id/student-status`, `/admin/deletion-requests` (list, detail, approve, reject),
`/admin/admins` (all, including devices), `/admin/audit-log`, `/admin/dashboard`, `/admin/referrals` and
`/admin/referrals/settings`. There is no export endpoint yet. A Content Editor can use `/admin/blocked-words`,
`/admin/auth/*` (own account) and `/admin/me/devices`.
