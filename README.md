# Satsang Spark — Backend API (Milestone 1)

Node.js + Express REST API with MySQL, JWT auth, and the foundation for the Admin Panel (roles, TOTP 2FA, audit log).

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
Generate the secrets with `openssl rand -hex 32` (use a different value for each of `JWT_SECRET`, `ADMIN_JWT_SECRET`, `ADMIN_TOTP_ENC_KEY`). In production the server refuses to start with the default secrets.

The first Full Admin sets up an authenticator app (Google Authenticator, Authy, …) the first time they log in. They can then create other admins from the Admin Panel (or `POST /admin/admins`).

## Tests
```bash
cp .env.test.example .env.test   # a SEPARATE database whose name ends in _test (tests wipe its tables)
NODE_ENV=test npm run migrate
npm test                         # 34 tests: auth, profiles, Parent PIN, deletion, admin roles/2FA/audit
```
On Windows use `set NODE_ENV=test&& npm run migrate` (cmd) or `$env:NODE_ENV="test"; npm run migrate` (PowerShell).

## Email
`MAIL_TRANSPORT=console` (default) prints verification/reset codes in the server log — fine for development. For real mail set `MAIL_TRANSPORT=smtp` and the `SMTP_*` values from Loyadham (or a service such as Brevo/SendGrid). SPF/DKIM must be set on the sending domain or the emails will land in spam.

## Project layout
```
db/migrations/      SQL schema (001 accounts/profiles/admin, 002 activity). `npm run migrate` applies them in order.
scripts/            migrate.js, seed-admin.js
src/config.js       all settings from .env
src/routes/         auth, account (/me), profiles, parent (PIN + report), public, admin/*
src/middleware/     auth (users), adminAuth (roles, 2FA steps), validation, rate limits, errors
src/utils/          age groups, username filter, tokens/sessions, email codes, PIN lock, audit log
src/openapi.js      the API documentation
test/               automated tests
```

## How the main pieces work
- **Accounts vs profiles.** An *adult/independent* account has one playable profile (its own). A *parent* account has no profile of its own and creates child profiles. Everything a player owns later (Sparks, streak, Daily Spin, scores, progress, Dress Up items, Shangars) hangs off the **profile**, as agreed in the contract; the referral link/code stays on the account.
- **Sessions.** Login returns a 1-hour access token and a 60-day refresh token. Refresh tokens rotate on every use. A device session remembers which profile is active, so a child never falls back into parent mode on refresh. Logout, password change and password reset end sessions immediately.
- **Parent mode.** A parent logs in "in parent mode". Switching to a child (`POST /profiles/:id/switch`) and coming back (`POST /profiles/parent-mode`) both need the 4-digit Parent PIN. Five wrong PINs lock it for 15 minutes; resetting it with the account password clears the lock.
- **Age groups** follow contract Section 3.3 and are recomputed from DOB (Eastern Time) on every profile load and every 6 hours. An admin override wins until it is cleared. DOB is returned only to the profile's own account.
- **Usernames:** 3–20 characters, letters in any script (Gujarati works), digits, `_` and `.`; unique ignoring case; checked against the admin-managed blocked/reserved list with look-alike handling (`sh1t` ≈ `shit`).
- **Deletion:** database foreign keys cascade, so deleting a profile or account removes everything attached to it, now and for tables added in later milestones (new profile-owned tables must use `ON DELETE CASCADE` on `profile_id`).
- **Admin login:** password → authenticator code → admin token (8 h). A step token can only be used for the 2FA calls. Five failures lock the admin for 15 minutes. Every admin action is written to `audit_log` (read-only through the API).

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
Node.js apps need a Hostinger plan that supports Node (VPS/Cloud, or a Node.js web-app plan); basic shared hosting usually cannot run this. On a VPS: install Node 20+, run `npm ci --omit=dev`, keep the process alive with PM2 (`pm2 start src/server.js --name satsang-api`), and put nginx in front with HTTPS (Let's Encrypt). The server trusts one proxy hop for the client IP (`trust proxy`). Set `NODE_ENV=production` and `CORS_ORIGINS` to the Admin Panel's address.

## Not in this part yet (next in Milestone 1)
The React **Admin Panel** screens and the **Unity** app screens (registration, login, avatar, profile switching, Parent PIN, deletion). This backend is what they connect to.
