# Satsang Spark — project context (read this first)

**Client:** Loyadham (committee). **Developer:** Abhinav (Singh Abhinav Arvind); team: Om Chevli (design, graphics, audio), Dhruv Rathod (testing/QA).
**Deal:** Version 1 for a fixed **$5,000** via Truelancer escrow; start date 11 Oct 2026; about 4 months. Contract: "Satsang_Spark_FINAL_Contract" (v3.4+; Annexure A has the ID pages). Written contract requirements win over mockups.
**The three repos:** `satsang-spark-backend` (Node.js/Express + MySQL), `satsang-spark-admin` (React Admin Panel), `satsang-spark-app` (Unity 6, Android + iOS). They are built together; the backend's `/api-docs` is the contract between them.

## How to work (applies to every task)
1. Work on a branch named `m<N>/<short-topic>` (for example `m1/auth`) and open a pull request. Never push to `main` directly. Abhinav reviews and merges.
2. Build only what the milestone in the contract lists. New ideas are **new scope** (chargeable, needs written approval from Loyadham first) — note them in the PR instead of building them.
3. Every feature needs automated tests where the stack allows, and the tests must pass before the PR is opened. State what was and was not verified.
4. Keep `/api-docs` (backend `src/openapi.js`) in step with every endpoint change; the Admin Panel and the app read it.
5. Never commit secrets, `.env` files, keystores or Apple/Google credentials.
6. Update `MILESTONES.md` checkboxes in the same PR.
7. If the contract is ambiguous, list the question in the PR description rather than guessing silently.

## Contract rules that shape the code
- **Two public modes only:** Sanatan (Hinduism) and Satsang (Loyadham + Swaminarayan). No access codes or per-mode revocation. Languages: English and Gujarati (Gujarati needs a HarfBuzz shaping plugin + a Gujarati OpenType font in Unity).
- **Accounts:** adult/independent (email + password + email verification) and parent accounts that create child profiles (no email/phone, no login of their own). **Player data belongs to the playable profile**: Sparks, Lifetime Sparks, streak, Daily Spin, personal bests, scores, Learn/Quiz progress, Dress Up items, saved Shangars. Referral link/code stays at account level.
- **Parent PIN** protects child-profile management and switching; resettable with the account password.
- **Age groups:** Shishu 0–4; Bals/Balikas A 5–7, B 8–9, C 10–12; Kishors/Kishoris A 13–15, B 16–18; Yuvak/Yuvatis A 19–35; Yuvaks/Yuvatis B 36–55; Vadil 56+. DOB is private; only the username is public.
- **Server is authoritative:** Sparks, purchases, streaks, spin, referrals, leaderboards. Game day = America/New_York (DST-aware); Daily Spin = rolling 24 h. The app must work offline (questions/answers cached encrypted, scores re-verified on sync, unique transaction IDs).
- **Privacy/COPPA/store compliance** is built in from the start; privacy-policy and consent wording come from Loyadham's counsel. Account deletion must be possible in-app and via an external web page.
- **Admin Panel:** roles Full Admin and Content Editor, TOTP 2FA, audit log.
- **Avatars:** 16 fixed (10 animal, 6 human). "Customize Profile Avatar" is Coming Soon (never "Mascot").
- **No hidden access:** no undisclosed admin accounts, backdoors, hard-coded credentials or tracking.
- Any paid dependency is included in the $5,000, except the Block Blast Toolkit ($24.99, reimbursed).

## Milestones (contract Section 11.2)
- **M1 Foundation, Accounts & Access (Month 1):** repo setup, wireframes/design approval, registration & login, avatars, age groups & parent controls, account/profile deletion, Admin Panel foundation (roles/2FA/audit log), privacy/COPPA architecture.
- **M2 Sparks, Dress Up, Home & Audio (Month 2):** Sparks ledger, Dress Up (Thakorji + Krishna), Home tab, audio/music, related admin sections.
- **M3 Learn, Quizzes, Puzzles & Bhakti Blast (Month 3):** Learn tab, Quizzes (200–350 questions), Puzzles (Guess the Difference, Jigsaw, Word Search), Bhakti Blast, related admin sections.
- **M4 Cricket Quest, Sync & QA (Month 4):** Cricket Quest, offline/online sync, device-compatibility pass, remaining admin sections, QA/UAT. Then production builds and store release (both stores).
Payments release only on approval of each milestone (see contract 11.1).

## This repo: satsang-spark-backend
- Node 20+, Express 5, MySQL 8 (mysql2), JWT, zod validation, Swagger at `/api-docs`.
- Read `README.md` (setup, design decisions) before changing anything.
- Run tests with `npm test` against a database whose name ends in `_test` (tests wipe tables). New profile-owned tables must use `ON DELETE CASCADE` on `profile_id`.
- Schema changes are new numbered files in `db/migrations/`; never edit an applied migration.
- Next up after M1: Sparks ledger + transactions (M2), question bank + quizzes (M3), sync endpoints (M4).
