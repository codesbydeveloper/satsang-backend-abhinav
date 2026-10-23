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
- [x] Swagger/OpenAPI docs, tests (50)
- [ ] Verified by Abhinav on his machine and merged
- [ ] Deployed to Loyadham's Hostinger (needs Node-capable plan, domain, SMTP details)
## M2 ... M4: see CLAUDE.md
