# Satsang Spark — Backend API (Milestone 1)

Node.js + Express REST API with MySQL, JWT auth, and the foundation for the Admin Panel (roles, emailed login code as the second step, audit log).

**Milestone 1 scope covered here:** registration and login (email + password + email verification), password reset, adult and parent accounts, child profiles, 16 fixed avatars, DOB-based age groups, Parent PIN, parent daily-time report, account/profile deletion (including the external deletion-page endpoint), username moderation, and the admin foundation.

Interactive API docs: run the server and open **`/api-docs`** (Swagger UI). The raw spec is at **`/api-docs.json`** (importable into Postman: *Import → Link/File*). This is the Swagger/Postman documentation handed over with the source code.

## Requirements
- Node.js 20 or newer
- MySQL 8 (MariaDB 10.6+ also works)

## First-time setup
```bash
npm install
cp .env.example .env          # then edit .env (DB details, long random secrets)
# create the database and a user in MySQL:
#   CREATE DATABASE satsang_spark CHARACTER SET utf8mb4;
#   CREATE USER 'satsang'@'%' IDENTIFIED BY '<password>';
#   GRANT ALL ON satsang_spark.* TO 'satsang'@'%';
npm run migrate               # creates all tables (safe to re-run)
npm run seed:admin -- you@example.org "a passphrase of 12+ characters" "Your Name"
npm run dev                   # http://localhost:3000   (npm start for production)
```
Generate the secrets with `openssl rand -hex 32` (use a different value for `JWT_SECRET` and `ADMIN_JWT_SECRET`). In production the server refuses to start with the default secrets.

Admins log in with their password and then a 6-digit code emailed to them, so SMTP must work in production (`MAIL_TRANSPORT=smtp`; with `console` the email, code included, is printed in the server console: development only). They can then create other admins from the Admin Panel (or `POST /admin/admins`).

`npm run seed:admin` is only for the very first Full Admin (or an emergency). Every other admin is invited from the Admin Panel (`POST /admin/admins`): they get an email with a link to `<ADMIN_PANEL_URL>/accept-invite?token=…`, choose a password there, then log in normally. Set `ADMIN_PANEL_URL` to the panel address (`http://localhost:5173` locally); in production the server refuses to start unless it is an `https://` URL.

## Tests
```bash
cp .env.test.example .env.test   # a SEPARATE database whose name ends in _test (tests wipe its tables)
NODE_ENV=test npm run migrate
npm test                         # 137 tests: auth, profiles, Parent PIN, settings, deletion, admin roles/invites/login code/audit
```
On Windows use `set NODE_ENV=test&& npm run migrate` (cmd) or `$env:NODE_ENV="test"; npm run migrate` (PowerShell).

## Email
`MAIL_TRANSPORT=console` (default) prints verification/reset codes in the server log — fine for development. For real mail set `MAIL_TRANSPORT=smtp` and the `SMTP_*` values from Loyadham (or a service such as Brevo/SendGrid). SPF/DKIM must be set on the sending domain or the emails will land in spam.

## Project layout
```
db/migrations/      SQL schema (001 accounts/profiles/admin, 002 activity, 003 deletion requests, 004 account dob, 005 heartbeat minutes, 006 sign-up name/gender + sign-up bonus, 007 profile country, … 012 deletion retained email, 013 UTC timestamps, 014 admin login codes, 015 admin invites). `npm run migrate` applies them in order.
scripts/            migrate.js, seed-admin.js
src/config.js       all settings from .env
src/routes/         auth, account (/me), profiles, parent (PIN + report), public, admin/*
src/middleware/     auth (users), adminAuth (roles, login challenge token), validation, rate limits, errors
src/utils/          age groups, username filter, tokens/sessions, email codes, PIN lock, audit log
src/openapi.js      the API documentation
test/               automated tests
```

