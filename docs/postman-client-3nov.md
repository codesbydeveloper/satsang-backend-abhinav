# Client changes 3 Nov 2026: curl / Postman steps (avatar names, content language)

Base URL `http://localhost:3000/api/v1` (start the server with `npm run dev`; with `MAIL_TRANSPORT=console` the
6-digit code is printed in the server console). In Postman: *Import → Raw text* and paste any command below.
Run `npm run migrate` first (migrations 010 avatar names, 011 content language).

## 1. GET /avatars: the 16 client avatars
```bash
curl -s http://localhost:3000/api/v1/avatars
```
Expected: `200`, 16 avatars by id. Ids 1–10 `kind: "animal"`: shadow, frosty, waddles, turbo, blaze, zippy, bamboo, ace,
mango, coco. Ids 11–16 `kind: "human"`: young_boy, young_man, gentleman, young_girl, young_woman, lady. `label` is the
English name (Shadow … Lady). Profiles keep their avatar ids.

## 2. Sign Up (Just me) with a content language
The app's 4 steps send the same calls as before; step 4 adds `contentLanguage` to `POST /me/profile`.
```bash
curl -s -X POST http://localhost:3000/api/v1/auth/register -H "Content-Type: application/json" -d '{
  "accountType": "adult", "dob": "1998-05-05",
  "firstName": "Karan", "lastName": "Shah", "gender": "male",
  "email": "karan@example.org", "password": "Secret123", "acceptPrivacyPolicy": true, "language": "en" }'

curl -s -X POST http://localhost:3000/api/v1/auth/verify-email -H "Content-Type: application/json" -d '{
  "email": "karan@example.org", "code": "<6-digit code from the console>" }'

curl -s -X POST http://localhost:3000/api/v1/me/profile -H "Authorization: Bearer <accessToken>" -H "Content-Type: application/json" -d '{
  "username": "KaranPlays", "avatarId": 5, "mode": "satsang", "country": "IN", "contentLanguage": "gu" }'
```
Expected: `201`, `profile.language: "en"` (the app language, unchanged) and `profile.contentLanguage: "gu"`. Use the new
`accessToken` from this answer below. Without `contentLanguage` the profile gets the app language.
`contentLanguage` other than `en` / `gu` → `400 VALIDATION_ERROR` (field `contentLanguage`).

## 3. GET /me returns it
```bash
curl -s http://localhost:3000/api/v1/me -H "Authorization: Bearer <accessToken>"
```
Expected: `profiles[0].contentLanguage: "gu"`, `account.language: "en"`.

## 4. Settings: change the content language only
```bash
curl -s -X PATCH http://localhost:3000/api/v1/me/settings -H "Authorization: Bearer <accessToken>" -H "Content-Type: application/json" -d '{
  "contentLanguage": "en" }'
```
Expected: `200`, `profile.contentLanguage: "en"`, `account.language` and `profile.language` unchanged.
`{ "language": "gu" }` still changes the app language (account + profile) and leaves `contentLanguage` alone.
A parent in the parent area (no active profile): `400 NO_ACTIVE_PROFILE`; from a child's session: `403 PARENT_MODE_REQUIRED`.

## 5. A child's content language (parent)
Register + verify a parent (`"accountType": "parent", "confirmAdult": true`, no `dob`), then:
```bash
curl -s -X POST http://localhost:3000/api/v1/profiles -H "Authorization: Bearer <parent accessToken>" -H "Content-Type: application/json" -d '{
  "username": "kid_karan", "avatarId": 2, "dob": "2018-03-01", "contentLanguage": "gu", "country": "IN", "parentalConsent": true }'

curl -s -X PATCH http://localhost:3000/api/v1/profiles/<childId> -H "Authorization: Bearer <parent accessToken>" -H "Content-Type: application/json" -d '{
  "contentLanguage": "en" }'
```
Expected: `201` with `profile.contentLanguage: "gu"` (and `language` = the parent's app language), then `200` with `"en"`.
From the child's own session without `pin`: `403 PIN_REQUIRED`; with `"pin": "1234"`: `200`.
