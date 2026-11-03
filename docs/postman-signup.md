# Sign Up: curl / Postman steps

Base URL `http://localhost:3000/api/v1` (start the server with `npm run dev`; with `MAIL_TRANSPORT=console` the
6-digit code is printed in the server console). In Postman: *Import → Raw text* and paste any command below.
Run `npm run migrate` first (migration 006).

## 1. Register: independent ("Just me")
```bash
curl -s -X POST http://localhost:3000/api/v1/auth/register -H "Content-Type: application/json" -d '{
  "accountType": "adult", "dob": "1998-05-05",
  "firstName": "Meera", "lastName": "Patel", "gender": "female",
  "email": "meera@example.org", "password": "Secret123", "acceptPrivacyPolicy": true, "language": "en" }'
```
Expected: `201 { "needsEmailVerification": true, "email": "meera@example.org" }`.

## 2. Register: parent
```bash
curl -s -X POST http://localhost:3000/api/v1/auth/register -H "Content-Type: application/json" -d '{
  "accountType": "parent", "confirmAdult": true,
  "firstName": "Kiran", "lastName": "Shah", "gender": "prefer_not_to_say",
  "email": "kiran@example.org", "password": "Secret123", "acceptPrivacyPolicy": true }'
```
Expected: `201`. Without `"confirmAdult": true`: `400 VALIDATION_ERROR` with `details[].field = "confirmAdult"`.

## 3. Register: under the consent age (13 now)
```bash
curl -s -X POST http://localhost:3000/api/v1/auth/register -H "Content-Type: application/json" -d '{
  "accountType": "adult", "dob": "2020-01-01", "firstName": "R@vi", "email": "kid@example.org" }'
```
Expected: `400 { "error": { "code": "PARENT_ACCOUNT_REQUIRED", "message": "Please ask a parent to create a Parent account for you." } }`
— even though the name, password and privacy fields are wrong or missing (the age gate answers first). Nothing is stored.

## 4. Register: bad name
```bash
curl -s -X POST http://localhost:3000/api/v1/auth/register -H "Content-Type: application/json" -d '{
  "accountType": "adult", "dob": "1998-05-05", "firstName": "Ravi2", "lastName": "", "gender": "other",
  "email": "bad@example.org", "password": "Secret123", "acceptPrivacyPolicy": true }'
```
Expected: `400 VALIDATION_ERROR`, one entry per field in `details`: `firstName` ("Use letters, spaces, - and ' only"),
`lastName` ("Enter a name"), `gender`.
Accepted examples: `Anne-Marie`, `O'Brien`, `D’Souza` (stored as `D'Souza`), `રવિ`, `  Mary Jane  ` (trimmed).

## 5. Verify email (reserves the 100 Sparks)
```bash
curl -s -X POST http://localhost:3000/api/v1/auth/verify-email -H "Content-Type: application/json" -d '{
  "email": "meera@example.org", "code": "123456" }'
```
Use the code from the server console. Expected: `200` with `accessToken`, `refreshToken`, `account`, `profiles`.
The response has no name, gender or bonus (those are in `GET /me` only).

## 6. GET /me
```bash
curl -s http://localhost:3000/api/v1/me -H "Authorization: Bearer <accessToken>"
```
Expected: `account` includes `"firstName": "Meera", "lastName": "Patel", "gender": "female",
"signupBonus": { "sparks": 100, "status": "pending" }`.

## 7. Admin user detail (Full Admin token)
`GET /admin/users/{accountId}` now includes `firstName`, `lastName`, `gender`. The user list (`GET /admin/users`) does not.
