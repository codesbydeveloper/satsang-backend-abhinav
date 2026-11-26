# Sparks Economy core ledger (Milestone 2, chunk 2.1): curl / Postman steps

Base URL `http://localhost:3000/api/v1` (start the server with `npm run dev`). In Postman: *Import → Raw text* and paste
any command below. Run `npm run migrate` first: **019** creates the ledger, the balances and the reward config;
**020** moves the Sparks reserved in Milestone 1 into the ledger (safe to run again: it never doubles anything).

What changed:
- Every Sparks movement is a row in `sparks_transactions` for ONE playable profile (an independent account's own
  profile, or one child). Nothing is pooled across a parent account. Each profile has a balance row
  (`profile_sparks`): `balance`, `lifetimeEarned`, `lifetimeSpent`, `pending`, kept equal to the ledger inside a
  row-locked DB transaction.
- `transactionId` is unique: the same id again is processed once (`duplicate: true`); the same id for something else
  is 409 `TRANSACTION_ID_CONFLICT`. The balance can never go below zero: 409 `INSUFFICIENT_SPARKS`
  (`details: { balance, needed }`).
- Spending never lowers `lifetimeEarned` (leaderboards). A negative admin adjustment is a correction: it lowers the
  balance and `lifetimeEarned`.
- Rewards that were "reserved" in Milestone 1 now go straight into the ledger:

| Reward | Type | Transaction id | Status |
|---|---|---|---|
| Sign-up 100 (once per account) | `signup_bonus` | `signup_bonus-account-<accountId>` | verified |
| Student verified (+10) | `student_verified` | `student_verified-<profileId>` | verified |
| Class interest confirmed (+5) | `student_interest` | `student_interest_confirmed-<profileId>` | verified |
| Explore Sparks entries | `explore_import` | the device's UUID `txId` | verified |
| Referral, new user (+25) | `referral` | `referral-new-<referralId>` | verified at once |
| Referral, referrer (+50) | `referral` | `referral-referrer-<referralId>` | **pending** until the new user's first completed quiz (Milestone 3), then verified |

- Account-level rewards (sign-up, referrals) go to the account's **first playable profile** (own profile, or a
  parent's first child). While an account has no profile (a parent before the first child) they wait and are
  credited when the first profile is created. *Question for Loyadham: is the first child right?*
- `sparksBalance` is in every own profile response (`GET /me`, `GET /profiles`, login/verify, `POST /profiles`,
  `PATCH /profiles/:id`, switch, active-profile) and `GET /parent/report` has `sparks` per child.

## 1. Balance of my profile
Register + verify an adult (see `postman-signup.md`); `<profileId>` is `profiles[0].id`.
```bash
curl -s http://localhost:3000/api/v1/profiles/<profileId>/sparks -H "Authorization: Bearer <accessToken>"
```
Expected: `{ "profileId": 1, "balance": 100, "lifetimeEarned": 100, "lifetimeSpent": 0, "pending": 0 }` (the sign-up bonus).

## 2. History (newest first, paged)
```bash
curl -s "http://localhost:3000/api/v1/profiles/<profileId>/sparks/history?page=1&pageSize=25" -H "Authorization: Bearer <accessToken>"
curl -s "http://localhost:3000/api/v1/profiles/<profileId>/sparks/history?status=pending" -H "Authorization: Bearer <accessToken>"
```
Expected: `{ profileId, page, pageSize, total, items: [{ id, transactionId: "signup_bonus-account-1", amount: 100, type: "signup_bonus", status: "verified", reference, createdAt, verifiedAt, reversedAt }] }`.
Admin notes and admin ids are never in the app's history.

