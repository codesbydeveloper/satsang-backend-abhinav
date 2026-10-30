// OpenAPI 3 description of the Milestone 1 API. Served at /api-docs (Swagger UI) and /api-docs.json
// (importable into Postman). Keep this file in step with the routes when endpoints change.
const json = (schema) => ({ 'application/json': { schema } });
const body = (schema, required = true) => ({ required, content: json(schema) });
const ok = (description, schema) => ({ description, ...(schema ? { content: json(schema) } : {}) });
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const obj = (properties, required) => ({ type: 'object', properties, ...(required ? { required } : {}) });
const str = (extra = {}) => ({ type: 'string', ...extra });
const int = (extra = {}) => ({ type: 'integer', ...extra });
const bool = () => ({ type: 'boolean' });
const idParam = { name: 'id', in: 'path', required: true, schema: int() };
const errors = (...codes) => Object.fromEntries(codes.map((c) => [String(c), { description: { 400: 'Validation or business-rule error', 401: 'Not logged in / wrong credentials', 403: 'Not allowed', 404: 'Not found', 409: 'Conflict', 429: 'Too many attempts' }[c], content: json(ref('Error')) }]));
const user = [{ userBearer: [] }];
const admin = [{ adminBearer: [] }];
const adminStep = [{ adminBearer: [] }];

const op = (tag, summary, o = {}) => ({ tags: [tag], summary, ...o });

