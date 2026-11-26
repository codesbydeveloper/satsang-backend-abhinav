# Home tab backend (Milestone 2, chunk 2.3A): curl / Postman steps

Base URL `http://localhost:3000/api/v1` (start the server with `npm run dev`). In Postman: *Import → Raw text* and paste
any command below. Run `npm run migrate` first: **021** adds the spin wheel and spins, the streak amounts and streaks,
news and feedback. Optional setting: `DONATE_URL` (Loyadham's official donation page; empty = the Donate button is
hidden).

Rules:
- Server time only, never the device's clock. Both rewards go through the Sparks ledger (types `daily_spin` and
  `streak`) with the app's `transactionId` (a UUID). The same id again returns the first result (`duplicate: true`)
  and pays nothing; an id already used for another Sparks transaction gets 409 `TRANSACTION_ID_CONFLICT`.
- Reading spin or streak follows the Sparks rules (own profile; a parent sees each child from the parent area).
  Spinning, checking in and claiming are only for the profile **playing on this device** (otherwise 403
  `PROFILE_NOT_ACTIVE`): a parent in the parent area cannot spin or keep a streak for a child.
- Built-in wheel and streak amounts are placeholders **to be confirmed by Loyadham** (`isDefault: true` in the admin
  API until a Full Admin saves their own).

Log in as an adult first (see `postman-signup.md`). `<profileId>` is `profiles[0].id` and `<token>` is the
`accessToken`.

## 1. Daily Spark Spin
```bash
curl -s http://localhost:3000/api/v1/profiles/<profileId>/spin -H "Authorization: Bearer <token>"
```
Expected: `{ profileId, available: true, nextAvailableAt, lastSpinAt: null, segments: [{ index: 0, label: "5 Sparks", sparks: 5 }, …] }`.
The app gets no weights.

```bash
curl -s -X POST http://localhost:3000/api/v1/profiles/<profileId>/spin -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{ "transactionId": "7b0f3c1e-5d0a-4c55-9a51-2f6d8f0e1a01" }'
```
Expected: 201 `{ duplicate: false, segmentIndex, label, reward, spunAt, nextAvailableAt (spunAt + 24 h), balance: { balance, … } }`.
The server picks the segment.
- The same request again returns 200 with the same result and `duplicate: true`; nothing is paid twice.
- A new `transactionId` before 24 h returns 409 `SPIN_NOT_AVAILABLE` with `details.nextAvailableAt`.
- Rolling 24 h, not calendar days: a new day in New York does not reset it.
- An unclaimed spin never expires. A profile that hasn't spun for 3 days can spin at once, and its next spin is
  24 h after that.
- To test "available again" by hand: `UPDATE daily_spins SET spun_at = spun_at - INTERVAL 24 HOUR WHERE profile_id = <profileId>;`

## 2. Streak Bonus
```bash
curl -s http://localhost:3000/api/v1/profiles/<profileId>/streak -H "Authorization: Bearer <token>"
curl -s -X POST http://localhost:3000/api/v1/profiles/<profileId>/streak/check-in -H "Authorization: Bearer <token>"
```
Expected after the check-in: `{ counted: true, added: 5, currentStreak: 1, unclaimed: 5, lastActiveDay: "<today in New York>", checkedInToday: true, nextDayBonus: 10, gameTimeZone: "America/New_York", amounts: [5,10,15,20,25,30,50] }`.
- Checking in again the same game day returns `counted: false`.
- `POST /me/activity/heartbeat` and `POST /profiles/activity` count today too.
- Game days run from midnight to midnight America/New_York: 05:00 UTC in winter and 04:00 UTC in summer.
- The next game day gives streak 2 and unclaimed 15 (5 + 10). Days after the last configured day use the last amount.
- If a game day is missed, `GET` shows `currentStreak: 0, unclaimed: 0, lostUnclaimed: <what was lost>`. The next
  check-in starts again at 1.

```bash
curl -s -X POST http://localhost:3000/api/v1/profiles/<profileId>/streak/claim -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{ "transactionId": "c2d9a3b4-0e8f-4a1b-8c7d-6e5f4a3b2c01" }'
```
Expected: 201 `{ duplicate: false, claimed: 5, currentStreak: 1, unclaimed: 0, balance: { … } }`.
- Claiming resets only the unclaimed amount; the streak keeps counting.
- The same id again returns 200 `duplicate: true`.
- A new id with nothing to claim returns 409 `NOTHING_TO_CLAIM`.

To test the next day by hand, move the streak back one day:
`UPDATE profile_streaks SET last_active_day = last_active_day - INTERVAL 1 DAY WHERE profile_id = <profileId>;`
To see a broken streak, move it back two days.

## 3. News & Updates (app, public)
```bash
curl -s "http://localhost:3000/api/v1/news?page=1&pageSize=20"
```
Expected: `{ page, pageSize, total, items: [{ id, title: { en, gu }, body: { en, gu }, imageUrl, publishAt, pinned }] }`.
- It lists only active items whose publish date has passed: pinned first, then newest first.
- `gu` is `null` when no Gujarati text was written; the app then shows English.