## 3. Parent: each child separately
From the parent area (after a password login, or `POST /me/active-profile { "profileId": null, "pin": "1234" }`):
```bash
curl -s http://localhost:3000/api/v1/profiles/<childId>/sparks -H "Authorization: Bearer <parentToken>"
curl -s http://localhost:3000/api/v1/parent/report -H "Authorization: Bearer <parentToken>"
```
The first child shows 100 (the account's sign-up bonus); a second child starts at 0. From a child's session
(`POST /profiles/<childId>/switch`) the sibling's Sparks → 403 `PARENT_MODE_REQUIRED`. Another account's profile → 404.

## 4. Referral stays pending until the first quiz
Account A shares its code (`GET /me/referral`), new account B applies it (`POST /me/referral/apply { "code": "…" }`).
- B: `GET /profiles/<B profile>/sparks` → `balance` 125 (100 + 25).
- A: `GET /profiles/<A profile>/sparks` → `balance` 100, `pending` 50.
- When B completes the first full quiz (Milestone 3 calls `onFirstQuizCompleted`), A's pending 50 becomes verified
  (`balance` 150, `pending` 0) and the referral status becomes `credited`.

## 5. Admin: balance and history of a profile (Full Admin)
Log in as an admin (`postman-admin-19nov.md`).
```bash
curl -s http://localhost:3000/api/v1/admin/profiles/<profileId>/sparks -H "Authorization: Bearer <adminToken>"
curl -s "http://localhost:3000/api/v1/admin/profiles/<profileId>/sparks/history?type=admin_adjust&page=1&pageSize=25" -H "Authorization: Bearer <adminToken>"
```
The admin history also has `note`, `createdBy`, `reversedBy`, `reversedReason`. Content Editor → 403.

## 6. Admin: adjust (reason required, audited)
```bash
curl -s -X POST http://localhost:3000/api/v1/admin/profiles/<profileId>/sparks/adjust -H "Authorization: Bearer <adminToken>" -H "Content-Type: application/json" -d '{
  "amount": 50, "reason": "Satsang sabha prize", "transactionId": "adj-2026-11-26-1" }'
```
Expected: 201 `{ duplicate: false, transaction: { type: "admin_adjust", amount: 50, note: "Satsang sabha prize", createdBy: <adminId>, … }, balance: 150, … }`.
The same request again → 200 `duplicate: true` (not audited again). `{ "amount": -1000, "reason": "Correction" }` → 409
`INSUFFICIENT_SPARKS`. No reason / amount 0 → 400. Audit log: `sparks.adjusted` with `{ amount, reason, transactionId, balanceAfter }`.

## 7. Admin: reward config per activity and age group
```bash
curl -s http://localhost:3000/api/v1/admin/sparks/config -H "Authorization: Bearer <adminToken>"
curl -s -X PUT http://localhost:3000/api/v1/admin/sparks/config -H "Authorization: Bearer <adminToken>" -H "Content-Type: application/json" -d '{
  "rewards": [ { "activity": "game", "ageGroup": "Vadil", "sparks": 7 } ] }'
```
Activities: `quiz`, `game`, `puzzle`, `learn`; age groups: the 9 keys listed in the GET response's `ageGroups`. Seeded
defaults (**to be confirmed by Loyadham**, `isDefault: true`):

| Age groups | Quiz | Game | Puzzle | Learn |
|---|---|---|---|---|
| Shishu … Kishors/Kishoris B (≤ 18) | 20 | 15 | 5 | 10 |
| Yuvaks/Yuvatis A, B, Vadil (19+) | 20 | 5 | 15 | 10 |

PUT is a partial update (only the rows sent change; 0–10000; each activity + age group once). Response `changed`
lists `{ activity, ageGroup, from, to }`; audit `sparks.config_changed` with the same list. Content Editor → 403.
The Milestone 3/4 activities read it with `rewardFor(activity, ageGroup)` (`src/services/sparks.js`).

## 8. Migration check (database)
```sql
SELECT type, status, COUNT(*), SUM(amount) FROM sparks_transactions GROUP BY type, status;
SELECT status, COUNT(*) FROM signup_bonuses GROUP BY status;          -- 'pending' only for accounts without a profile
SELECT status, COUNT(*) FROM profile_sparks_rewards GROUP BY status;  -- all 'credited'
```
Running `020_sparks_backfill_reserved.sql` again by hand gives the same numbers.