module.exports = {
  openapi: '3.0.3',
  info: {
    title: 'Satsang Spark API',
    version: '1.0.0 (Milestone 1)',
    description: [
      'Backend for the Satsang Spark mobile app and Admin Panel.',
      '',
      '**Milestone 1 covers:** registration/login with email verification, password reset, adult and parent accounts, playable (child) profiles, 16 fixed avatars, DOB-based age groups, Parent PIN, account/profile deletion, and the Admin Panel foundation (Full Admin / Content Editor roles, TOTP 2FA, audit log).',
      '',
      '**Conventions:** all paths are under `/api/v1`. Errors look like `{ "error": { "code", "message", "details?" } }`. Dates of birth are `YYYY-MM-DD` and are never returned for other users. Server time is authoritative; game days use America/New_York.',
      '',
      '**Users:** log in, then send `Authorization: Bearer <accessToken>`. Renew with `/auth/refresh`. **Admins:** three steps — `/admin/auth/login` (password) → `/admin/auth/totp/verify` (or `/totp/setup` + `/totp/enable` the first time) → send the returned token as `Authorization: Bearer`.',
    ].join('\n'),
  },
  servers: [{ url: '/api/v1' }],
  tags: [
    { name: 'Meta' }, { name: 'Auth' }, { name: 'Account' }, { name: 'Profiles' }, { name: 'Parent PIN' },
    { name: 'Admin Auth' }, { name: 'Admin Management' }, { name: 'Admin Users' }, { name: 'Admin Moderation' }, { name: 'Admin Audit' }, { name: 'Admin Dashboard' }, { name: 'Admin Deletion Requests' }, { name: 'Referrals' }, { name: 'Admin Referrals' },
  ],
  components: {
    securitySchemes: {
      userBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'App access token from login / verify-email / refresh.' },
      adminBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Admin token from the 2FA step (the step tokens from /admin/auth/login are only accepted by the TOTP endpoints).' },
    },
    schemas: {
      Error: obj({ error: obj({ code: str(), message: str(), details: { description: 'VALIDATION_ERROR: [{ field, message }]. PIN_INCORRECT: { attemptsLeft }. PIN_LOCKED: { retryAfterSeconds }.', oneOf: [{ type: 'array', items: obj({ field: str(), message: str() }) }, obj({ attemptsLeft: int(), retryAfterSeconds: int() })] } }) }),
      Profile: obj({
        id: int(), username: str(), avatarId: int({ minimum: 1, maximum: 16 }), ageGroup: str({ example: 'Bals/Balikas B' }),
        isChild: bool(), language: str({ enum: ['en', 'gu'] }), mode: str({ enum: ['sanatan', 'satsang'], nullable: true }),
        dob: str({ format: 'date', description: 'Only returned to the profile’s own account.' }),
        country: { ...ref('CountryCode'), nullable: true, description: 'Private: only returned to the profile’s own account (never on leaderboards or public views). Null for profiles created before Profile setup asked for it.' },
        createdAt: str(),
      }),
      ReferralView: obj({
        code: str({ example: 'K7P2QX' }), newUserSparks: int(), referrerSparks: int(), windowHours: int(),
        counts: obj({ total: int(), waitingForFirstQuiz: int(), qualified: int(), sparksPending: int() }),
        applied: { ...obj({ code: str(), sparks: int(), status: str({ enum: ['reserved', 'credited'] }) }), nullable: true },
        canApply: bool(), applyUntil: str({ format: 'date-time' }),
      }),
      ReferralSettings: obj({
        newUserSparks: int({ minimum: 0, example: 25 }), referrerSparks: int({ minimum: 0, example: 50 }),
        windowHours: int({ minimum: 1, example: 48 }), maxPerReferrer: int({ minimum: 1, nullable: true, description: 'null = unlimited' }),
      }),
      CountryCode: str({ pattern: '^[A-Z]{2}$', example: 'IN', description: 'Country / region: an assigned ISO 3166-1 alpha-2 code (lower case is accepted and stored upper case). Anything else: 400 `VALIDATION_ERROR` on `country`.' }),
      Account: obj({ id: int(), email: str(), accountType: str({ enum: ['adult', 'parent'] }), phone: str({ nullable: true }), language: str({ enum: ['en', 'gu'] }), emailVerified: bool(), parentPinSet: bool() }),
      AccountOwnerView: {
        description: 'GET /me only: the Account plus the owner’s private Sign Up details and the reserved sign-up bonus. Never in login/refresh responses, other users’ views or admin lists.',
        allOf: [ref('Account'), obj({
          firstName: str({ nullable: true, description: 'Private. Null for accounts created before Sign Up asked for it.' }),
          lastName: str({ nullable: true, description: 'Private.' }),
          gender: str({ enum: ['male', 'female', 'prefer_not_to_say'], nullable: true, description: 'Private.' }),
          signupBonus: { ...obj({ sparks: int({ example: 100 }), status: str({ enum: ['pending', 'credited'], description: 'pending = reserved at email verification; credited to the Sparks ledger in Milestone 2' }) }), nullable: true },
        })],
      },
      AuthResponse: obj({ accessToken: str(), refreshToken: str(), account: ref('Account'), profiles: { type: 'array', items: ref('Profile') }, activeProfileId: int({ nullable: true }) }),
      Admin: obj({ id: int(), email: str(), name: str(), role: str({ enum: ['full_admin', 'content_editor'] }), totpEnabled: bool() }),
      DeletionRequestFiled: obj({ requested: bool(), requestId: int(), status: str({ enum: ['pending'] }), requestedAt: str({ description: 'UTC' }) }),
      DeletionRequest: obj({
        id: int(), accountId: int(), accountType: str({ enum: ['adult', 'parent'] }), source: str({ enum: ['app', 'web'], description: 'app = deleted in the app (always completed, no admin decision), web = public delete-account page (pending until a Full Admin decides)' }),
        deletedByOwner: { type: 'boolean', description: 'True when the owner deleted the account in the app (completed, no admin decision)' },
        status: str({ enum: ['pending', 'completed', 'rejected'] }),
        username: str({ nullable: true, description: 'The adult’s own profile; null for parent accounts and once the account is deleted' }),
        email: str({ nullable: true, description: 'Null once the account is deleted' }), emailVerified: { type: 'boolean', nullable: true },
        childProfiles: int(), profilesDeleted: int({ nullable: true }), requestedAt: str({ description: 'UTC' }), decidedAt: str({ nullable: true, description: 'UTC' }),
        decidedBy: { ...obj({ id: int(), name: str() }), nullable: true }, decisionNote: str({ nullable: true, description: 'Rejection reason or approval note' }),
      }),
      AgeGroup: str({ enum: ['Shishu', 'Bals/Balikas A', 'Bals/Balikas B', 'Bals/Balikas C', 'Kishors/Kishoris A', 'Kishors/Kishoris B', 'Yuvak/Yuvatis A', 'Yuvaks/Yuvatis B', 'Vadil'] }),
    },
  },
  paths: {
    '/meta/config': { get: op('Meta', 'App startup config: minimum supported app version, server time, age groups', { responses: { 200: ok('Config') } }) },
    '/avatars': { get: op('Meta', 'The 16 fixed V1 avatars (10 animal, 6 human)', { responses: { 200: ok('Avatar list') } }) },
    '/usernames/check': { get: op('Meta', 'Is a username available and allowed?', {
      parameters: [{ name: 'username', in: 'query', required: true, schema: str() }],
      responses: { 200: ok('{ available, reason? } — reason is INVALID_FORMAT, BLOCKED_WORD, RESERVED or TAKEN') } }) },
    '/public/delete-account': { post: op('Account', 'Delete an account from the external web page (Google Play Data Safety requirement)', {
      requestBody: body(obj({ email: str(), password: str(), confirm: { type: 'boolean', enum: [true] } }, ['email', 'password', 'confirm'])),
      responses: { 202: ok('Deletion request filed (or the already-pending one returned); a Full Admin approves it', ref('DeletionRequestFiled')), ...errors(401, 429) } }) },

    '/auth/register': { post: op('Auth', 'Create an adult/independent or parent account and email a verification code', {
      description: 'Independent ("adult") accounts send only their date of birth (`dob`) here: a neutral age gate asked '
        + 'before anything else. Under the regional consent age (PARENTAL_CONSENT_AGE) the answer is 400 '
        + '`PARENT_ACCOUNT_REQUIRED` and nothing is stored (this check runs before the email check). The username and '
        + 'avatar are chosen after email verification with POST /me/profile. The older one-step `profile` object is still '
        + 'accepted instead of `dob`. Parent accounts send `confirmAdult: true` and no date of birth. Both account types send '
        + 'the owner’s `firstName`, `lastName` (letters of any script, spaces, - and apostrophes only; 1–50 characters after trimming; a '
        + 'typographic apostrophe is stored as a plain one) and `gender`. These are private: returned only by GET /me and the Admin Panel '
        + 'user detail, never logged. Under the consent age the 400 `PARENT_ACCOUNT_REQUIRED` comes before any other field is '
        + 'validated (no field errors are revealed). Verifying the email reserves the 100 sign-up Sparks (GET /me `signupBonus`).',
      requestBody: body(obj({
        email: str(), password: str({ description: '8–72 chars, at least one letter and one number' }), accountType: str({ enum: ['adult', 'parent'] }),
        phone: str({ description: 'Optional contact only — never used to log in' }), language: str({ enum: ['en', 'gu'] }),
        firstName: str({ maxLength: 50, example: 'Meera', description: 'Private. Letters, spaces, - and apostrophes only' }),
        lastName: str({ maxLength: 50, example: 'Patel', description: 'Private. Letters, spaces, - and apostrophes only' }),
        gender: str({ enum: ['male', 'female', 'prefer_not_to_say'], description: 'Private' }),
        acceptPrivacyPolicy: { type: 'boolean', enum: [true] }, confirmAdult: { type: 'boolean', description: 'Required for parent accounts' },
        dob: str({ format: 'date', description: 'Independent accounts: date of birth (YYYY-MM-DD). Never returned by the API. Not accepted for parents.' }),
        profile: obj({ username: str(), avatarId: int(), dob: str({ format: 'date' }), mode: str({ enum: ['sanatan', 'satsang'] }) }, ['username', 'avatarId', 'dob']),
      }, ['email', 'password', 'accountType', 'acceptPrivacyPolicy', 'firstName', 'lastName', 'gender'])),
      responses: { 201: ok('Account created, verification email sent', obj({ needsEmailVerification: { type: 'boolean' }, email: str() })), ...errors(400, 409, 429) } }) },
    '/auth/verify-email': { post: op('Auth', 'Confirm the 6-digit email code and start a session', {
      description: 'The first verification also reserves the 100 sign-up Sparks for the account (once; credited in Milestone 2).',
      requestBody: body(obj({ email: str(), code: str() }, ['email', 'code'])), responses: { 200: ok('Logged in', ref('AuthResponse')), ...errors(400, 429) } }) },
    '/auth/resend-code': { post: op('Auth', 'Send a new verification code (always answers ok)', { requestBody: body(obj({ email: str() }, ['email'])), responses: { 200: ok('ok'), ...errors(429) } }) },
    '/auth/login': { post: op('Auth', 'Log in with email + password', {
      requestBody: body(obj({ email: str(), password: str() }, ['email', 'password'])), responses: { 200: ok('Logged in', ref('AuthResponse')), ...errors(401, 403, 429) } }) },
    '/auth/refresh': { post: op('Auth', 'Exchange a refresh token for a new pair (the old refresh token stops working). The session keeps its active profile; an independent session without one is moved into the account\'s own profile once it exists.', {
      requestBody: body(obj({ refreshToken: str() }, ['refreshToken'])), responses: { 200: ok('New tokens', ref('AuthResponse')), ...errors(401) } }) },
    '/auth/logout': { post: op('Auth', 'End this device session', { security: user, responses: { 200: ok('ok'), ...errors(401) } }) },
    '/auth/forgot-password': { post: op('Auth', 'Email a password-reset code (always answers ok)', { requestBody: body(obj({ email: str() }, ['email'])), responses: { 200: ok('ok'), ...errors(429) } }) },
    '/auth/reset-password': { post: op('Auth', 'Set a new password with the emailed code; logs out every device', {
      requestBody: body(obj({ email: str(), code: str(), newPassword: str() }, ['email', 'code', 'newPassword'])), responses: { 200: ok('ok'), ...errors(400, 429) } }) },

    '/me': {
      get: op('Account', 'Current account, its profiles, and the active profile', { description: 'The account includes the owner’s private firstName, lastName, gender and the reserved signupBonus (AccountOwnerView).', security: user, responses: { 200: ok('Account', obj({ account: ref('AccountOwnerView'), profiles: { type: 'array', items: ref('Profile') }, activeProfileId: int({ nullable: true }) })), ...errors(401) } }),
      patch: op('Account', 'Update phone or language', { description: 'Parent accounts: only from the parent area; from a child’s session 403 `PARENT_MODE_REQUIRED`.', security: user, requestBody: body(obj({ phone: str({ nullable: true }), language: str({ enum: ['en', 'gu'] }) }), false), responses: { 200: ok('Updated'), ...errors(400, 401, 403) } }),
      delete: op('Account', 'Delete the account now (password check). Irreversible.', {
        description: 'Deletes at once, in one transaction: the account, every profile (for a parent account every child profile too) and all their data '
          + '(progress, Sparks, Dress Up items, saved Shangars, referral link, leaderboard entries), and every session on every device. A completed '
          + 'row (source `app`, ids and counts only) is kept in the deletion history; a pending web-page request for the account is closed. '
          + 'The public delete-account web page still files a request that a Full Admin approves. Errors: 401 `INVALID_CREDENTIALS` (wrong password), '
          + '403 `PARENT_MODE_REQUIRED` (a parent account while a child plays), 401 `ACCOUNT_DELETED` (already deleted: any call with a token of a deleted account answers this).',
        security: user, requestBody: body(obj({ password: str(), confirm: { type: 'boolean', enum: [true] } }, ['password', 'confirm'])),
        responses: { 200: ok('Deleted', obj({ deleted: bool(), profilesDeleted: int() })), ...errors(400, 401, 403, 429) } }),
    },
    '/me/profile': { post: op('Account', 'Independent accounts: create your own playable profile (once, after email verification)', {
      description: 'Uses the date of birth given at registration (it then lives on the profile only), makes the new profile '
        + 'active on this device session and returns an access token for it. Errors: 403 `INDEPENDENT_ONLY` (parent accounts '
        + 'use POST /profiles), 409 `PROFILE_EXISTS`, 400 `USERNAME_*`, `DOB_MISSING`, `PARENT_ACCOUNT_REQUIRED`.',
      security: user,
      requestBody: body(obj({ username: str({ description: '3–20 letters (any script), digits, _ or .' }), avatarId: int({ description: '1–16' }), mode: str({ enum: ['sanatan', 'satsang'] }), country: ref('CountryCode') }, ['username', 'avatarId'])),
      responses: { 201: ok('Profile created and active', obj({ accessToken: str(), activeProfileId: int(), profile: ref('Profile') })), ...errors(400, 401, 403, 409) } }) },
    '/me/active-profile': { post: op('Account', 'Who is playing on this device: a profile, or null for the parent area', {
      description: 'Parent accounts: leaving a child’s profile (to a sibling or to the parent area, profileId null) needs the Parent PIN '
        + '(401 `PIN_REQUIRED` / `PIN_INCORRECT` with details.attemptsLeft, 429 `PIN_LOCKED` with details.retryAfterSeconds). From the parent area '
        + '(where a password login starts) picking a child needs no PIN. Independent accounts can only pick their own profile. '
        + 'Returns a new access token; the device session keeps the choice across refreshes.',
      security: user, requestBody: body(obj({ profileId: int({ nullable: true }), pin: str({ description: '4 digits' }) }, ['profileId'])),
      responses: { 200: ok('New access token', obj({ accessToken: str(), activeProfileId: int({ nullable: true }), profile: { ...ref('Profile'), nullable: true } })), ...errors(400, 401, 403, 404, 409, 429) } }) },
    '/me/activity/heartbeat': { post: op('Account', 'Daily time: beats for the active profile (every ~60 s while the app is open; offline beats queued up to 1 day)', {
      description: 'Each beat counts once per profile per UTC minute (retries are ignored) and is added to the America/New_York day it happened in. '
        + 'Beats in the future or more than 24 h old are ignored. 403 `NO_ACTIVE_PROFILE` in the parent area.',
      security: user, requestBody: body(obj({ beats: { type: 'array', minItems: 1, maxItems: 1500, items: obj({ at: str({ format: 'date-time' }), seconds: int({ minimum: 1, maximum: 60 }) }, ['at', 'seconds']) } }, ['beats'])),
      responses: { 200: ok('Counted', obj({ counted: int(), ignored: int() })), ...errors(400, 401, 403) } }) },
    '/me/children/{id}/activity': { get: op('Account', 'A child’s daily time for the parent area (parent accounts, parent area only)', {
      security: user, parameters: [idParam, { name: 'days', in: 'query', schema: int({ minimum: 1, maximum: 90, default: 7 }) }],
      responses: { 200: ok('Days, oldest first; missing days are 0', obj({ profileId: int(), timeZone: str(), today: str({ format: 'date' }), todaySeconds: int(), todayMinutes: int(), days: { type: 'array', items: obj({ day: str({ format: 'date' }), seconds: int(), minutes: int() }) } })), ...errors(400, 401, 403, 404) } }) },
    '/me/explore-import': { post: op('Account', 'Explore → account: add what was earned and done in Explore mode to the new profile (once per account, idempotent by transaction id)', {
      description: [
        'Independent account: goes into its own profile (`profileId` optional). Parent account: `profileId` of one of its children is required, from the parent area.',
        'The first call fixes the target profile and applies `avatarId` / `mode` to it; later calls (batches, retries) must name the same profile, otherwise 409 `EXPLORE_ALREADY_IMPORTED`.',
        'Each entry has a unique UUID `txId`: one already stored is counted in `duplicates`, never twice. At most 200 entries per call.',
        'Nothing is credited here: entries are stored as `pending_import` and verified/credited by the server in Milestone 2 (Sparks, purchases) and 3 (scores, progress). The nickname is not sent (it is pre-filled as the username and live-checked in Profile setup / Add child).',
      ].join('\n\n'),
      security: user,
      requestBody: body(obj({
        profileId: int({ description: 'Parent accounts: the child receiving the import.' }),
        avatarId: int({ minimum: 1, maximum: 16 }),
        mode: str({ enum: ['sanatan', 'satsang'] }),
        sparks: { type: 'array', maxItems: 200, items: obj({ txId: str({ format: 'uuid' }), amount: int({ minimum: 1 }), reason: str({ example: 'quiz_correct' }), at: str({ format: 'date-time' }) }, ['txId', 'amount', 'reason', 'at']) },
        purchases: { type: 'array', maxItems: 200, items: obj({ txId: str({ format: 'uuid' }), itemId: str(), sparks: int({ minimum: 0 }), at: str({ format: 'date-time' }) }, ['txId', 'itemId', 'sparks', 'at']) },
        scores: { type: 'array', maxItems: 200, items: obj({ txId: str({ format: 'uuid' }), game: str({ example: 'quiz' }), itemId: str({ nullable: true }), score: int({ minimum: 0 }), at: str({ format: 'date-time' }) }, ['txId', 'game', 'score', 'at']) },
        progress: { type: 'array', maxItems: 200, items: obj({ txId: str({ format: 'uuid' }), area: str({ example: 'learn' }), itemId: str(), value: int({ minimum: 0 }), at: str({ format: 'date-time' }) }, ['txId', 'area', 'itemId', 'value', 'at']) },
      })),
      responses: {
        200: ok('Stored (or already stored)', obj({
          profileId: int(), firstImport: bool(), imported: int(), duplicates: int(),
          pending: obj({ sparks: int({ description: 'Sum of pending Explore Sparks' }), purchases: int(), scores: int(), progress: int() }),
        })),
        ...errors(400, 401, 403, 404, 409),
      },
    }) },
    '/me/referral': { get: op('Referrals', 'My referral code (account level), how many friends used it (no names), and the code this account used', {
      description: 'The code is 6 characters without 0 / O / 1 / I. counts.waitingForFirstQuiz: friends who still have to finish their first full quiz before the referrer\u2019s Sparks are earned. canApply: this account may still enter a friend\u2019s code (none used yet, within windowHours of creating the account). Sparks are reserved here and credited by the Sparks ledger in Milestone 2.',
      security: user,
      responses: { 200: ok('Referral', ref('ReferralView')), ...errors(401) },
    }) },
    '/me/referral/apply': { post: op('Referrals', 'Apply a friend\u2019s referral code: +25 Sparks reserved for the new user at once; the friend gets +50 after the new user\u2019s first full quiz', {
      description: 'Once per account, within the window (default 48 h after creating the account). A parent account applies it from the parent area. Errors: 400 `INVALID_CODE`, 400 `SELF_REFERRAL` (own code or the same mailbox), 409 `ALREADY_APPLIED` (this account, or a code already used on this device), 403 `WINDOW_EXPIRED`, 409 `REFERRER_LIMIT`, 403 `PARENT_MODE_REQUIRED`. Amounts and limits: Admin Panel (app_settings).',
      security: user,
      requestBody: body(obj({ code: str({ example: 'K7P2QX' }), deviceId: str({ description: 'Optional random install id of the app (not a hardware id); stored only as an HMAC, to refuse a second referral from the same phone.' }) }, ['code'])),
      responses: { 200: ok('Applied', obj({ applied: obj({ id: int(), sparks: int(), status: str({ enum: ['reserved'] }) }), referral: ref('ReferralView') })), ...errors(400, 401, 403, 409, 429) },
    }) },
    '/me/password': { post: op('Account', 'Change the password; every other device is logged out, this one stays logged in', {
      description: 'newPassword: 8–72 characters with a letter and a number. Every earlier access token stops working; use the returned one (the refresh token '
        + 'of this device stays valid). Errors: 401 `INVALID_CREDENTIALS` (current password wrong), 400 `VALIDATION_ERROR`, 403 `PARENT_MODE_REQUIRED` (a parent account while a child plays).',
      security: user, requestBody: body(obj({ currentPassword: str(), newPassword: str() }, ['currentPassword', 'newPassword'])),
      responses: { 200: ok('Changed', obj({ accessToken: str(), activeProfileId: int({ nullable: true }), otherSessionsEnded: int() })), ...errors(400, 401, 403, 429) } }) },
    '/me/settings': { patch: op('Account', 'Language, path (mode) and/or country for whoever is playing', {
      description: 'Independent: language → the account and its profile, mode and country → its profile. Parent area: language → the account (mode or country: 400 `NO_ACTIVE_PROFILE`). '
        + 'A parent’s child: 403 `PARENT_MODE_REQUIRED` (the parent sets a child’s path, language and country with PATCH /profiles/{id} from the parent area).',
      security: user, requestBody: body(obj({ language: str({ enum: ['en', 'gu'] }), mode: str({ enum: ['sanatan', 'satsang'], nullable: true }), country: ref('CountryCode') }), false),
      responses: { 200: ok('Updated', obj({ account: ref('Account'), profile: { ...ref('Profile'), nullable: true } })), ...errors(400, 401, 403) } }) },

    '/profiles': {
      get: op('Profiles', 'List the account’s profiles', { security: user, responses: { 200: ok('Profiles'), ...errors(401) } }),
      post: op('Profiles', 'Add a child profile (parent accounts, parent area; recorded parental consent)', {
        description: 'From the parent area no PIN is needed (a PIN sent anyway is checked). The first child can be added before the Parent PIN exists; later children need it (409 `PIN_NOT_SET`). From a child’s session: 403 `PARENT_MODE_REQUIRED`. The response carries the server’s age group.',
        security: user, requestBody: body(obj({ pin: str(), username: str(), avatarId: int(), dob: str({ format: 'date' }), language: str({ enum: ['en', 'gu'] }), mode: str({ enum: ['sanatan', 'satsang'] }), country: ref('CountryCode'), parentalConsent: { type: 'boolean', enum: [true] } }, ['username', 'avatarId', 'dob', 'parentalConsent'])),
        responses: { 201: ok('Created', obj({ profile: ref('Profile') })), ...errors(400, 401, 403, 409, 429) } }),
    },
    '/profiles/{id}': {
      patch: op('Profiles', 'Change username, avatar, language, mode or country', {
        description: 'Parent area: any own child, no PIN. A parent session playing as one child editing a sibling: PIN required. The active profile itself: an adult changes avatar / language / mode / country; a parent’s child only its avatar (language, mode or country without the PIN: 403 `PIN_REQUIRED`; username: 403 `USERNAME_PARENT_ONLY`). Username errors: 400 `USERNAME_*`.',
        security: user, parameters: [idParam], requestBody: body(obj({ username: str(), avatarId: int(), language: str({ enum: ['en', 'gu'] }), mode: str({ enum: ['sanatan', 'satsang'], nullable: true }), country: ref('CountryCode'), pin: str() }), false),
        responses: { 200: ok('Updated', obj({ profile: ref('Profile') })), ...errors(400, 401, 403, 404, 429) } }),
      delete: op('Profiles', 'Delete one child profile and all its data with the Parent PIN; the parent account and other children are unaffected', {
        description: 'Parent area only (403 `PARENT_MODE_REQUIRED` while a child plays; 403 `NOT_A_CHILD_PROFILE`). Irreversible. Devices playing as that child are logged out. '
          + 'PIN errors: 401 `PIN_INCORRECT` (details.attemptsLeft), 429 `PIN_LOCKED` (details.retryAfterSeconds).',
        security: user, parameters: [idParam], requestBody: body(obj({ pin: str(), confirm: { type: 'boolean', enum: [true] } }, ['pin', 'confirm'])),
        responses: { 200: ok('Deleted', obj({ deleted: bool(), profileId: int(), sessionsEnded: int() })), ...errors(400, 401, 403, 404, 429) } }),
    },
    '/profiles/{id}/switch': { post: op('Profiles', 'Switch this device to a child profile (Parent PIN required)', {
      security: user, parameters: [idParam], requestBody: body(obj({ pin: str() }, ['pin'])), responses: { 200: ok('New access token for the child profile'), ...errors(401, 403, 404, 429) } }) },
    '/profiles/parent-mode': { post: op('Profiles', 'Leave child mode and return to parent settings (Parent PIN required)', {
      security: user, requestBody: body(obj({ pin: str() }, ['pin'])), responses: { 200: ok('New access token in parent mode'), ...errors(401, 403, 429) } }) },

    '/parent/pin': { post: op('Parent PIN', 'Create the 4-digit Parent PIN (first time, from the parent area; the password is optional and checked if sent)', {
      security: user, requestBody: body(obj({ pin: str(), password: str() }, ['pin'])), responses: { 201: ok('Created'), ...errors(401, 403, 409) } }) },
    '/parent/pin/verify': { post: op('Parent PIN', 'Check the PIN. Five wrong tries lock it for 5 minutes (details.attemptsLeft / details.retryAfterSeconds).', {
      security: user, requestBody: body(obj({ pin: str() }, ['pin'])), responses: { 200: ok('Correct'), ...errors(401, 409, 429) } }) },
    '/parent/pin/change': { post: op('Parent PIN', 'Change the PIN with the current one (the parent stays logged in)', {
      security: user, requestBody: body(obj({ currentPin: str(), newPin: str() }, ['currentPin', 'newPin'])), responses: { 200: ok('Changed'), ...errors(400, 401, 409, 429) } }) },
    '/parent/pin/reset': { post: op('Parent PIN', 'Forgot the PIN: set a new one with the account password (also clears a lock; the parent stays logged in)', {
      security: user, requestBody: body(obj({ password: str(), newPin: str() }, ['password', 'newPin'])), responses: { 200: ok('Reset'), ...errors(401) } }) },

    '/profiles/activity': { post: op('Profiles', 'Older heartbeat (1–300 s added to today). The app uses POST /me/activity/heartbeat.', {
      security: user, requestBody: body(obj({ seconds: int({ minimum: 1, maximum: 300 }) }, ['seconds'])), responses: { 200: ok('ok'), ...errors(400, 401, 403) } }) },
    '/parent/report': { get: op('Parent PIN', 'Parent report: daily time and activity per child (parent mode only)', {
      security: user, parameters: [{ name: 'profileId', in: 'query', schema: int() }, { name: 'days', in: 'query', schema: int({ minimum: 1, maximum: 90, default: 7 }) }], responses: { 200: ok('Report'), ...errors(401, 403, 404) } }) },

    '/admin/auth/login': { post: op('Admin Auth', 'Step 1: email + password. Returns which 2FA step comes next and a 10-minute step token.', {
      requestBody: body(obj({ email: str(), password: str() }, ['email', 'password'])), responses: { 200: ok('{ step: "totp_setup" | "totp_verify", stepToken }'), ...errors(401, 429) } }) },
    '/admin/auth/totp/setup': { post: op('Admin Auth', 'First login only: generate the authenticator secret and QR code (send the step token as Bearer)', {
      security: adminStep, responses: { 200: ok('{ secret, otpauthUrl, qrDataUrl }'), ...errors(401) } }) },
    '/admin/auth/totp/enable': { post: op('Admin Auth', 'First login only: confirm with the first code; returns the admin token', {
      security: adminStep, requestBody: body(obj({ code: str() }, ['code'])), responses: { 200: ok('{ token, admin }'), ...errors(401, 429) } }) },
    '/admin/auth/totp/verify': { post: op('Admin Auth', 'Normal login step 2: 6-digit authenticator code; returns the admin token', {
      security: adminStep, requestBody: body(obj({ code: str() }, ['code'])), responses: { 200: ok('{ token, admin }'), ...errors(401, 429) } }) },
    '/admin/auth/me': { get: op('Admin Auth', 'Who am I', { security: admin, responses: { 200: ok('Admin', obj({ admin: ref('Admin') })), ...errors(401) } }) },
    '/admin/auth/logout': { post: op('Admin Auth', 'End all of this admin’s sessions', { security: admin, responses: { 200: ok('ok'), ...errors(401) } }) },
    '/admin/auth/change-password': { post: op('Admin Auth', 'Change own password (12+ chars); sessions end', {
      security: admin, requestBody: body(obj({ currentPassword: str(), newPassword: str() }, ['currentPassword', 'newPassword'])), responses: { 200: ok('ok'), ...errors(400, 401) } }) },

    '/admin/admins': {
      get: op('Admin Management', 'List admins (Full Admin)', { security: admin, responses: { 200: ok('Admins'), ...errors(401, 403) } }),
      post: op('Admin Management', 'Create an admin (Full Admin). They set up 2FA at first login.', {
        security: admin, requestBody: body(obj({ email: str(), name: str(), role: str({ enum: ['full_admin', 'content_editor'] }), temporaryPassword: str({ description: '12+ chars' }) }, ['email', 'role', 'temporaryPassword'])), responses: { 201: ok('Created'), ...errors(400, 401, 403, 409) } }),
    },
    '/admin/admins/{id}': { patch: op('Admin Management', 'Rename, change role, or deactivate. The last active Full Admin cannot be removed.', {
      security: admin, parameters: [idParam], requestBody: body(obj({ name: str(), role: str({ enum: ['full_admin', 'content_editor'] }), isActive: bool() }), false), responses: { 200: ok('Updated'), ...errors(400, 401, 403, 404) } }) },
    '/admin/admins/{id}/reset-2fa': { post: op('Admin Management', 'Remove an admin’s authenticator so they enrol a new one', { security: admin, parameters: [idParam], responses: { 200: ok('ok'), ...errors(401, 403, 404) } }) },
    '/admin/admins/{id}/reset-password': { post: op('Admin Management', 'Set a new password for an admin', {
      security: admin, parameters: [idParam], requestBody: body(obj({ newPassword: str() }, ['newPassword'])), responses: { 200: ok('ok'), ...errors(400, 401, 403, 404) } }) },

    '/admin/users': { get: op('Admin Users', 'Search accounts by email or username (Full Admin)', {
      security: admin, parameters: [{ name: 'q', in: 'query', schema: str() }, { name: 'page', in: 'query', schema: int() }, { name: 'pageSize', in: 'query', schema: int() }], responses: { 200: ok('Page of accounts/profiles'), ...errors(401, 403) } }) },
    '/admin/users/{accountId}': { get: op('Admin Users', 'The "View" page: one account with all its profiles (logged in the audit log as user.viewed)', {
      security: admin, parameters: [{ name: 'accountId', in: 'path', required: true, schema: int() }],
      responses: { 200: ok('Account detail', obj({
        account: obj({ id: int(), email: str(), accountType: str({ enum: ['adult', 'parent'] }), phone: str({ nullable: true }), language: str({ enum: ['en', 'gu'] }),
          firstName: str({ nullable: true, description: 'Private: this detail page only' }), lastName: str({ nullable: true }), gender: str({ enum: ['male', 'female', 'prefer_not_to_say'], nullable: true }),
          emailVerified: bool(), emailVerifiedAt: str({ nullable: true, description: 'UTC' }), parentPinSet: bool(),
          privacyPolicyVersion: str({ nullable: true }), consentAcceptedAt: str({ nullable: true, description: 'UTC' }), createdAt: str({ description: 'UTC' }) }),
        profiles: { type: 'array', items: obj({ id: int(), username: str(), avatarId: int(), avatarKey: str(), dob: str({ format: 'date' }), age: int(),
          ageGroup: ref('AgeGroup'), ageGroupOverridden: bool(), isChild: bool(), language: str({ enum: ['en', 'gu'] }),
          mode: str({ enum: ['sanatan', 'satsang'], nullable: true }), createdAt: str({ description: 'UTC' }) }) },
      })), ...errors(401, 403, 404) } }),
      delete: op('Admin Users', 'Permanently delete an account and all its profiles (a parent’s child profiles too). Ends the user’s sessions. Reason is required and audited as user.deleted.', {
        security: admin, parameters: [{ name: 'accountId', in: 'path', required: true, schema: int() }],
        requestBody: body(obj({ confirm: { type: 'boolean', enum: [true] }, reason: str({ description: '3–200 chars' }) }, ['confirm', 'reason'])),
        responses: { 200: ok('Deleted', obj({ deleted: bool(), accountId: int(), profilesDeleted: int() })), ...errors(400, 401, 403, 404) } }) },
    '/admin/users/profiles/{id}/age-group': { patch: op('Admin Users', 'Manually set an age group (or null to go back to the DOB-derived group). Reason is required and audited.', {
      security: admin, parameters: [idParam], requestBody: body(obj({ ageGroup: { ...ref('AgeGroup'), nullable: true }, reason: str() }, ['ageGroup', 'reason'])), responses: { 200: ok('Updated'), ...errors(400, 401, 403, 404) } }) },

    '/admin/blocked-words': {
      get: op('Admin Moderation', 'Username moderation list (Full Admin and Content Editor)', { security: admin, responses: { 200: ok('Words'), ...errors(401, 403) } }),
      post: op('Admin Moderation', 'Add a blocked or reserved word (English, Gujarati script, or transliteration)', {
        security: admin, requestBody: body(obj({ word: str(), kind: str({ enum: ['blocked', 'reserved'] }) }, ['word'])), responses: { 201: ok('Added'), ...errors(400, 401, 403, 409) } }),
    },
    '/admin/blocked-words/{id}': { delete: op('Admin Moderation', 'Remove a word', { security: admin, parameters: [idParam], responses: { 200: ok('Removed'), ...errors(401, 403, 404) } }) },

    '/admin/dashboard': { get: op('Admin Dashboard', 'Live numbers for the Admin Panel home page (Full Admin). "Today" and chart days are America/New_York calendar days. No emails or DOBs are returned.', {
      security: admin,
      parameters: [
        { name: 'days', in: 'query', schema: int({ enum: [7, 30], default: 7 }), description: 'New-registrations chart range' },
        { name: 'recent', in: 'query', schema: int({ minimum: 1, maximum: 50, default: 5 }), description: 'Rows in Recent registrations' },
        { name: 'activity', in: 'query', schema: int({ minimum: 1, maximum: 50, default: 10 }), description: 'Rows in Recent admin activity' },
      ],
      responses: { 200: ok('Dashboard', obj({
        generatedAt: str({ format: 'date-time' }), timeZone: str({ example: 'America/New_York' }),
        totals: obj({ accounts: int(), adultAccounts: int(), parentAccounts: int(), profiles: int(), childProfiles: int(), newRegistrationsToday: int() }),
        ageGroups: { type: 'array', items: obj({ ageGroup: ref('AgeGroup'), count: int() }) },
        registrations: obj({ days: int(), total: int(), series: { type: 'array', items: obj({ date: str({ format: 'date' }), count: int() }) } }),
        modes: { type: 'array', items: obj({ key: str({ enum: ['sanatan', 'satsang', 'not_set'] }), count: int() }) },
        languages: { type: 'array', items: obj({ key: str({ enum: ['en', 'gu'] }), count: int() }) },
        recentRegistrations: { type: 'array', items: obj({ accountId: int(), profileId: int({ nullable: true }), type: str({ enum: ['adult', 'parent', 'child'] }), username: str({ nullable: true }), ageGroup: str({ nullable: true }), createdAt: str({ description: 'UTC' }) }) },
        recentAdminActivity: { type: 'array', items: obj({ id: int(), adminId: int({ nullable: true }), adminName: str({ nullable: true }), adminEmail: str({ nullable: true }), action: str(), entityType: str({ nullable: true }), entityId: str({ nullable: true }), details: { type: 'object', nullable: true }, createdAt: str({ description: 'UTC' }) }) },
      })), ...errors(400, 401, 403) } }) },

    '/admin/deletion-requests': { get: op('Admin Deletion Requests', 'The Deletion requests page (Full Admin): one status tab, newest first. counts covers every status with the same q/source filters, for the tab badges (counts.pending is the sidebar badge).', {
      security: admin,
      parameters: [
        { name: 'status', in: 'query', schema: str({ enum: ['pending', 'completed', 'rejected', 'all'], default: 'pending' }) },
        { name: 'q', in: 'query', schema: str(), description: 'Username or email (pending/rejected rows only; completed rows keep neither)' },
        { name: 'source', in: 'query', schema: str({ enum: ['app', 'web', 'all'], default: 'all' }) },
        { name: 'page', in: 'query', schema: int({ default: 1 }) }, { name: 'pageSize', in: 'query', schema: int({ default: 25, maximum: 100 }) },
      ],
      responses: { 200: ok('Page of requests', obj({ status: str(), page: int(), pageSize: int(), total: int(),
        counts: obj({ pending: int(), completed: int(), rejected: int(), all: int() }), rows: { type: 'array', items: ref('DeletionRequest') } })), ...errors(400, 401, 403) } }) },
    '/admin/deletion-requests/{id}': { get: op('Admin Deletion Requests', 'The "View" page: the request, the account and its profiles (no DOBs). Audited as deletion_request.viewed.', {
      security: admin, parameters: [idParam],
      responses: { 200: ok('Request detail', obj({ request: ref('DeletionRequest'),
        account: { ...obj({ id: int(), email: str(), accountType: str({ enum: ['adult', 'parent'] }), emailVerified: bool(), createdAt: str({ description: 'UTC' }) }), nullable: true, description: 'Null once completed' },
        profiles: { type: 'array', items: obj({ id: int(), username: str(), isChild: bool(), ageGroup: ref('AgeGroup'), avatarKey: str(), createdAt: str({ description: 'UTC' }) }) } })), ...errors(401, 403, 404) } }) },
    '/admin/deletion-requests/{id}/approve': { post: op('Admin Deletion Requests', 'Approve: permanently deletes the account and all its profiles (a parent’s child profiles too) and ends the user’s sessions. Audited as deletion_request.approved, without email or username.', {
      security: admin, parameters: [idParam], requestBody: body(obj({ confirm: { type: 'boolean', enum: [true] }, note: str({ description: 'Optional, up to 200 chars' }) }, ['confirm'])),
      responses: { 200: ok('Deleted', obj({ id: int(), status: str({ enum: ['completed'] }), accountId: int(), profilesDeleted: int() })), ...errors(400, 401, 403, 404, 409) } }) },
    '/admin/deletion-requests/{id}/reject': { post: op('Admin Deletion Requests', 'Reject: the account is kept. Reason is required and audited as deletion_request.rejected. The owner can ask again.', {
      security: admin, parameters: [idParam], requestBody: body(obj({ reason: str({ description: '3–200 chars' }) }, ['reason'])),
      responses: { 200: ok('Rejected', obj({ id: int(), status: str({ enum: ['rejected'] }), accountId: int() })), ...errors(400, 401, 403, 404, 409) } }) },

    '/admin/referrals': { get: op('Admin Referrals', 'Referrals list (Full Admin): code, referrer and new user (usernames only, never emails), status and dates, newest first', {
      security: admin,
      parameters: [
        { name: 'q', in: 'query', schema: str(), description: 'Code or username' },
        { name: 'status', in: 'query', schema: str({ enum: ['all', 'waiting_for_first_quiz', 'qualified', 'credited', 'rejected'] }) },
        { name: 'page', in: 'query', schema: int() }, { name: 'pageSize', in: 'query', schema: int({ maximum: 100 }) },
      ],
      responses: { 200: ok('Referrals', obj({ page: int(), pageSize: int(), total: int(), rows: { type: 'array', items: obj({
        id: int(), code: str(), status: str(),
        referrer: { ...obj({ accountId: int(), accountType: str(), username: str({ nullable: true }) }), nullable: true, description: 'Null once the referrer account was deleted.' },
        referee: obj({ accountId: int(), accountType: str(), username: str({ nullable: true }) }),
        newUserSparks: int(), newUserStatus: str({ enum: ['reserved', 'credited'] }), referrerSparks: int(),
        createdAt: str(), qualifiedAt: str({ nullable: true }), creditedAt: str({ nullable: true }),
      }) } })), ...errors(401, 403) },
    }) },
    '/admin/referrals/settings': {
      get: op('Admin Referrals', 'Referral settings (Full Admin)', { security: admin, responses: { 200: ok('Settings', obj({ settings: ref('ReferralSettings') })), ...errors(401, 403) } }),
      put: op('Admin Referrals', 'Change referral settings (Full Admin, audited as referral_settings.updated). Applies to codes entered from now on.', {
        security: admin, requestBody: body(ref('ReferralSettings')),
        responses: { 200: ok('Saved', obj({ settings: ref('ReferralSettings') })), ...errors(400, 401, 403) },
      }),
    },
    '/admin/audit-log': { get: op('Admin Audit', 'Who changed what and when (Full Admin, read-only)', {
      security: admin, parameters: ['adminId', 'action', 'entityType', 'from', 'to', 'page', 'pageSize'].map((n) => ({ name: n, in: 'query', schema: str() })), responses: { 200: ok('Audit entries'), ...errors(401, 403) } }) },
  },
};
