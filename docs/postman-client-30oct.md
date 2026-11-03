# Client changes 30 Oct 2026: curl / Postman steps (Explore import, referrals)

Base URL `http://localhost:3000/api/v1` (start the server with `npm run dev`; with `MAIL_TRANSPORT=console` the
6-digit code is printed in the server console). In Postman: *Import → Raw text* and paste any command below.
Run `npm run migrate` first (migrations 008 Explore import, 009 referrals).

## 1. Register from Explore (independent, "Just me")
The app sends the normal register request; the Explore nickname, avatar and path are not part of it.
```bash
curl -s -X POST http://localhost:3000/api/v1/auth/register -H "Content-Type: application/json" -d '{
  "accountType": "adult", "dob": "1998-05-05",
  "firstName": "Meera", "lastName": "Patel", "gender": "female",
  "email": "meera@example.org", "password": "Secret123", "acceptPrivacyPolicy": true, "language": "en" }'

curl -s -X POST http://localhost:3000/api/v1/auth/verify-email -H "Content-Type: application/json" -d '{
  "email": "meera@example.org", "code": "<6-digit code from the console>" }'
```
Expected: `201`, then `200` with `accessToken` / `refreshToken` (the 100 Sparks are reserved, and the account gets its
referral code). Then create the profile with the Explore nickname as the username (the app pre-fills it):
```bash
curl -s -X POST http://localhost:3000/api/v1/me/profile -H "Authorization: Bearer <accessToken>" -H "Content-Type: application/json" -d '{
  "username": "RadhaPlays", "avatarId": 3, "mode": "sanatan", "country": "US" }'
```
Use the `accessToken` from this answer for the next calls (it has the new profile active).

## 2. POST /me/explore-import
```bash
curl -s -X POST http://localhost:3000/api/v1/me/explore-import -H "Authorization: Bearer <accessToken>" -H "Content-Type: application/json" -d '{
  "avatarId": 3, "mode": "sanatan",
  "sparks":    [ { "txId": "6f1c2a3e-1111-4c1e-9a1b-000000000001", "amount": 10, "reason": "quiz_correct", "at": "2026-10-30T10:00:00Z" } ],
  "purchases": [ { "txId": "6f1c2a3e-1111-4c1e-9a1b-000000000002", "itemId": "flute_gold", "sparks": 5, "at": "2026-10-30T10:05:00Z" } ],
  "scores":    [ { "txId": "6f1c2a3e-1111-4c1e-9a1b-000000000003", "game": "quiz", "itemId": "q1", "score": 7, "at": "2026-10-30T10:06:00Z" } ],
  "progress":  [ { "txId": "6f1c2a3e-1111-4c1e-9a1b-000000000004", "area": "learn", "itemId": "l1", "value": 100, "at": "2026-10-30T10:07:00Z" } ] }'
```
Expected: `200 { "profileId": …, "firstImport": true, "imported": 4, "duplicates": 0, "pending": { "sparks": 1, … } }`.
Nothing is credited: the entries are stored as `pending_import` (verified in Milestone 2/3).
**Same request again** (a retry): `200` with `"imported": 0, "duplicates": 4` (idempotent by `txId`).
Errors: `409 PROFILE_REQUIRED` (no profile yet), `409 EXPLORE_ALREADY_IMPORTED` (a parent importing into a second
child), `403 PARENT_MODE_REQUIRED` (a parent sending `profileId` from a child's session), `400 VALIDATION_ERROR`
(not a UUID, free text instead of a code, more than 200 entries, a time in the future).

## 3. GET /me/referral
```bash
curl -s http://localhost:3000/api/v1/me/referral -H "Authorization: Bearer <accessToken>"
```
Expected: `200 { "code": "K7M2QX", "newUserSparks": 25, "referrerSparks": 50, "windowHours": 48, "counts": { … },
"applied": null, "canApply": true, "applyUntil": "…" }`. The code has 6 characters without 0 / O / 1 / I.

## 4. POST /me/referral/apply
Register and verify a second account (`friend@example.org`) as in step 1; `<friendToken>` is its access token and
`<meeraCode>` is Meera's code from step 3.
```bash
curl -s -X POST http://localhost:3000/api/v1/me/referral/apply -H "Authorization: Bearer <friendToken>" -H "Content-Type: application/json" -d '{
  "code": "<meeraCode>", "deviceId": "test-device-0001" }'
```
Expected: `200 { "applied": { "id": …, "sparks": 25, "status": "reserved" }, "referral": { … "canApply": false } }`.
Meera's `GET /me/referral` then shows `counts.waitingForFirstQuiz: 1` (her +50 waits for the friend's first full quiz).

Each error:

| Case | How | Expected |
|---|---|---|
| `INVALID_CODE` | `"code": "ZZZZZZ"` (or `"ABC10O"`) | `400` |
| `SELF_REFERRAL` | Meera applies `<meeraCode>` with her own token (also: `meera+2@example.org` using Meera's code) | `400` |
| `ALREADY_APPLIED` | the friend applies a code a second time; or a third account sends `"deviceId": "test-device-0001"` again | `409` |
| `WINDOW_EXPIRED` | a new account, then in MySQL `UPDATE accounts SET created_at = NOW() - INTERVAL 49 HOUR WHERE email = 'late@example.org';`, then apply | `403` |
| `REFERRER_LIMIT` | set `maxPerReferrer` to 1 (step 5), then a second new account applies Meera's code | `409` |
| `PARENT_MODE_REQUIRED` | a parent account applies from a child's session | `403` |

## 5. Admin: referral settings and list (Full Admin only)
Log in as a Full Admin (`POST /admin/auth/login`, then `POST /admin/auth/totp/verify` with the authenticator code) to
get `<adminToken>`.
```bash
curl -s http://localhost:3000/api/v1/admin/referrals/settings -H "Authorization: Bearer <adminToken>"

curl -s -X PUT http://localhost:3000/api/v1/admin/referrals/settings -H "Authorization: Bearer <adminToken>" -H "Content-Type: application/json" -d '{
  "newUserSparks": 25, "referrerSparks": 50, "windowHours": 48, "maxPerReferrer": 1 }'

curl -s "http://localhost:3000/api/v1/admin/referrals?status=waiting_for_first_quiz&page=1&pageSize=25" -H "Authorization: Bearer <adminToken>"
```
Expected: `200 { "settings": { … } }` (the change is in the audit log as `referral_settings.updated`;
`"maxPerReferrer": null` = unlimited), and the list with code, referrer / referee usernames (never emails), status
and dates. A Content Editor gets `403` on all three.
