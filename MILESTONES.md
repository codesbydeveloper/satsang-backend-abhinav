# Milestone checklist — backend
## M1
- [x] Schema: accounts, profiles, avatars, sessions, email codes, blocked words, admins, audit log, daily activity
- [x] Register / verify email / login / refresh / logout / password reset & change
- [x] Child profiles, 16 avatars, age groups, usernames + moderation list
- [x] Parent PIN (lock, reset), profile switching, parent report (time)
- [x] Account & profile deletion + public deletion endpoint
- [x] Admin: roles, TOTP 2FA, audit log, user search, age-group override, admin account deletion
- [x] Admin dashboard endpoint (live totals, age groups, registrations chart, mode/language, recent sign-ups, recent admin activity)
- [x] Account deletion requests: app and web requests queue for a Full Admin to approve (deletes) or reject; list/tabs/search/view endpoints
- [x] Independent accounts: date of birth first at register (neutral age gate, nothing stored under the consent age), `POST /me/profile` for the username/avatar later (migration 004)
- [x] Refresh moves an independent session that has no active profile into the account's own profile (recovery after `409 PROFILE_EXISTS`, e.g. profile created on another device) — branch `m1/profile-setup`
- [x] Parent features (branch `m1/parent`): `POST /me/active-profile` (PIN when leaving a child: to a sibling or the parent area; none from the parent area), `POST /me/activity/heartbeat` (beats counted once per minute into the America/New_York day, ≤ 24 h back; migration 005), `GET /me/children/{id}/activity?days=7`, `POST /parent/pin/change`, PIN set without the password from the parent area, 5 wrong PINs → locked 5 min with `attemptsLeft` / `retryAfterSeconds`, first child before the PIN, username edit for children (parent only)
- [x] Child safety (contract 3.3): from a child's own session, `PATCH /profiles/{id}` changes only the avatar (path / language without the PIN → 403 `PIN_REQUIRED`), and `PATCH /me` is refused (403 `PARENT_MODE_REQUIRED`); the parent area is unchanged
- [x] Swagger/OpenAPI docs, tests (58)
- [ ] Verified by Abhinav on his machine and merged
- [ ] Deployed to Loyadham's Hostinger (needs Node-capable plan, domain, SMTP details)
## M2 ... M4: see CLAUDE.md
