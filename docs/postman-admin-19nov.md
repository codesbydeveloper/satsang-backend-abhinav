# Admin changes 19 Nov 2026: curl / Postman steps (deletion confirmation email, 30-day retained email)

Base URL `http://localhost:3000/api/v1` (start the server with `npm run dev`; with `MAIL_TRANSPORT=console` every
email is printed in the server console). In Postman: *Import → Raw text* and paste any command below.
Run `npm run migrate` first (migration 012 retained email). New setting: `RETAINED_EMAIL_DAYS` (default `30`).

What changed (client approved):
- When an account deletion completes (in the app, or a Full Admin approves a web-page request, or deletes from the
  Users page), the owner gets the email **"Your Satsang Spark account has been deleted"**. A parent account's email goes
  to the parent (child profiles have no email). If sending fails, the error is logged and the deletion still completes.
- The deleted account's email is kept on its deletion request for `RETAINED_EMAIL_DAYS` days, and **only Full Admins**
  see it (a Users-page delete of an account with no deletion request leaves no request row, so nothing is kept
  there). After that the API returns `email: null` and the purge job erases it (server start, every 24 hours, and
  `npm run purge:retained-emails`). Nothing else personal is kept.

## 1. Delete an account in the app → confirmation email
Register + verify an adult (see `postman-signup.md`), then:
```bash
curl -s -X DELETE http://localhost:3000/api/v1/me -H "Authorization: Bearer <accessToken>" -H "Content-Type: application/json" -d '{
  "password": "Secret123", "confirm": true }'
```
Expected: `200 { "deleted": true, "profilesDeleted": 1 }`. The server console shows
`[mail:console] to=<email> subject="Your Satsang Spark account has been deleted"` with the text
"Your account has been successfully removed. Everything linked to it has been deleted and you have been logged out on
every device. Thank you for being part of Satsang Spark."

## 2. Web-page request approved by a Full Admin → email to the parent
```bash
curl -s -X POST http://localhost:3000/api/v1/public/delete-account -H "Content-Type: application/json" -d '{
  "email": "parent@example.org", "password": "Secret123", "confirm": true }'

curl -s -X POST http://localhost:3000/api/v1/admin/deletion-requests/<requestId>/approve -H "Authorization: Bearer <full admin token>" -H "Content-Type: application/json" -d '{
  "confirm": true }'
```
Expected: `202` (no email yet: the request is only pending), then `200 { "status": "completed", ... }` and one email to
`parent@example.org`.

## 3. Deletion requests list (Completed tab): the retained email
```bash
curl -s "http://localhost:3000/api/v1/admin/deletion-requests?status=completed" -H "Authorization: Bearer <full admin token>"
```
Expected for a deletion in the last 30 days: `rows[].email` = the deleted account's email and
`rows[].emailRetainedUntil` = the UTC date it will be erased (deletion time + 30 days). `username` stays `null`.
Older rows (or rows with no email kept): `email: null`, `emailRetainedUntil: null`.
Pending / rejected rows are unchanged: `email` is the live account email and `emailRetainedUntil` is `null`.
The Admin Panel can show "— (account deleted)" only when `email` is `null`.

## 4. Deletion request detail
```bash
curl -s http://localhost:3000/api/v1/admin/deletion-requests/<requestId> -H "Authorization: Bearer <full admin token>"
```
Expected for a completed request within 30 days: `request.email` and `request.emailRetainedUntil` as above;
`account: null` and `profiles: []` as before.

## 5. Content Editor
```bash
curl -s "http://localhost:3000/api/v1/admin/deletion-requests?status=completed" -H "Authorization: Bearer <content editor token>"
```
Expected: `403 ROLE_FORBIDDEN`. Content Editors never see any email.

## 6. After 30 days
To try it without waiting, in MySQL: `UPDATE account_deletion_requests SET email_retained_until = UTC_TIMESTAMP() - INTERVAL 1 DAY WHERE id = <requestId>;`
Step 3 then shows `email: null` straight away. Run the purge:
```bash
npm run purge:retained-emails
```
Expected: `Erased 1 retained email(s).`; the row's `email_retained` is now `NULL`, and the audit log has one
`retained_emails.purged` entry with `details: { "count": 1 }` (no emails). A run that erases nothing writes no entry.
On cPanel, add a daily cron job: `cd <app folder> && npm run purge:retained-emails`.
