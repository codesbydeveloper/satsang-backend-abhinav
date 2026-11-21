# Student status 21 Nov 2026: curl / Postman steps (Loyadham Online Classes question, admin verification, Sparks)

Base URL `http://localhost:3000/api/v1` (start the server with `npm run dev`). In Postman: *Import → Raw text* and paste
any command below. Run `npm run migrate` first (migration 016). New settings (all optional): `STUDENT_VERIFIED_SPARKS`
(default `10`), `STUDENT_INTEREST_SPARKS` (default `5`), `STUDENT_INTEREST_FORM_URL` (default empty: the app hides the
interest-form button).

What changed:
- During profile setup each profile (an independent account's own profile, and **each child profile separately**)
  answers "Currently enrolled in Loyadham Online Classes (Bals-Balikas or Kishor-Kishori Classes)?".
- `studentStatus` is in every own profile response (`GET /me`, `GET /profiles`, `POST /profiles`, `PATCH /profiles/:id`,
  switch) and in `GET /parent/report` per child. Existing profiles are `not_asked`.
- A Full Admin verifies / rejects / confirms the interest / resets. Sparks go to that exact profile, are reserved until
  the Milestone 2 Sparks ledger credits them, and each reward is given at most once per profile.

| App answer | New status |
|---|---|
| `{ "enrolled": true }` | `pending_verification` |
| `{ "enrolled": false, "interested": true }` | `interested` |
| `{ "enrolled": false, "interested": false }` | `not_enrolled` |

| Admin action | From → to | Sparks |
|---|---|---|
| `verify` | `pending_verification` → `verified` | +10 (`STUDENT_VERIFIED_SPARKS`) |
| `confirm_interest` | `interested` → `interest_confirmed` | +5 (`STUDENT_INTEREST_SPARKS`) |
| `reject` | `pending_verification` → `not_enrolled` | none |
| `reset` | any except `not_asked` → `not_asked` | none taken back |

## 1. Public config: form URL and reward amounts
```bash
curl -s http://localhost:3000/api/v1/meta/config
```
Expected (among the other fields): `"studentInterestFormUrl": "", "studentSparks": { "verified": 10, "interestConfirmed": 5 }`.

## 2. Independent account answers for its own profile
Register + verify an adult (see `postman-signup.md`); `<profileId>` is `profiles[0].id` from the verify response.
```bash
curl -s -X PUT http://localhost:3000/api/v1/profiles/<profileId>/student-status -H "Authorization: Bearer <accessToken>" -H "Content-Type: application/json" -d '{
  "enrolled": true }'
```
Expected: `200 { "profile": { ..., "studentStatus": "pending_verification" } }`.

Not enrolled but interested (the app then shows the form button when `studentInterestFormUrl` is set):
```bash
curl -s -X PUT http://localhost:3000/api/v1/profiles/<profileId>/student-status -H "Authorization: Bearer <accessToken>" -H "Content-Type: application/json" -d '{
  "enrolled": false, "interested": true }'
```
Expected: `"studentStatus": "interested"`. `{ "enrolled": false }` without `interested` → `400 INTERESTED_REQUIRED`.

## 3. Parent answers for each child separately
From the parent area (parent login, no child active), no PIN is needed:
```bash
curl -s -X PUT http://localhost:3000/api/v1/profiles/<childId>/student-status -H "Authorization: Bearer <parent accessToken>" -H "Content-Type: application/json" -d '{
  "enrolled": false, "interested": false }'
```
Expected: `"studentStatus": "not_enrolled"`. From a child's session add `"pin": "1234"`; without it → `403 PARENT_MODE_REQUIRED`.
Another account's profile → `404 PROFILE_NOT_FOUND`.

## 4. Full Admin: the review queues
```bash
curl -s "http://localhost:3000/api/v1/admin/users?studentStatus=pending_verification" -H "Authorization: Bearer <full admin token>"
curl -s "http://localhost:3000/api/v1/admin/users?studentStatus=interested" -H "Authorization: Bearer <full admin token>"
```
Expected: only rows whose profile has that status; every row carries `studentStatus`. `q` still works together with
the filter. The user detail (`GET /admin/users/<accountId>`) shows per profile `studentStatus`,
`studentStatusUpdatedAt`, `studentVerifiedBy`, `studentVerifiedAt`, `studentSparksAwarded`.

## 5. Full Admin: verify (+10 Sparks)
```bash
curl -s -X POST http://localhost:3000/api/v1/admin/profiles/<profileId>/student-status -H "Authorization: Bearer <full admin token>" -H "Content-Type: application/json" -d '{
  "action": "verify" }'
```
Expected: `200 { "profileId": <profileId>, "studentStatus": "verified", "previousStatus": "pending_verification", "sparksAwarded": 10, "studentSparksAwarded": 10 }`.
The app can no longer change it: step 2 now answers `409 STUDENT_STATUS_LOCKED`. Verifying again → `409 INVALID_STUDENT_TRANSITION`.

## 6. Full Admin: confirm an interest (+5) / reject
```bash
curl -s -X POST http://localhost:3000/api/v1/admin/profiles/<profileId>/student-status -H "Authorization: Bearer <full admin token>" -H "Content-Type: application/json" -d '{
  "action": "confirm_interest" }'

curl -s -X POST http://localhost:3000/api/v1/admin/profiles/<profileId>/student-status -H "Authorization: Bearer <full admin token>" -H "Content-Type: application/json" -d '{
  "action": "reject" }'
```
Expected: `interest_confirmed` with `sparksAwarded: 5` (profile must be `interested`); `reject` gives `not_enrolled`
with `sparksAwarded: 0` (profile must be `pending_verification`). Wrong starting status → `409 INVALID_STUDENT_TRANSITION`.

## 7. Full Admin: reset (no double Sparks)
```bash
curl -s -X POST http://localhost:3000/api/v1/admin/profiles/<profileId>/student-status -H "Authorization: Bearer <full admin token>" -H "Content-Type: application/json" -d '{
  "action": "reset" }'
```
Expected: `"studentStatus": "not_asked"`, `studentSparksAwarded` unchanged (nothing taken back). If the profile answers
"enrolled" again and is verified again, the answer is `"sparksAwarded": 0`: the same reward is never given twice.

## 8. Content Editor
The same POST with a Content Editor token → `403 ROLE_FORBIDDEN` (also for `GET /admin/users`).

## 9. Audit log
```bash
curl -s "http://localhost:3000/api/v1/admin/audit-log" -H "Authorization: Bearer <full admin token>"
```
Expected entries: `student.status_set` (by the user: no admin), `student.verified`, `student.rejected`,
`student.interest_confirmed`, `student.reset`, each with `entityType: "profile"`, the profile id and
`{ from, to, ... }` only (no email, username or name).
