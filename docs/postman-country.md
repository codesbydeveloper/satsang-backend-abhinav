# Profile country: curl / Postman steps

Base URL `http://localhost:3000/api/v1` (start the server with `npm run dev`). In Postman: *Import → Raw text* and
paste any command below. Run `npm run migrate` first (migration 007).

`country` is an assigned ISO 3166-1 alpha-2 code (`IN`, `US`, `GB`, …; 249 codes in `src/utils/countries.js`).
Lower case is accepted and stored upper case. It is private: returned only in the profile's own views (`GET /me`,
profile responses), never in the username check, leaderboards or Admin Panel lists.

Replace `$TOKEN` with an access token (from verify-email / login / POST /me/profile) and `$ID` with a profile id.

## 1. Independent: Profile setup with a country
```bash
curl -s -X POST http://localhost:3000/api/v1/me/profile -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{
  "username": "Meera_P", "avatarId": 7, "mode": "satsang", "country": "IN" }'
```
Expected: `201`, `profile.country = "IN"`. Without `country`: `201` with `country: null` (older app builds).

## 2. Unknown code
```bash
curl -s -X POST http://localhost:3000/api/v1/me/profile -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{
  "username": "Meera_P", "avatarId": 7, "country": "UK" }'
```
Expected: `400 VALIDATION_ERROR`, `details: [{ "field": "country", "message": "Choose a country or region from the list" }]`
(the United Kingdom is `GB`; `XK`, `EU`, `IND` are refused too).

## 3. Change it later (independent account)
```bash
curl -s -X PATCH http://localhost:3000/api/v1/me/settings -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{
  "country": "gb" }'
```
Expected: `200`, `profile.country = "GB"`. From the parent area: `400 NO_ACTIVE_PROFILE`. From a parent's child:
`403 PARENT_MODE_REQUIRED`.

## 4. Parent: add a child with a country
```bash
curl -s -X POST http://localhost:3000/api/v1/profiles -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{
  "username": "kid_aaa", "avatarId": 2, "dob": "2018-03-01", "parentalConsent": true, "country": "US" }'
```
Expected: `201`, `profile.country = "US"`.

## 5. Parent: change a child's country
```bash
curl -s -X PATCH http://localhost:3000/api/v1/profiles/$ID -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{
  "country": "AU" }'
```
Expected from the parent area: `200`. From the child's own session without `"pin"`: `403 PIN_REQUIRED`; with
`"pin": "1234"`: `200`.

## 6. Read it back
```bash
curl -s http://localhost:3000/api/v1/me -H "Authorization: Bearer $TOKEN"
```
Expected: each profile in `profiles[]` has `country` (or `null`).