## How the main pieces work
- **Accounts vs profiles.** An *adult/independent* account has one playable profile (its own). A *parent* account has no profile of its own and creates child profiles. Everything a player owns later (Sparks, streak, Daily Spin, scores, progress, Dress Up items, Shangars) hangs off the **profile**, as agreed in the contract; the referral link/code stays on the account.
- **Sessions.** Login returns a 1-hour access token and a 60-day refresh token. Refresh tokens rotate on every use. A device session remembers which profile is active, so a child never falls back into parent mode on refresh. Logout, password change and password reset end sessions immediately.
- **Parent mode.** A parent logs in "in parent mode". Switching to a child (`POST /profiles/:id/switch`) and coming back (`POST /profiles/parent-mode`) both need the 4-digit Parent PIN. Five wrong PINs lock it for 15 minutes; resetting it with the account password clears the lock.
- **Dashboard time zone:** `DASHBOARD_TIMEZONE` (IANA name, default `Asia/Kolkata`) sets the day used by the Admin Panel dashboard ("new registrations today", chart days); it is sent as `timeZone` and shown on the card. An invalid name stops the server at start. The game day (streaks, daily challenges, leaderboards) stays America/New_York.
- **Age-group labels:** `src/utils/ageGroup.js` is the one list: `key` is the stored/API value (unchanged), `label` is the display name, the same as the app en.json. The key `Yuvak/Yuvatis A` reads `Yuvaks/Yuvatis A` (client choice, 20 Nov 2026).
- **Age groups** follow contract Section 3.3 and are recomputed from DOB (Eastern Time) on every profile load and every 6 hours. An admin override wins until it is cleared. DOB is returned only to the profile's own account.
- **Usernames:** 3–20 characters, letters in any script (Gujarati works), digits, `_` and `.`; unique ignoring case; checked against the admin-managed blocked/reserved list with look-alike handling (`sh1t` ≈ `shit`).
- **Account deletion:** in the app, `DELETE /me` (password) deletes at once, in one transaction, and records a completed row (source `app`) in the deletion history. The public web page (`POST /public/delete-account`) files a request (202) that a Full Admin approves (the account is deleted) or rejects with a reason in Admin → Deletion requests. Every path uses `deleteAccountCompletely` (`src/utils/accountDeletion.js`). The owner is emailed a deletion confirmation (a parent account: the parent's email); a mail failure is logged and never stops the deletion. History rows keep no username; the email is kept on the request row only for `RETAINED_EMAIL_DAYS` (default 30, client approved 19 Nov 2026), shown to Full Admins only, then erased by the purge job (server start, every 24 hours, and `npm run purge:retained-emails` for a cron job). A parent deletes one child with the Parent PIN (`DELETE /profiles/:id`, parent area); devices playing as that child are logged out.
- **Deletion:** database foreign keys cascade, so deleting a profile or account removes everything attached to it, now and for tables added in later milestones (new profile-owned tables must use `ON DELETE CASCADE` on `profile_id`).
- **Admin login (email code, client approved 20 Nov 2026):** `POST /admin/auth/login` (email + password) emails a 6-digit code (valid 10 minutes; only its SHA-256 hash is stored in `admin_login_codes`) and returns a single-use 10-minute `challengeToken`; `POST /admin/auth/verify-otp` with the token + code returns the admin token (8 h). 5 wrong tries end that login (log in again); `POST /admin/auth/resend-otp` sends a new code (old one stops working) at most once per 60 s and 5 times per login. A new login cancels an unfinished one. Five failures (password or code) lock the admin for 15 minutes. The code is never logged or returned; the audit log has `admin.login_code_sent`, `admin.login_code_failed`, `admin.login_success`. The old authenticator (TOTP) columns stay in `admins` unused, and `ADMIN_TOTP_ENC_KEY` is no longer needed. Every admin action is written to `audit_log` (read-only through the API).
- **Admin invites (client approved 20 Nov 2026):** a Full Admin invites with `POST /admin/admins` `{ email, name, role }`. The admin is created as `invited` (no password, `is_active = 0`) with a random 48-hour token (only its SHA-256 hash is stored, `admins.invite_token_hash`) and is emailed the link. The public `GET /admin/auth/invite/:token` (404 `INVITE_INVALID` / 410 `INVITE_EXPIRED`) and `POST /admin/auth/accept-invite` `{ token, password }` (bcrypt, 12–72 chars; the link then stops working) are rate limited. Full Admins can resend (`/admins/:id/resend-invite`, old link stops working), cancel (`DELETE /admins/:id`, invited only), change role and deactivate / reactivate (`PATCH /admins/:id` `{ role?, active? }`; not yourself; at least one active Full Admin always remains: 409 `LAST_FULL_ADMIN`). `GET /admin/admins` returns `status` (`active` | `invited` | `inactive`) and `inviteExpiresAt`. Deactivated admins cannot log in and their tokens stop at once. Invite tokens are never logged (the access log redacts them) or returned. Audit: `admin.invited`, `admin.invite_resent`, `admin.invite_accepted`, `admin.invite_cancelled`, `admin.role_changed`, `admin.deactivated`, `admin.reactivated`.

## Decisions made while building — please confirm with Loyadham
| Topic | What the code does now | Change at |
|---|---|---|
| Independent-user minimum age | 13. Younger children need a parent account. | `PARENTAL_CONSENT_AGE` in `.env` |
| Child profile ages | 18 and under | `src/routes/profiles.js` |
| Parental consent | Recorded (policy version + time) when a parent creates a child profile. The Parent PIN is not treated as legal consent. | Needs the final consent wording from Loyadham's counsel |
| Verification | 6-digit emailed code (works inside the app, no deep links), 15-minute expiry | `src/utils/emailCodes.js` |
| Parent PIN | 4 digits, 5 tries, 15-minute lock | `src/utils/pin.js` |
| Blocked-word list | Only a small starter list. **Loyadham must supply the real English, Gujarati-script and transliterated list**; the Admin Panel can add words at any time. | Admin → blocked words |
| Avatars | 16 placeholder rows; set `asset_url` when Om's artwork is ready | `avatars` table |
| Parent report | Daily active time works now. The learn/quiz/game/Sparks columns stay 0 until those features exist (Milestones 2–4). | `profile_daily_activity` |

## Deploying on Hostinger
Node.js apps need a Hostinger plan that supports Node (VPS/Cloud, or a Node.js web-app plan); basic shared hosting usually cannot run this. On a VPS: install Node 20+, run `npm ci --omit=dev`, keep the process alive with PM2 (`pm2 start src/server.js --name satsang-api`), and put nginx in front with HTTPS (Let's Encrypt). The server trusts one proxy hop for the client IP (`trust proxy`). Set `NODE_ENV=production` and `CORS_ORIGINS` to the Admin Panel's address. To debug a 500 on the live server, set `EXPOSE_ERRORS=true` temporarily (responses then carry the real error message instead of "Something went wrong"); remove it afterwards, because error messages can contain internal details.

## Not in this part yet (next in Milestone 1)
The React **Admin Panel** screens and the **Unity** app screens (registration, login, avatar, profile switching, Parent PIN, deletion). This backend is what they connect to.
