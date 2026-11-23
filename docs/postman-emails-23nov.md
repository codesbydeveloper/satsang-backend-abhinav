# Emails 23 Nov 2026: curl / Postman steps (client wording, logo, 15-minute code)

Base URL `http://localhost:3000/api/v1` (start the server with `npm run dev`; with `MAIL_TRANSPORT=console` every
email's text part is printed in the server console). In Postman: *Import → Raw text* and paste any command below.
New setting: `PUBLIC_BASE_URL` (default `http://localhost:3000`; must be this API's `https://` address in production).
No migration.

What changed (client content, Part A):
- Every email has the official Satsang Spark logo at the top, loaded from `<PUBLIC_BASE_URL>/static/email-logo.png`
  (absolute URL, not base64). The layout is centred, at most 480 px wide (full width on phones), Inter / Arial.
- The verification email and the account deletion email use Loyadham's exact wording, in HTML and plain text.
- Verification and password-reset codes stop working 15 minutes after they are sent (the email says so).

## 1. The logo
```bash
curl -sI http://localhost:3000/static/email-logo.png
```
Expected: `200`, `Content-Type: image/png`, `Cache-Control: public, max-age=604800`,
`Cross-Origin-Resource-Policy: cross-origin`. Open the URL in a browser: the logo, 480 × 240.

## 2. Verification email
```bash
curl -s -X POST http://localhost:3000/api/v1/auth/register -H "Content-Type: application/json" -d '{
  "email": "ravi@example.org", "password": "Secret123", "accountType": "adult", "acceptPrivacyPolicy": true,
  "firstName": "Ravi", "lastName": "Kumar", "gender": "male",
  "profile": { "username": "ravi_k", "avatarId": 3, "dob": "1995-05-01", "mode": "satsang" } }'
```
Expected: `201`. The server console shows
`[mail:console] to=ravi@example.org subject="🙏 Welcome to Satsang Spark – your verification code"` and:
```
🙏 Welcome to Satsang Spark!

We're excited to have you join us!

✨ YOUR VERIFICATION CODE:
482913

⏳ This code expires in 15 minutes.
🔒 Please do not share this code with anyone.

If you didn't request this code, you can safely ignore this email.

— Team Satsang Spark
```
The HTML part: logo, the title big and bold, the label in small caps, the code very large (38 px), bold and
letter-spaced in the code box, the "ignore" line small and grey, then "— Team Satsang Spark".

## 3. The code expires after 15 minutes
```bash
curl -s -X POST http://localhost:3000/api/v1/auth/verify-email -H "Content-Type: application/json" -d '{
  "email": "ravi@example.org", "code": "<code>" }'
```
Within 15 minutes: `200` (logged in). After 15 minutes (or to test now, in MySQL:
`UPDATE email_codes SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 SECOND;`): `400 CODE_INVALID`
"That code is invalid or has expired. Request a new one." `POST /auth/resend-code` `{ "email" }` sends a new
15-minute code. Password-reset codes (`POST /auth/forgot-password`) also expire after 15 minutes.

## 4. Account deletion email
```bash
curl -s -X DELETE http://localhost:3000/api/v1/me -H "Authorization: Bearer <accessToken>" -H "Content-Type: application/json" -d '{
  "password": "Secret123", "confirm": true }'
```
Expected: `200`, and `subject="🙏 Satsang Spark – Account Deletion Confirmation"` with:
```
Hello,

Your Satsang Spark account has been successfully deleted.

All data associated with your account has been permanently deleted, and you have been logged out of all devices.

We're grateful you were part of the Satsang Spark community. Thank you for being with us! 💛

Wishing you all the best.

— Team Satsang Spark
```
The same email is sent when a Full Admin approves a web-page deletion request or deletes the account from the Users page.

## 5. See every email in a browser
```bash
npm run preview:emails
```
Writes `tmp/email-previews/<name>.html` and `<name>.txt` for: verification code, password reset code, account
deleted, admin login code, admin invite, admin sign-in alert (sample data; nothing is sent). Start the API
(`npm run dev`) so the logo loads in the previews.