## 4. Feedback (app)
```bash
curl -s -X POST http://localhost:3000/api/v1/feedback -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{
  "profileId": <profileId>, "category": "bug", "message": "The quiz froze on question 3", "appVersion": "1.0.3", "device": "Pixel 7, Android 15" }'
```
Expected: 201 `{ id, received: true }`.
- `category` must be `bug`, `idea` or `other`, and `message` 1–1000 characters; anything else returns 400.
- Another account's profile returns 404.
- From a child's session, a sibling returns 403 `PARENT_MODE_REQUIRED`.
- More than 5 per hour or 20 per day for one account returns 429 `FEEDBACK_RATE_LIMITED`. There is also a limit per
  IP address.

## 5. App config
```bash
curl -s http://localhost:3000/api/v1/meta/config
```
Expected, among the other fields: `donateUrl` (`""` = hide the Donate button) and
`features: { leaderboards: "coming_soon", customizeAvatar: "coming_soon" }`.

## 6. Admin: spin wheel, streak amounts, donate URL (Full Admin)
Log in as an admin (`postman-admin-19nov.md`). A Content Editor gets 403 on all of these.
```bash
curl -s http://localhost:3000/api/v1/admin/home/spin-segments -H "Authorization: Bearer <adminToken>"
curl -s -X PUT http://localhost:3000/api/v1/admin/home/spin-segments -H "Authorization: Bearer <adminToken>" -H "Content-Type: application/json" -d '{
  "segments": [ { "label": "10 Sparks", "sparks": 10, "weight": 60 }, { "label": "25 Sparks", "sparks": 25, "weight": 30 }, { "label": "100 Sparks", "sparks": 100, "weight": 10 } ] }'
```
- The response shows each segment's `weight` and `chancePercent`.
- The wheel needs 2–12 segments, 1–10000 Sparks each, weight 1–1000. Saving replaces the whole wheel.
- Audit: `spin.segments_changed { from, to }`. Spins already made keep what they won.

```bash
curl -s http://localhost:3000/api/v1/admin/home/streak-bonus -H "Authorization: Bearer <adminToken>"
curl -s -X PUT http://localhost:3000/api/v1/admin/home/streak-bonus -H "Authorization: Bearer <adminToken>" -H "Content-Type: application/json" -d '{ "amounts": [5, 10, 15, 20, 25, 30, 50] }'
```
- `amounts[N-1]` is what streak day N adds: 1–30 values, 0–10000 each.
- Audit: `streak.amounts_changed { from, to }`.

```bash
curl -s -X PUT http://localhost:3000/api/v1/admin/home/donate-url -H "Authorization: Bearer <adminToken>" -H "Content-Type: application/json" -d '{ "donateUrl": "https://<loyadham-official-donation-page>" }'
```
- The value must be an http(s) address or `""` (hides the button). A saved value wins over `DONATE_URL`.
- Audit: `donate_url.changed { from, to }`.

## 7. Admin: News (Full Admin and Content Editor)
```bash
curl -s -X POST http://localhost:3000/api/v1/admin/news -H "Authorization: Bearer <adminToken>" -H "Content-Type: application/json" -d '{
  "titleEn": "Diwali Sabha", "titleGu": "દિવાળી સભા", "bodyEn": "Join us …", "bodyGu": "…",
  "imageUrl": "https://cdn.example.org/diwali.png", "publishAt": "2026-11-28T14:00:00Z", "pinned": true }'
curl -s "http://localhost:3000/api/v1/admin/news?status=scheduled" -H "Authorization: Bearer <adminToken>"
curl -s -X PATCH http://localhost:3000/api/v1/admin/news/<id> -H "Authorization: Bearer <adminToken>" -H "Content-Type: application/json" -d '{ "pinned": false }'
curl -s -X DELETE http://localhost:3000/api/v1/admin/news/<id> -H "Authorization: Bearer <adminToken>"
```
- Only the English title and body are required. `imageUrl` must be https.
- If `publishAt` is left out it is now; a future `publishAt` makes the item scheduled. `active` defaults to true.
- List filters: `status` = `all`, `published`, `scheduled` or `inactive`, and `q` searches titles and bodies.
- Audit: `news.created`, `news.updated` (from → to; body texts are recorded only as "changed"), `news.deleted`.

## 8. Admin: Feedback (Full Admin)
```bash
curl -s "http://localhost:3000/api/v1/admin/feedback?status=open&category=bug&q=quiz" -H "Authorization: Bearer <adminToken>"
curl -s -X PATCH http://localhost:3000/api/v1/admin/feedback/<id> -H "Authorization: Bearer <adminToken>" -H "Content-Type: application/json" -d '{ "status": "resolved", "note": "Fixed in 1.0.4" }'
```
- The list shows the username, never the email or DOB, and `openCount` for a badge.
- `q` matches the message or the username, and `#12` finds feedback 12.
- Audit: `feedback.resolved` / `feedback.reopened`.
