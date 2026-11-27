// OpenAPI 3 description of the Milestone 1 API. Served at /api-docs (Swagger UI) and /api-docs.json
// (importable into Postman). Keep this file in step with the routes when endpoints change.
const { AGE_GROUP_KEYS } = require('./utils/ageGroup');
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

const op = (tag, summary, o = {}) => ({ tags: [tag], summary, ...o });
const { TYPES: SPARKS_TYPES, REWARD_ACTIVITIES } = require('./services/sparks');
const pageParams = [{ name: 'page', in: 'query', schema: int({ minimum: 1, default: 1 }) }, { name: 'pageSize', in: 'query', schema: int({ minimum: 1, maximum: 100, default: 25 }) }];
const sparksStatusParam = { name: 'status', in: 'query', schema: str({ enum: ['verified', 'pending', 'reversed'] }) };

module.exports = {
  openapi: '3.0.3',
  info: {
    title: 'Satsang Spark API',
    version: '1.0.0 (Milestone 1)',
    description: [
      'Backend for the Satsang Spark mobile app and Admin Panel.',
      '',
      '**Milestone 1 covers:** registration/login with email verification, password reset, adult and parent accounts, playable (child) profiles, 16 fixed avatars, DOB-based age groups, Parent PIN, account/profile deletion, and the Admin Panel foundation (Full Admin / Content Editor roles, email login code (2FA), audit log).',
      '',
      '**Conventions:** all paths are under `/api/v1`. Errors look like `{ "error": { "code", "message", "details?" } }`. Dates of birth are `YYYY-MM-DD` and are never returned for other users. Timestamps are stored in UTC and returned as ISO 8601 UTC strings ending in `Z` (e.g. `2026-11-19T12:02:37.000Z`); clients show them in the viewer’s local time. Server time is authoritative; game days use America/New_York.',
      '',
      '**Users:** log in, then send `Authorization: Bearer <accessToken>`. Renew with `/auth/refresh`. **Admins:** two steps — `/admin/auth/login` (email + password; a 6-digit code is emailed and a `challengeToken` returned) → `/admin/auth/verify-otp` (`challengeToken` + code) → send the returned token as `Authorization: Bearer`. `/admin/auth/resend-otp` sends a new code. **Trusted devices:** `verify-otp` with `trustDevice: true` returns a `deviceToken` (once); send it as `deviceToken` on later `/admin/auth/login` calls from that browser and the login completes with the password only (`step: "done"`). **Remember me:** `rememberMe: true` on login returns a 30-day rolling `refreshToken`; renew the admin token with `/admin/auth/refresh`.',
    ].join('\n'),
  },
  servers: [{ url: '/api/v1' }],
  tags: [
    { name: 'Meta' }, { name: 'Auth' }, { name: 'Account' }, { name: 'Profiles' }, { name: 'Sparks' }, { name: 'Admin Sparks' }, { name: 'Home' }, { name: 'Admin Home' }, { name: 'Parent PIN' },
    { name: 'Admin Auth' }, { name: 'Admin Management' }, { name: 'Admin Users' }, { name: 'Admin Moderation' }, { name: 'Admin Audit' }, { name: 'Admin Dashboard' }, { name: 'Admin Deletion Requests' }, { name: 'Referrals' }, { name: 'Admin Referrals' }, { name: 'Export' },
  ],
  components: {
    securitySchemes: {
      userBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'App access token from login / verify-email / refresh.' },
      adminBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Admin token from /admin/auth/verify-otp. The challengeToken from /admin/auth/login is not an admin token: it only goes in the body of verify-otp / resend-otp.' },
    },
    schemas: {
      Error: obj({ error: obj({ code: str(), message: str(), details: { description: 'VALIDATION_ERROR: [{ field, message }]. PIN_INCORRECT: { attemptsLeft }. PIN_LOCKED: { retryAfterSeconds }.', oneOf: [{ type: 'array', items: obj({ field: str(), message: str() }) }, obj({ attemptsLeft: int(), retryAfterSeconds: int() })] } }) }),
      Profile: obj({
        id: int(), username: str(), avatarId: int({ minimum: 1, maximum: 16 }), ageGroup: str({ example: 'Bals/Balikas B' }),
        isChild: bool(), language: str({ enum: ['en', 'gu'], description: 'App language (menus, buttons, settings)' }),
        contentLanguage: str({ enum: ['en', 'gu'], description: 'Content language (questions, games, PDFs, learning content); defaults to the app language' }), mode: str({ enum: ['sanatan', 'satsang'], nullable: true }),
        dob: str({ format: 'date', description: 'Only returned to the profile’s own account.' }),
        country: { ...ref('CountryCode'), nullable: true, description: 'Private: only returned to the profile’s own account (never on leaderboards or public views). Null for profiles created before Profile setup asked for it.' },
        studentStatus: { ...ref('StudentStatus'), description: 'Only returned to the profile’s own account. Set with PUT /profiles/{id}/student-status.' },
        studentSparksReserved: int({ minimum: 0, description: 'Only returned to the profile’s own account. Sparks this profile received for its student status (verified / interest confirmed); since Milestone 2 they are credited to its Sparks ledger (name kept). Also per child in GET /parent/report.' }),
        sparksBalance: int({ minimum: 0, description: 'Only returned to the profile’s own account. Current spendable Sparks of THIS profile (never pooled across a parent account). Details: GET /profiles/{id}/sparks.' }),
        createdAt: str(),
      }),
      SparksBalance: obj({
        balance: int({ minimum: 0, description: 'Spendable now (verified Sparks). Never below zero.' }),
        lifetimeEarned: int({ minimum: 0, description: 'All verified Sparks earned (leaderboards). Spending never lowers it; a reversed credit or a negative admin correction does.' }),
        lifetimeSpent: int({ minimum: 0, description: 'All verified spending (purchases), minus refunds.' }),
        pending: int({ minimum: 0, description: 'Offline / waiting Sparks not yet verified (e.g. a referral reward until the friend completes a first quiz). Not spendable.' }),
      }),
      SparksTransaction: obj({
        id: int(), transactionId: str({ description: 'Unique (client UUID or server id such as signup_bonus-account-12), lower case' }),
        amount: int({ description: '+ earned / − spent or deducted' }), type: str({ enum: SPARKS_TYPES }),
        status: str({ enum: ['verified', 'pending', 'reversed'] }), reference: str({ nullable: true, description: 'e.g. item:crown, attempt id, account:12, referral:5' }),
        createdAt: str(), verifiedAt: str({ nullable: true }), reversedAt: str({ nullable: true }),
      }),
      AdminSparksTransaction: { allOf: [ref('SparksTransaction'), obj({
        profileId: int(), note: str({ nullable: true, description: 'Admin reason / system note (not sent to the app)' }),
        createdBy: int({ nullable: true, description: 'admins.id' }), reversedBy: int({ nullable: true }), reversedReason: str({ nullable: true }),
      })] },
      SparksReward: obj({
        activity: str({ enum: REWARD_ACTIVITIES }), ageGroup: str({ enum: AGE_GROUP_KEYS }), sparks: int({ minimum: 0, maximum: 10000 }),
        defaultSparks: int(), isDefault: bool(), updatedBy: int({ nullable: true }), updatedAt: str({ nullable: true }),
      }),
      SparksRewardConfig: obj({
        activities: { type: 'array', items: str() }, ageGroups: { type: 'array', items: obj({ key: str(), label: str() }) },
        rewards: { type: 'array', items: ref('SparksReward') }, note: str({ example: 'Seeded values are defaults to be confirmed by Loyadham.' }),
      }),
      SpinSegment: obj({ index: int({ description: '0-based position on the wheel' }), label: str({ nullable: true }), sparks: int({ minimum: 1 }) }),
      SpinStatus: obj({
        profileId: int(), available: bool(), nextAvailableAt: str({ format: 'date-time', description: 'When available: now. Otherwise 24 h after the last successful spin.' }),
        lastSpinAt: str({ format: 'date-time', nullable: true }), segments: { type: 'array', items: ref('SpinSegment') },
      }),
      SpinResult: obj({
        profileId: int(), duplicate: { type: 'boolean', description: 'true = this transactionId was already spun; the first result is returned' },
        transactionId: str(), segmentIndex: int(), label: str({ nullable: true }), reward: int({ description: 'Sparks credited' }),
        spunAt: str({ format: 'date-time' }), nextAvailableAt: str({ format: 'date-time' }), balance: ref('SparksBalance'),
      }),
      StreakView: obj({
        profileId: int(), currentStreak: int({ description: '0 when the streak is broken (a game day was missed)' }), bestStreak: int(),
        unclaimed: int({ description: 'Bonus waiting to be claimed; lost if the streak breaks first' }),
        lastActiveDay: str({ format: 'date', nullable: true, description: 'Last counted game day (America/New_York)' }),
        checkedInToday: bool(), nextDayBonus: int({ description: 'What the next counted day adds' }),
        lostUnclaimed: int({ description: 'Bonus the last break took away (or is taking away)' }),
        gameDay: str({ format: 'date' }), gameTimeZone: str({ example: 'America/New_York' }),
        amounts: { type: 'array', items: int(), description: 'Sparks for streak day 1, 2, …; days after the last use the last amount' },
      }),
      News: obj({
        id: int(), title: obj({ en: str(), gu: str({ nullable: true }) }), body: obj({ en: str(), gu: str({ nullable: true }) }),
        imageUrl: str({ nullable: true }), publishAt: str({ format: 'date-time' }), pinned: bool(),
      }),
      AdminNews: { allOf: [ref('News'), obj({ active: bool(), createdBy: int({ nullable: true }), updatedBy: int({ nullable: true }), createdAt: str(), updatedAt: str({ nullable: true }) })] },
      Feedback: obj({
        id: int(), accountId: int(), profileId: int(), username: str(), isChild: bool(), category: str({ enum: ['bug', 'idea', 'other'] }),
        message: str(), appVersion: str({ nullable: true }), device: str({ nullable: true }), status: str({ enum: ['open', 'resolved'] }),
        adminNote: str({ nullable: true }), resolvedBy: int({ nullable: true }), resolvedAt: str({ nullable: true }), createdAt: str(),
      }),
      StudentStatus: str({
        enum: ['not_asked', 'pending_verification', 'verified', 'interested', 'interest_confirmed', 'not_enrolled'],
        description: '"Currently enrolled in Loyadham Online Classes (Bals-Balikas or Kishor-Kishori Classes)?", one answer per profile. not_asked = existing profiles / after an admin reset; pending_verification = said enrolled, waits for a Full Admin; verified = confirmed by a Full Admin (+studentSparks.verified); interested = not enrolled but interested, waits for a Full Admin; interest_confirmed = confirmed by a Full Admin (+studentSparks.interestConfirmed); not_enrolled = not enrolled and not interested, or an enrolment the admin rejected. verified and interest_confirmed are locked for the app.',
      }),
      ReferralView: obj({
        code: str({ example: 'K7P2QX' }), newUserSparks: int(), referrerSparks: int(), windowHours: int(),
        counts: obj({ total: int(), waitingForFirstQuiz: int(), qualified: int(), sparksPending: int({ description: 'Qualified but not yet credited (the referrer has no profile yet)' }), sparksCredited: int({ description: 'Referrer Sparks credited to the ledger' }) }),
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
          signupBonus: { ...obj({ sparks: int({ example: 100 }), status: str({ enum: ['pending', 'credited'], description: 'credited = in the Sparks ledger of the account’s first profile (own profile / first child); pending = the account has no profile yet (credited when the first one is created)' }) }), nullable: true },
        })],
      },
      AuthResponse: obj({ accessToken: str(), refreshToken: str(), account: ref('Account'), profiles: { type: 'array', items: ref('Profile') }, activeProfileId: int({ nullable: true }) }),
      Admin: obj({ id: int(), email: str(), name: str(), role: str({ enum: ['full_admin', 'content_editor'] }) }),
      TrustedDevice: obj({
        id: int(), label: str({ example: 'Chrome on Windows', description: 'Browser and OS from the user agent when the device was trusted' }),
        createdAt: str({ format: 'date-time' }), lastUsedAt: str({ format: 'date-time', nullable: true }),
      }),
      AdminLoginDone: obj({
        step: str({ enum: ['done'] }), token: str({ description: 'Admin token (ADMIN_TOKEN_TTL, default 8 h)' }), admin: ref('Admin'),
        rememberMe: bool(),
        refreshToken: str({ nullable: true, description: 'Only when rememberMe was true: 30-day rolling refresh token for POST /admin/auth/refresh. Store it in the panel (it cannot be an httpOnly cookie cross-site); null otherwise.' }),
        refreshExpiresAt: str({ format: 'date-time', nullable: true }),
        deviceToken: str({ description: 'Only from verify-otp with trustDevice: true. Long, URL-safe; returned once, only its hash is stored. Send it as deviceToken on later logins from this browser.' }),
        device: { ...ref('TrustedDevice'), description: 'The trusted device used (login) or just created (verify-otp with trustDevice).' },
      }, ['step', 'token', 'admin', 'rememberMe']),
      ManagedAdmin: obj({
        id: int(), email: str(), name: str(), role: str({ enum: ['full_admin', 'content_editor'] }),
        status: str({ enum: ['active', 'invited', 'inactive'], description: 'invited = has not accepted the email invite yet (cannot log in); inactive = deactivated (cannot log in, tokens revoked)' }),
        isActive: bool(),
        inviteExpiresAt: str({ format: 'date-time', nullable: true, description: 'UTC; only for status invited (may be in the past: then resend the invite)' }),
        invitedAt: str({ format: 'date-time', nullable: true }), activatedAt: str({ format: 'date-time', nullable: true, description: 'When the invite was accepted' }),
        lastLoginAt: str({ format: 'date-time', nullable: true }), createdAt: str({ format: 'date-time' }),
      }),
      DeletionRequestFiled: obj({ requested: bool(), requestId: int(), status: str({ enum: ['pending'] }), requestedAt: str({ format: 'date-time', description: 'ISO 8601 UTC' }) }),
      DeletionRequest: obj({
        id: int(), accountId: int({ description: 'The deleted account; for target child_profile, the parent account (which still exists)' }), accountType: str({ enum: ['adult', 'parent'] }),
        source: str({ enum: ['app', 'web', 'admin'], description: 'app = deleted in the app (always completed, no admin decision), web = public delete-account page (pending until a Full Admin decides), admin = deleted by a Full Admin from the Users page (always completed)' }),
        target: str({ enum: ['account', 'child_profile'], description: 'account = the whole account with all its profiles; child_profile = ONE child deleted on its own (the parent and other children kept)' }),
        profileId: int({ nullable: true, description: 'The deleted child profile (target child_profile); null otherwise' }),
        isParentEmail: ({ type: 'boolean', description: 'True when email is a parent’s: a parent account, or a deleted child (children have no email of their own)' }),
        deletedByOwner: { type: 'boolean', description: 'True when the owner deleted the account in the app (completed, no admin decision)' },
        status: str({ enum: ['pending', 'completed', 'rejected'] }),
        username: str({ nullable: true, description: 'The adult’s own profile (the child’s, for target child_profile); null for parent accounts. Once completed: Full Admin only, the copy kept on this request until emailRetainedUntil, then null (Details removed).' }),
        email: str({ nullable: true, description: 'Full Admin only (null for every other role). While the account exists: its live email. Once deleted: the email kept on this request until emailRetainedUntil (RETAINED_EMAIL_DAYS, default 30 days after the deletion), then null — the purge job erases it.' }),
        emailRetainedUntil: str({ format: 'date-time', nullable: true, description: 'ISO 8601 UTC. Completed rows: when the retained email AND username are (or were) erased; in the past once they are gone (the panel then shows “Details removed” and the request id). Null for pending/rejected rows and completed rows that kept neither.' }),
        emailVerified: { type: 'boolean', nullable: true },
        childProfiles: int(), profilesDeleted: int({ nullable: true }), requestedAt: str({ format: 'date-time', description: 'ISO 8601 UTC' }), decidedAt: str({ format: 'date-time', nullable: true, description: 'ISO 8601 UTC' }),
        decidedBy: { ...obj({ id: int(), name: str() }), nullable: true }, decisionNote: str({ nullable: true, description: 'Rejection reason or approval note' }),
      }),
      AgeGroup: str({ enum: ['Shishu', 'Bals/Balikas A', 'Bals/Balikas B', 'Bals/Balikas C', 'Kishors/Kishoris A', 'Kishors/Kishoris B', 'Yuvak/Yuvatis A', 'Yuvaks/Yuvatis B', 'Vadil'] }),
    },
  },
  paths: {
    '/meta/config': { get: op('Meta', 'App startup config: minimum supported app version, server time, age groups, student-status settings', {
      description: '`studentInterestFormUrl`: the interest form for the student-status question (STUDENT_INTEREST_FORM_URL); empty string = the app hides the form button. `studentSparks`: `{ verified, interestConfirmed }` Sparks a Full Admin’s verification / interest confirmation gives the profile (STUDENT_VERIFIED_SPARKS, STUDENT_INTEREST_SPARKS; defaults 10 and 5).',
      responses: { 200: ok('Config', obj({ minAppVersion: str(), privacyPolicyVersion: str(), parentalConsentAge: int(), languages: { type: 'array', items: str() }, modes: { type: 'array', items: str() },
        ageGroups: { type: 'array', items: obj({ key: str(), label: str(), minAge: int(), maxAge: int({ nullable: true }) }) }, serverTimeUtc: str({ format: 'date-time' }), gameDay: str({ format: 'date' }), gameTimeZone: str(),
        studentInterestFormUrl: str({ example: '' }), studentSparks: obj({ verified: int({ example: 10 }), interestConfirmed: int({ example: 5 }) }),
        donateUrl: str({ example: '', description: 'Home tab Donate button: Loyadham’s official donation page (Full Admin setting, default DONATE_URL); empty = hide the button' }),
        features: obj({ leaderboards: str({ enum: ['coming_soon'] }), customizeAvatar: str({ enum: ['coming_soon'] }) }) })) } }) },
    '/avatars': { get: op('Meta', 'The 16 fixed V1 avatars: ids 1–10 animal (shadow, frosty, waddles, turbo, blaze, zippy, bamboo, ace, mango, coco), 11–16 human (young_boy, young_man, gentleman, young_girl, young_woman, lady)', { responses: { 200: ok('Avatar list') } }) },
    '/usernames/check': { get: op('Meta', 'Is a username available and allowed?', {
      parameters: [{ name: 'username', in: 'query', required: true, schema: str() }],
      responses: { 200: ok('{ available, reason? } — reason is INVALID_FORMAT, BLOCKED_WORD, RESERVED or TAKEN') } }) },
    '/public/delete-account': { post: op('Account', 'Delete an account from the external web page (Google Play Data Safety requirement)', {
      requestBody: body(obj({ email: str(), password: str(), confirm: { type: 'boolean', enum: [true] } }, ['email', 'password', 'confirm'])),
      responses: { 202: ok('Deletion request filed (or the already-pending one returned); a Full Admin approves it', ref('DeletionRequestFiled')), ...errors(401, 429) } }) },

    '/auth/register': { post: op('Auth', 'Create an adult/independent or parent account and email a verification code (subject "<CODE> is your Satsang Spark verification code"; the 6-digit code expires after 15 minutes)', {
      description: 'Independent ("adult") accounts send only their date of birth (`dob`) here: a neutral age gate asked '
        + 'before anything else. Under the regional consent age (PARENTAL_CONSENT_AGE) the answer is 400 '
        + '`PARENT_ACCOUNT_REQUIRED` and nothing is stored (this check runs before the email check). The username and '
        + 'avatar are chosen after email verification with POST /me/profile. The older one-step `profile` object is still '
        + 'accepted instead of `dob`. Parent accounts send `confirmAdult: true` and no date of birth. Both account types send '
        + 'the owner’s `firstName`, `lastName` (letters of any script, spaces, - and apostrophes only; 1–50 characters after trimming; a '
        + 'typographic apostrophe is stored as a plain one) and `gender`. These are private: returned only by GET /me and the Admin Panel '
        + 'user detail, never logged. Under the consent age the 400 `PARENT_ACCOUNT_REQUIRED` comes before any other field is '
        + 'validated (no field errors are revealed). Verifying the email gives the 100 sign-up Sparks once per account (GET /me `signupBonus`): credited to the first profile’s Sparks ledger.',
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
    '/auth/resend-code': { post: op('Auth', 'Send a new verification code, valid 15 minutes; earlier codes stop working (always answers ok)', { requestBody: body(obj({ email: str() }, ['email'])), responses: { 200: ok('ok'), ...errors(429) } }) },
    '/auth/login': { post: op('Auth', 'Log in with email + password', {
      requestBody: body(obj({ email: str(), password: str() }, ['email', 'password'])), responses: { 200: ok('Logged in', ref('AuthResponse')), ...errors(401, 403, 429) } }) },
    '/auth/refresh': { post: op('Auth', 'Exchange a refresh token for a new pair (the old refresh token stops working). The session keeps its active profile; an independent session without one is moved into the account\'s own profile once it exists.', {
      requestBody: body(obj({ refreshToken: str() }, ['refreshToken'])), responses: { 200: ok('New tokens', ref('AuthResponse')), ...errors(401) } }) },
    '/auth/logout': { post: op('Auth', 'End this device session', { security: user, responses: { 200: ok('ok'), ...errors(401) } }) },
    '/auth/forgot-password': { post: op('Auth', 'Email a password-reset code (subject "<CODE> is your Satsang Spark password reset code"), valid 15 minutes (always answers ok)', { requestBody: body(obj({ email: str() }, ['email'])), responses: { 200: ok('ok'), ...errors(429) } }) },
    '/auth/reset-password': { post: op('Auth', 'Set a new password with the emailed code; logs out every device', {
      requestBody: body(obj({ email: str(), code: str(), newPassword: str() }, ['email', 'code', 'newPassword'])), responses: { 200: ok('ok'), ...errors(400, 429) } }) },

    '/me': {
      get: op('Account', 'Current account, its profiles, and the active profile', { description: 'The account includes the owner’s private firstName, lastName, gender and the reserved signupBonus (AccountOwnerView).', security: user, responses: { 200: ok('Account', obj({ account: ref('AccountOwnerView'), profiles: { type: 'array', items: ref('Profile') }, activeProfileId: int({ nullable: true }) })), ...errors(401) } }),
      patch: op('Account', 'Update phone or language', { description: 'Parent accounts: only from the parent area; from a child’s session 403 `PARENT_MODE_REQUIRED`.', security: user, requestBody: body(obj({ phone: str({ nullable: true }), language: str({ enum: ['en', 'gu'] }) }), false), responses: { 200: ok('Updated'), ...errors(400, 401, 403) } }),
      delete: op('Account', 'Delete the account now (password check). Irreversible.', {
        description: 'Deletes at once, in one transaction: the account, every profile (for a parent account every child profile too) and all their data '
          + '(progress, Sparks, Dress Up items, saved Shangars, referral link, leaderboard entries), and every session on every device. A completed '
          + 'row (source `app`, ids and counts only, plus the email for RETAINED_EMAIL_DAYS, shown to Full Admins only) is kept in the deletion history; a pending web-page request for the account is closed. '
          + 'The owner is emailed "🙏 Satsang Spark – Account Deletion Confirmation"; a mail failure is logged and never stops the deletion. '
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
      requestBody: body(obj({ username: str({ description: '3–20 letters (any script), digits, _ or .' }), avatarId: int({ description: '1–16' }), mode: str({ enum: ['sanatan', 'satsang'] }), country: ref('CountryCode'), contentLanguage: str({ enum: ['en', 'gu'], description: 'Default: the app language' }) }, ['username', 'avatarId'])),
      responses: { 201: ok('Profile created and active', obj({ accessToken: str(), activeProfileId: int(), profile: ref('Profile') })), ...errors(400, 401, 403, 409) } }) },
    '/me/active-profile': { post: op('Account', 'Who is playing on this device: a profile, or null for the parent area', {
      description: 'Parent accounts: leaving a child’s profile (to a sibling or to the parent area, profileId null) needs the Parent PIN '
        + '(401 `PIN_REQUIRED` / `PIN_INCORRECT` with details.attemptsLeft, 429 `PIN_LOCKED` with details.retryAfterSeconds). From the parent area '
        + '(where a password login starts) picking a child needs no PIN. Independent accounts can only pick their own profile. '
        + 'Returns a new access token; the device session keeps the choice across refreshes.',
      security: user, requestBody: body(obj({ profileId: int({ nullable: true }), pin: str({ description: '4 digits' }) }, ['profileId'])),
      responses: { 200: ok('New access token', obj({ accessToken: str(), activeProfileId: int({ nullable: true }), profile: { ...ref('Profile'), nullable: true } })), ...errors(400, 401, 403, 404, 409, 429) } }) },
    '/me/activity/heartbeat': { post: op('Account', 'Daily time: beats for the active profile (every ~60 s while the app is open; offline beats queued up to 1 day). Also counts today (server time) for the Streak Bonus.', {
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
        '`sparks` entries are credited at once to the profile’s Sparks ledger (type explore_import, the entry’s `txId` as transaction id) and returned in `credited`. Purchases, scores and progress are stored as `pending_import` (Dress Up / Milestone 3). The nickname is not sent (it is pre-filled as the username and live-checked in Profile setup / Add child).',
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
          credited: obj({ sparks: int({ description: 'Explore Sparks credited to the ledger by this call' }) }),
          pending: obj({ sparks: int({ description: 'Sum of Explore Sparks still pending (normally 0)' }), purchases: int(), scores: int(), progress: int() }),
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
      responses: { 200: ok('Applied', obj({ applied: obj({ id: int(), sparks: int(), status: str({ enum: ['credited', 'reserved'], description: 'credited = in the ledger now; reserved = the account has no profile yet' }) }), referral: ref('ReferralView') })), ...errors(400, 401, 403, 409, 429) },
    }) },
    '/me/password': { post: op('Account', 'Change the password; every other device is logged out, this one stays logged in', {
      description: 'newPassword: 8–72 characters with a letter and a number. Every earlier access token stops working; use the returned one (the refresh token '
        + 'of this device stays valid). Errors: 401 `INVALID_CREDENTIALS` (current password wrong), 400 `VALIDATION_ERROR`, 403 `PARENT_MODE_REQUIRED` (a parent account while a child plays).',
      security: user, requestBody: body(obj({ currentPassword: str(), newPassword: str() }, ['currentPassword', 'newPassword'])),
      responses: { 200: ok('Changed', obj({ accessToken: str(), activeProfileId: int({ nullable: true }), otherSessionsEnded: int() })), ...errors(400, 401, 403, 429) } }) },
    '/me/settings': { patch: op('Account', 'Language, path (mode) and/or country for whoever is playing', {
      description: 'Independent: language (app language) → the account and its profile; contentLanguage, mode and country → its profile. Parent area: language → the account (contentLanguage, mode or country: 400 `NO_ACTIVE_PROFILE`). '
        + 'A parent’s child: 403 `PARENT_MODE_REQUIRED` (the parent sets a child’s path, language and country with PATCH /profiles/{id} from the parent area).',
      security: user, requestBody: body(obj({ language: str({ enum: ['en', 'gu'] }), contentLanguage: str({ enum: ['en', 'gu'] }), mode: str({ enum: ['sanatan', 'satsang'], nullable: true }), country: ref('CountryCode') }), false),
      responses: { 200: ok('Updated', obj({ account: ref('Account'), profile: { ...ref('Profile'), nullable: true } })), ...errors(400, 401, 403) } }) },

    '/profiles': {
      get: op('Profiles', 'List the account’s profiles', { security: user, responses: { 200: ok('Profiles'), ...errors(401) } }),
      post: op('Profiles', 'Add a child profile (parent accounts, parent area; recorded parental consent)', {
        description: 'From the parent area no PIN is needed (a PIN sent anyway is checked). The first child can be added before the Parent PIN exists; later children need it (409 `PIN_NOT_SET`). From a child’s session: 403 `PARENT_MODE_REQUIRED`. The response carries the server’s age group.',
        security: user, requestBody: body(obj({ pin: str(), username: str(), avatarId: int(), dob: str({ format: 'date' }), language: str({ enum: ['en', 'gu'] }), contentLanguage: str({ enum: ['en', 'gu'] }), mode: str({ enum: ['sanatan', 'satsang'] }), country: ref('CountryCode'), parentalConsent: { type: 'boolean', enum: [true] } }, ['username', 'avatarId', 'dob', 'parentalConsent'])),
        responses: { 201: ok('Created', obj({ profile: ref('Profile') })), ...errors(400, 401, 403, 409, 429) } }),
    },
    '/profiles/{id}': {
      patch: op('Profiles', 'Change username, avatar, app / content language, mode or country', {
        description: 'Parent area: any own child, no PIN. A parent session playing as one child editing a sibling: PIN required. The active profile itself: an adult changes avatar / language / mode / country; a parent’s child only its avatar (language, contentLanguage, mode or country without the PIN: 403 `PIN_REQUIRED`; username: 403 `USERNAME_PARENT_ONLY`). Username errors: 400 `USERNAME_*`.',
        security: user, parameters: [idParam], requestBody: body(obj({ username: str(), avatarId: int(), language: str({ enum: ['en', 'gu'] }), contentLanguage: str({ enum: ['en', 'gu'] }), mode: str({ enum: ['sanatan', 'satsang'], nullable: true }), country: ref('CountryCode'), pin: str() }), false),
        responses: { 200: ok('Updated', obj({ profile: ref('Profile') })), ...errors(400, 401, 403, 404, 429) } }),
      delete: op('Profiles', 'Delete one child profile and all its data with the Parent PIN; the parent account and other children are unaffected', {
        description: 'Parent area only (403 `PARENT_MODE_REQUIRED` while a child plays; 403 `NOT_A_CHILD_PROFILE`). Irreversible. Devices playing as that child are logged out. '
          + 'PIN errors: 401 `PIN_INCORRECT` (details.attemptsLeft), 429 `PIN_LOCKED` (details.retryAfterSeconds).',
        security: user, parameters: [idParam], requestBody: body(obj({ pin: str(), confirm: { type: 'boolean', enum: [true] } }, ['pin', 'confirm'])),
        responses: { 200: ok('Deleted', obj({ deleted: bool(), profileId: int(), sessionsEnded: int() })), ...errors(400, 401, 403, 404, 429) } }),
    },
    '/profiles/{id}/student-status': { put: op('Profiles', 'Answer "Currently enrolled in Loyadham Online Classes (Bals-Balikas or Kishor-Kishori Classes)?" for one profile', {
      description: 'enrolled true → `pending_verification`; enrolled false + interested true → `interested`; enrolled false + interested false → `not_enrolled` (interested missing: 400 `INTERESTED_REQUIRED`). '
        + 'An independent account answers for its own profile; a parent for each own child from the parent area (from a child’s session: `pin` required, else 403 `PARENT_MODE_REQUIRED`). Another account’s profile: 404 `PROFILE_NOT_FOUND`. '
        + 'Once a Full Admin has verified it (`verified`) or confirmed the interest (`interest_confirmed`): 409 `STUDENT_STATUS_LOCKED`. Audited as student.status_set (profile id only).',
      security: user, parameters: [idParam], requestBody: body(obj({ enrolled: bool(), interested: bool(), pin: str({ description: 'Parent PIN; only needed from a child’s session' }) }, ['enrolled'])),
      responses: { 200: ok('Updated', obj({ profile: ref('Profile') })), ...errors(400, 401, 403, 404, 409, 429) } }) },
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

    '/profiles/{id}/sparks': { get: op('Sparks', 'Sparks of one playable profile: balance, lifetimeEarned, lifetimeSpent, pending', {
      description: 'Own profile (independent account), or a child from the parent area. From a child’s session only that child (a sibling → 403 PARENT_MODE_REQUIRED). Another account’s profile → 404. Sparks are per profile, never pooled across a parent account; the server is authoritative.',
      security: user, parameters: [idParam],
      responses: { 200: ok('Balance', { allOf: [obj({ profileId: int() }), ref('SparksBalance')] }), ...errors(401, 403, 404) } }) },
    '/profiles/{id}/sparks/history': { get: op('Sparks', 'Sparks history of one playable profile, newest first (paged)', {
      description: 'Same access rules as GET /profiles/{id}/sparks. Admin notes and admin ids are not included.',
      security: user, parameters: [idParam, ...pageParams, sparksStatusParam],
      responses: { 200: ok('History', obj({ profileId: int(), page: int(), pageSize: int(), total: int(), items: { type: 'array', items: ref('SparksTransaction') } })), ...errors(400, 401, 403, 404) } }) },
    '/profiles/{id}/spin': {
      get: op('Home', 'Daily Spark Spin status of one profile: available, nextAvailableAt, the wheel segments', {
        description: 'Available 24 hours after this profile’s LAST successful spin (rolling, not calendar); an unclaimed spin never expires. Server time only. Same access rules as GET /profiles/{id}/sparks.',
        security: user, parameters: [idParam], responses: { 200: ok('Status', ref('SpinStatus')), ...errors(401, 403, 404) } }),
      post: op('Home', 'Spin: the server picks the segment (weighted) and credits the Sparks (ledger type daily_spin)', {
        description: 'Only the profile that is playing on this device (the session’s active profile), else 403 PROFILE_NOT_ACTIVE. Not available yet → 409 SPIN_NOT_AVAILABLE with details { nextAvailableAt }. The same transactionId again → 200 with the first result (duplicate: true); used for another Sparks transaction → 409 TRANSACTION_ID_CONFLICT.',
        security: user, parameters: [idParam], requestBody: body(obj({ transactionId: str({ maxLength: 64, description: 'Unique id from the app (UUID); a retry with the same id is processed once' }) }, ['transactionId'])),
        responses: { 201: ok('Spun', ref('SpinResult')), 200: ok('Already spun with this transactionId', ref('SpinResult')), ...errors(400, 401, 403, 404, 409) } }),
    },
    '/profiles/{id}/streak': { get: op('Home', 'Streak Bonus of one profile: currentStreak, unclaimed, lastActiveDay (America/New_York game days)', {
      description: 'Read only. A streak whose last counted day is before yesterday is broken: it reads 0 / 0 and the unclaimed bonus is lost. Same access rules as GET /profiles/{id}/sparks.',
      security: user, parameters: [idParam], responses: { 200: ok('Streak', ref('StreakView')), ...errors(401, 403, 404) } }) },
    '/profiles/{id}/streak/check-in': { post: op('Home', 'The app was opened: count today (once per game day) for the Streak Bonus', {
      description: 'Consecutive game days (America/New_York, DST-aware) add 1; a missed day restarts at 1 and loses the unclaimed bonus. Each counted day adds that day’s amount to the unclaimed bonus. The activity heartbeat (POST /profiles/activity) counts the active profile too. Only the playing profile (403 PROFILE_NOT_ACTIVE).',
      security: user, parameters: [idParam],
      responses: { 200: ok('Counted (or already counted today)', { allOf: [obj({ counted: bool(), added: int(), lost: int() }), ref('StreakView')] }), ...errors(401, 403, 404) } }) },
    '/profiles/{id}/streak/claim': { post: op('Home', 'Claim the unclaimed Streak Bonus (ledger type streak); resets only the unclaimed amount, never the streak', {
      description: 'Counts today first. Nothing to claim → 409 NOTHING_TO_CLAIM. The same transactionId again → 200 with the first result (duplicate: true). Only the playing profile (403 PROFILE_NOT_ACTIVE).',
      security: user, parameters: [idParam], requestBody: body(obj({ transactionId: str({ maxLength: 64, description: 'Unique id from the app (UUID); a retry with the same id is processed once' }) }, ['transactionId'])),
      responses: { 201: ok('Claimed', { allOf: [obj({ duplicate: bool(), claimed: int(), transactionId: str(), balance: ref('SparksBalance') }), ref('StreakView')] }), 200: ok('Already claimed with this transactionId'), ...errors(400, 401, 403, 404, 409) } }) },
    '/news': { get: op('Home', 'News & Updates: active items whose publish date has passed, pinned first, then newest first (public)', {
      description: 'English and Gujarati texts; gu is null when not written (show English).',
      parameters: [{ name: 'page', in: 'query', schema: int({ minimum: 1, default: 1 }) }, { name: 'pageSize', in: 'query', schema: int({ minimum: 1, maximum: 50, default: 20 }) }],
      responses: { 200: ok('News', obj({ page: int(), pageSize: int(), total: int(), items: { type: 'array', items: ref('News') } })), ...errors(400) } }) },
    '/feedback': { post: op('Home', 'Send feedback (bug | idea | other) for one of the account’s playable profiles', {
      description: 'Own profile, or a child from the parent area or that child’s own session (a sibling → 403 PARENT_MODE_REQUIRED). Rate limited: 5 per hour and 20 per day per account, plus per IP → 429 FEEDBACK_RATE_LIMITED.',
      security: user,
      requestBody: body(obj({ profileId: int(), category: str({ enum: ['bug', 'idea', 'other'] }), message: str({ minLength: 1, maxLength: 1000 }), appVersion: str({ maxLength: 32 }), device: str({ maxLength: 100 }) }, ['profileId', 'category', 'message'])),
      responses: { 201: ok('Received', obj({ id: int(), received: bool() })), ...errors(400, 401, 403, 404, 429) } }) },
    '/profiles/activity': { post: op('Profiles', 'Older heartbeat (1–300 s added to today; also counts today for the active profile’s Streak Bonus). The app uses POST /me/activity/heartbeat.', {
      security: user, requestBody: body(obj({ seconds: int({ minimum: 1, maximum: 300 }) }, ['seconds'])), responses: { 200: ok('ok'), ...errors(400, 401, 403) } }) },
    '/parent/report': { get: op('Parent PIN', 'Parent report: daily time and activity per child (parent mode only); each child also carries studentStatus, studentSparksReserved and its own sparks { balance, lifetimeEarned, lifetimeSpent, pending }', {
      security: user, parameters: [{ name: 'profileId', in: 'query', schema: int() }, { name: 'days', in: 'query', schema: int({ minimum: 1, maximum: 90, default: 7 }) }], responses: { 200: ok('Report'), ...errors(401, 403, 404) } }) },

    '/admin/auth/login': { post: op('Admin Auth', 'Step 1: email + password. With a deviceToken of one of this admin’s live trusted devices → logged in at once (step "done", no code; audited as admin.login_success { method: trusted_device }). Otherwise a 6-digit code is emailed (subject "<CODE> is your Satsang Spark admin login code", valid 10 minutes) and a single-use challenge token (10 minutes) is returned (step "email_otp"); deviceTokenInvalid: true when a deviceToken was sent but is not trusted (any more), so the panel can forget it. rememberMe (default false) is carried to verify-otp. Every completed sign-in emails all active Full Admins "Satsang Spark Admin – new sign-in" in the background (at most once per admin per 10 minutes). Wrong email or password: the same 401 INVALID_CREDENTIALS. 5 failures (password or code) lock the admin for 15 minutes: 429 ADMIN_LOCKED.', {
      requestBody: body(obj({ email: str(), password: str(), deviceToken: str({ description: 'From an earlier verify-otp with trustDevice: true' }), rememberMe: bool() }, ['email', 'password'])),
      responses: { 200: ok('Code emailed (step email_otp) or logged in on a trusted device (step done)', { oneOf: [obj({ step: str({ enum: ['email_otp'] }), challengeToken: str(), expiresInSeconds: int({ example: 600 }), resendAfterSeconds: int({ example: 60 }), deviceTokenInvalid: bool() }), ref('AdminLoginDone')] }), ...errors(400, 401, 429), 503: { description: 'EMAIL_FAILED: the code could not be sent', content: json(ref('Error')) } } }) },
    '/admin/auth/verify-otp': { post: op('Admin Auth', 'Step 2: the emailed code. Correct → the admin token (the challenge is used up), plus a refreshToken if rememberMe was true on login. trustDevice: true → this browser becomes a trusted device (max 10 per admin; the oldest is revoked) and a new deviceToken is returned once (audited as admin.device_trusted). Audited as admin.login_success { method: otp }. Errors: 401 OTP_INVALID (details.attemptsLeft), 401 OTP_EXPIRED (request a new code or log in again), 429 OTP_LOCKED after 5 wrong tries (log in again), 401 CHALLENGE_INVALID (used, replaced by a newer login, or expired), 429 ADMIN_LOCKED.', {
      requestBody: body(obj({ challengeToken: str(), code: str({ pattern: '^\\d{6}$', example: '123456' }), trustDevice: bool() }, ['challengeToken', 'code'])),
      responses: { 200: ok('Logged in', ref('AdminLoginDone')), ...errors(400, 401, 429) } }) },
    '/admin/auth/resend-otp': { post: op('Admin Auth', 'Email a new code for the same login; the previous code stops working and the 5 tries start again. At most once per 60 seconds (429 RESEND_TOO_SOON, details.retryAfterSeconds) and 5 times per login (429 RESEND_LIMIT). Not after OTP_LOCKED.', {
      requestBody: body(obj({ challengeToken: str() }, ['challengeToken'])),
      responses: { 200: ok('New code emailed', obj({ sent: bool(), expiresInSeconds: int({ example: 600 }), resendAfterSeconds: int({ example: 60 }), resendsLeft: int() })), ...errors(400, 401, 429), 503: { description: 'EMAIL_FAILED', content: json(ref('Error')) } } }) },
    '/admin/auth/invite/{token}': { get: op('Admin Auth', 'Public (rate limited): check an invite link before showing the choose-password page. 404 INVITE_INVALID (unknown, used, replaced or cancelled), 410 INVITE_EXPIRED (older than 48 hours: ask for a new one).', {
      parameters: [{ name: 'token', in: 'path', required: true, schema: str() }], responses: { 200: ok('Valid invite', obj({ email: str(), name: str(), role: str({ enum: ['full_admin', 'content_editor'] }) })), ...errors(404), 410: { description: 'INVITE_EXPIRED', content: json(ref('Error')) } } }) },
    '/admin/auth/accept-invite': { post: op('Admin Auth', 'Public (rate limited): accept an invite by choosing a password (12–72 chars). The admin becomes active and the link stops working; no token is returned: they then log in normally (password + email code). Audited as admin.invite_accepted.', {
      requestBody: body(obj({ token: str(), password: str({ description: '12–72 chars' }) }, ['token', 'password'])),
      responses: { 200: ok('Accepted', obj({ ok: bool(), email: str(), message: str() })), ...errors(400, 404), 410: { description: 'INVITE_EXPIRED', content: json(ref('Error')) } } }) },
    '/admin/auth/me': { get: op('Admin Auth', 'Who am I', { security: admin, responses: { 200: ok('Admin', obj({ admin: ref('Admin') })), ...errors(401) } }) },
    '/admin/auth/refresh': { post: op('Admin Auth', '"Remember me": a new admin token for a refresh token. The refresh token rotates (the old one stops working) and its 30 days start again. Not a new sign-in (no alert email, no audit entry). 401 REFRESH_INVALID when unknown, already used, expired, or after logout / password change / reset / role change / deactivation.', {
      requestBody: body(obj({ refreshToken: str() }, ['refreshToken'])),
      responses: { 200: ok('New tokens', obj({ token: str(), admin: ref('Admin'), refreshToken: str(), refreshExpiresAt: str({ format: 'date-time' }) })), ...errors(400, 401, 429) } }) },
    '/admin/auth/logout': { post: op('Admin Auth', 'End all of this admin’s sessions and revoke their refresh tokens. Trusted devices stay trusted.', { security: admin, responses: { 200: ok('ok'), ...errors(401) } }) },
    '/admin/auth/change-password': { post: op('Admin Auth', 'Change own password (12+ chars); sessions end, refresh tokens and every trusted device are revoked', {
      security: admin, requestBody: body(obj({ currentPassword: str(), newPassword: str() }, ['currentPassword', 'newPassword'])), responses: { 200: ok('ok'), ...errors(400, 401) } }) },

    '/admin/me/devices': { get: op('Admin Auth', 'Your own trusted devices (any role), newest first. Revoked ones are not listed.', { security: admin, responses: { 200: ok('Devices', obj({ devices: { type: 'array', items: ref('TrustedDevice') } })), ...errors(401) } }) },
    '/admin/me/devices/{id}': { delete: op('Admin Auth', 'Revoke one of your own trusted devices (its next login needs the emailed code). 404 DEVICE_NOT_FOUND if not yours or already revoked. Audited as admin.device_revoked { deviceId, reason: self }.', { security: admin, parameters: [idParam], responses: { 200: ok('Revoked', obj({ ok: bool(), revoked: bool() })), ...errors(401, 404) } }) },

    '/admin/admins': {
      get: op('Admin Management', 'List admins (Full Admin) with status active / invited / inactive. fullAdminLimit: max = MAX_FULL_ADMINS (default 3), used = active + invited Full Admins.', { security: admin, responses: { 200: ok('Admins', obj({ admins: { type: 'array', items: ref('ManagedAdmin') }, fullAdminLimit: obj({ max: int({ example: 3 }), used: int() }) })), ...errors(401, 403) } }),
      post: op('Admin Management', 'Invite an admin (Full Admin). Creates them as `invited` (no password, cannot log in) and emails "You\'ve been invited to the Satsang Spark Admin Panel" with a link `<ADMIN_PANEL_URL>/accept-invite?token=…` valid 48 hours. 409 ADMIN_EXISTS if any admin (active, invited or inactive) has this email; 409 FULL_ADMIN_LIMIT when inviting a Full Admin beyond MAX_FULL_ADMINS (active + invited count); 503 EMAIL_FAILED if the email cannot be sent (nothing is created). Audited as admin.invited.', {
        security: admin, requestBody: body(obj({ email: str({ format: 'email' }), name: str({ description: '1–100 chars; used in the email' }), role: str({ enum: ['full_admin', 'content_editor'] }) }, ['email', 'name', 'role'])), responses: { 201: ok('Invited', obj({ admin: ref('ManagedAdmin') })), ...errors(400, 401, 403, 409) } }),
    },
    '/admin/admins/{id}': {
      patch: op('Admin Management', 'Rename, change role, deactivate (`active: false`) or reactivate (`active: true`). Role change or deactivation ends their sessions. You cannot change your own role (400 CANNOT_DEMOTE_SELF) or deactivate yourself (400 CANNOT_DEACTIVATE_SELF); at least one active Full Admin must remain (409 LAST_FULL_ADMIN); promoting to Full Admin or reactivating a deactivated Full Admin beyond MAX_FULL_ADMINS: 409 FULL_ADMIN_LIMIT. Role change or deactivation also revokes their refresh tokens and every trusted device. `active` on an invited admin: 409 ADMIN_INVITED. Audited as admin.role_changed { from, to }, admin.deactivated, admin.reactivated. `isActive` is accepted as an older name for `active`.', {
        security: admin, parameters: [idParam], requestBody: body(obj({ name: str(), role: str({ enum: ['full_admin', 'content_editor'] }), active: bool() }), false), responses: { 200: ok('Updated', obj({ admin: ref('ManagedAdmin') })), ...errors(400, 401, 403, 404, 409) } }),
      delete: op('Admin Management', 'Cancel an invite: removes an admin who never accepted it (the link stops working). 409 ADMIN_NOT_INVITED for an admin who has accepted (deactivate them instead). Audited as admin.invite_cancelled.', {
        security: admin, parameters: [idParam], responses: { 200: ok('Cancelled', obj({ ok: bool(), cancelled: bool() })), ...errors(401, 403, 404, 409) } }),
    },
    '/admin/admins/{id}/resend-invite': { post: op('Admin Management', 'Email a new 48-hour invite link (the old link stops working). Only for invited admins (409 ADMIN_NOT_INVITED otherwise); 503 EMAIL_FAILED if the email cannot be sent. Audited as admin.invite_resent.', {
      security: admin, parameters: [idParam], responses: { 200: ok('Resent', obj({ admin: ref('ManagedAdmin') })), ...errors(401, 403, 404, 409) } }) },
    '/admin/admins/{id}/reset-password': { post: op('Admin Management', 'Emergency: set a new password for an admin who has accepted their invite (sessions end; refresh tokens and trusted devices revoked). 409 ADMIN_INVITED for an invited admin.', {
      security: admin, parameters: [idParam], requestBody: body(obj({ newPassword: str({ description: '12–72 chars' }) }, ['newPassword'])), responses: { 200: ok('ok'), ...errors(400, 401, 403, 404, 409) } }) },

    '/admin/admins/{id}/devices': {
      get: op('Admin Management', 'An admin’s trusted devices (Full Admin)', { security: admin, parameters: [idParam], responses: { 200: ok('Devices', obj({ devices: { type: 'array', items: ref('TrustedDevice') } })), ...errors(401, 403, 404) } }),
      delete: op('Admin Management', 'Revoke all of an admin’s trusted devices (Full Admin); revoked = how many. Audited as admin.device_revoked { all: true, count, reason: full_admin }.', { security: admin, parameters: [idParam], responses: { 200: ok('Revoked', obj({ ok: bool(), revoked: int() })), ...errors(401, 403, 404) } }),
    },
    '/admin/admins/{id}/devices/{deviceId}': { delete: op('Admin Management', 'Revoke one trusted device of an admin (Full Admin). 404 DEVICE_NOT_FOUND. Audited as admin.device_revoked { deviceId, reason: full_admin }.', {
      security: admin, parameters: [idParam, { name: 'deviceId', in: 'path', required: true, schema: int() }], responses: { 200: ok('Revoked', obj({ ok: bool(), revoked: bool() })), ...errors(401, 403, 404) } }) },

    '/admin/users': { get: op('Admin Users', 'The Users table (Full Admin): one row per playable profile, grouped by account, with filters and sorting', {
      description: 'View only: there is no POST here; app accounts are created only in the app. '
        + 'Rows come in families: first the account row (an adult with its own profile, or a parent account, which has no profile: profileId null), then each child profile as its own row (accountType child, parentAccountId set, email = the parent\'s email with isParentEmail true, name null). '
        + 'Filters (q on name/username/email, country, ageGroup, accountType, classStatus, studentStatus) match single rows; a family is listed when any of its rows matches, its account row always first (matched: false when only a child matched; the panel greys it) and only the matching children after it. '
        + '`sort` orders families by their account row (empty values last) and children inside a family by the same column. page, pageSize and totalAccounts count families. '
        + '`classStatus`: verified; pending_verification; interested (+ interest_confirmed); not_enrolled (+ not_asked). The older `studentStatus` (one StudentStatus or a comma list, e.g. `pending_verification,interested`) still works and combines with the rest. '
        + 'dob (YYYY-MM-DD) is returned here only: Full Admin; the app API never returns an account DOB. `countries` lists every country present on a profile (for the filter dropdown).',
      security: admin, parameters: [
        { name: 'q', in: 'query', schema: str(), description: 'Name, username or email (contains, case-insensitive)' },
        { name: 'country', in: 'query', schema: str({ example: 'IN' }) },
        { name: 'ageGroup', in: 'query', schema: str({ enum: AGE_GROUP_KEYS }), description: 'Age group key' },
        { name: 'accountType', in: 'query', schema: str({ enum: ['adult', 'parent', 'child'] }) },
        { name: 'classStatus', in: 'query', schema: str({ enum: ['all', 'verified', 'pending_verification', 'interested', 'not_enrolled'] }) },
        { name: 'studentStatus', in: 'query', schema: str({ example: 'pending_verification,interested' }), description: 'Older filter: one StudentStatus or a comma list of them' },
        { name: 'joinedSince', in: 'query', schema: str({ format: 'date-time' }), description: 'Accounts created at or after this instant (account rows only); the dashboard sends totals.todayStartsAt' },
        { name: 'sort', in: 'query', schema: str({ enum: ['name', 'username', 'accountType', 'country', 'dob', 'ageGroup', 'email', 'joined', 'sparks'] }), description: 'Default joined. sparks: by sparksBalance (parent account rows have none, so parent families come last; their children are ordered inside)' },
        { name: 'order', in: 'query', schema: str({ enum: ['asc', 'desc'] }), description: 'Default desc for joined and sparks, asc otherwise' },
        { name: 'page', in: 'query', schema: int() }, { name: 'pageSize', in: 'query', schema: int({ description: 'Families per page (max 100)' }) }],
      responses: { 200: ok('Page of families', obj({ page: int(), pageSize: int(), sort: str(), order: str(), totalAccounts: int(), totalRows: int({ description: 'Rows matching the filters themselves (greyed parent rows not counted); equals the dashboard card for the same filter' }), countries: { type: 'array', items: str() }, rows: { type: 'array', items: obj({
        accountId: int(), parentAccountId: int({ nullable: true }), profileId: int({ nullable: true }), accountType: str({ enum: ['adult', 'parent', 'child'] }), isChild: bool(),
        name: str({ nullable: true, description: 'Account owner first + last name; null on child rows' }), username: str({ nullable: true }), country: str({ nullable: true }),
        dob: str({ format: 'date', nullable: true }), ageGroup: str({ nullable: true, description: 'Label' }), ageGroupKey: str({ nullable: true }), ageGroupOverridden: bool(),
        email: str(), isParentEmail: bool(), studentStatus: { ...ref('StudentStatus'), nullable: true }, emailVerified: bool(),
        joined: str({ format: 'date-time' }), createdAt: str({ format: 'date-time' }),
        sparksBalance: int({ nullable: true, description: 'Sparks balance of the playable profile (0 before its first Sparks); null on a parent account row (no profile of its own)' }),
        matched: bool() }) } })), ...errors(400, 401, 403) } }) },
    '/admin/users/export.csv': { get: op('Admin Users', 'Export the Users table as CSV (Full Admin)', {
      description: 'The same rows as GET /admin/users for the same filters and sort (q, country, ageGroup, accountType, classStatus, studentStatus, joinedSince, sort, order), every family (no pages): account row first, then its matching children. '
        + 'Columns, in the panel’s order: Name, Username, Account type, Country (name), DOB (YYYY-MM-DD), Age group, Email (a child row has the parent’s email), Class status, Joined (DASHBOARD_TIMEZONE, "YYYY-MM-DD HH:MM"), then Account ID, Profile ID, Parent account ID so families stay linked. '
        + 'UTF-8 with a BOM (Gujarati opens correctly in Excel), RFC 4180 quoting, CRLF line ends; text starting with = + - @ gets a leading apostrophe so it never runs as a formula. '
        + 'File name satsang-spark-users-YYYY-MM-DD.csv. Audited as users.exported { count, filters }.',
      security: admin, parameters: ['q', 'country', 'ageGroup', 'accountType', 'classStatus', 'studentStatus', 'joinedSince', 'sort', 'order'].map((name) => ({ name, in: 'query', schema: str(), description: 'As GET /admin/users' })),
      responses: { 200: { description: 'CSV file', content: { 'text/csv': { schema: str() } } }, ...errors(400, 401, 403) } }) },
    '/export/sheet': { get: op('Export', 'The Users table for the Google Sheet (server-to-server, X-Export-Key)', {
      description: 'For the Admin Panel repo’s docs/google-sheet/Code.gs (setup: docs/google-sheet/SETUP.md there). Send header X-Export-Key = SHEET_EXPORT_KEY (compared in constant time). 404 when SHEET_EXPORT_KEY is empty (export off); 401 EXPORT_KEY_INVALID for a missing or wrong key; 429 after 30 calls per hour. No CORS (browser pages cannot read it); no admin token. '
        + 'Every family, newest first, the same columns as the CSV export: columns[] gives key, label and type (string | date | datetime | number); each row is an array in that order (null = empty). joined is ISO UTC, dob YYYY-MM-DD. Nothing else is returned (no hashes, tokens, phone or gender). Audited as sheet.export { count }.',
      parameters: [{ name: 'X-Export-Key', in: 'header', required: true, schema: str() }],
      responses: { 200: ok('Rows', obj({ generatedAt: str({ format: 'date-time' }), columns: { type: 'array', items: obj({ key: str(), label: str(), type: str({ enum: ['string', 'date', 'datetime', 'number'] }) }) },
        rows: { type: 'array', items: { type: 'array', items: { nullable: true } } } })), ...errors(401, 404, 429) } }) },
    '/admin/users/{accountId}': { get: op('Admin Users', 'The "View" page: one account with all its profiles (logged in the audit log as user.viewed)', {
      security: admin, parameters: [{ name: 'accountId', in: 'path', required: true, schema: int() }],
      responses: { 200: ok('Account detail', obj({
        account: obj({ id: int(), email: str(), accountType: str({ enum: ['adult', 'parent'] }), phone: str({ nullable: true }), language: str({ enum: ['en', 'gu'] }),
          firstName: str({ nullable: true, description: 'Private: this detail page only' }), lastName: str({ nullable: true }), gender: str({ enum: ['male', 'female', 'prefer_not_to_say'], nullable: true }),
          emailVerified: bool(), emailVerifiedAt: str({ nullable: true, description: 'UTC' }), parentPinSet: bool(),
          privacyPolicyVersion: str({ nullable: true }), consentAcceptedAt: str({ nullable: true, description: 'UTC' }), createdAt: str({ description: 'UTC' }) }),
        profiles: { type: 'array', items: obj({ id: int(), username: str(), avatarId: int(), avatarKey: str(), dob: str({ format: 'date' }), age: int(),
          ageGroup: ref('AgeGroup'), ageGroupOverridden: bool(), isChild: bool(), language: str({ enum: ['en', 'gu'] }),
          mode: str({ enum: ['sanatan', 'satsang'], nullable: true }), createdAt: str({ description: 'UTC' }),
          studentStatus: ref('StudentStatus'), studentStatusUpdatedAt: str({ format: 'date-time', nullable: true, description: 'UTC; last change by the user or an admin' }),
          studentVerifiedBy: int({ nullable: true, description: 'admins.id of the Full Admin who last verified / confirmed (cleared by reset)' }),
          studentVerifiedByName: str({ nullable: true, description: 'That admin’s name (or email when no name is set); null when studentVerifiedBy is null' }),
          studentVerifiedAt: str({ format: 'date-time', nullable: true, description: 'UTC' }),
          studentSparksAwarded: int({ description: 'Total Sparks given for the student status (kept after a reset)' }) }) },
      })), ...errors(401, 403, 404) } }),
      delete: op('Admin Users', 'Permanently delete an account and all its profiles (for a parent: the parent account and every child profile). Ends the user’s sessions and emails the owner (the parent) a deletion confirmation. A completed deletion entry (source admin) keeps the email and username for RETAINED_EMAIL_DAYS. Reason is required and audited as user.deleted.', {
        security: admin, parameters: [{ name: 'accountId', in: 'path', required: true, schema: int() }],
        requestBody: body(obj({ confirm: { type: 'boolean', enum: [true] }, reason: str({ description: '3–200 chars' }) }, ['confirm', 'reason'])),
        responses: { 200: ok('Deleted', obj({ deleted: bool(), accountId: int(), profilesDeleted: int() })), ...errors(400, 401, 403, 404) } }) },
    '/admin/users/profiles/{id}': { delete: op('Admin Users', 'Delete ONE child profile (Full Admin)', {
      description: 'Removes only that child profile and its own data: progress, daily activity, Explore imports, student status and its reserved Sparks rewards. The parent account and every other child keep their accounts, progress and Sparks. Devices playing as that child are logged out. '
        + 'A completed deletion entry (target child_profile, source admin) keeps the child’s username and the parent’s email for RETAINED_EMAIL_DAYS. Audited as child.deleted with { profileId, parentAccountId, requestId, reason }. '
        + 'An adult’s own profile: 409 NOT_A_CHILD_PROFILE (delete the account instead).',
      security: admin, parameters: [idParam],
      requestBody: body(obj({ confirm: { type: 'boolean', enum: [true] }, reason: str({ description: '3–200 chars' }) }, ['confirm', 'reason'])),
      responses: { 200: ok('Deleted', obj({ deleted: bool(), profileId: int(), parentAccountId: int(), sessionsEnded: int() })), ...errors(400, 401, 403, 404, 409) } }) },
    '/admin/users/profiles/{id}/age-group': { patch: op('Admin Users', 'Manually set an age group (or null to go back to the DOB-derived group). Reason is required and audited.', {
      security: admin, parameters: [idParam], requestBody: body(obj({ ageGroup: { ...ref('AgeGroup'), nullable: true }, reason: str() }, ['ageGroup', 'reason'])), responses: { 200: ok('Updated'), ...errors(400, 401, 403, 404) } }) },

    '/admin/profiles/{id}/student-status': { post: op('Admin Users', 'Verify / reject an enrolment, confirm an interest, or reset a profile’s student status (Full Admin)', {
      description: '`verify`: pending_verification → verified, +STUDENT_VERIFIED_SPARKS (default 10). `confirm_interest`: interested → interest_confirmed, +STUDENT_INTEREST_SPARKS (default 5). `reject`: pending_verification → not_enrolled, no Sparks. `reset`: any status except not_asked → not_asked; Sparks already given are not taken back. '
        + 'Any other combination: 409 `INVALID_STUDENT_TRANSITION`. Sparks go to this exact profile (a child’s go to the child), are reserved until the Milestone 2 Sparks ledger credits them, and each reward is given at most once per profile: after a reset, verifying again answers sparksAwarded 0. '
        + 'Content Editor: 403 `ROLE_FORBIDDEN`. Audited as student.verified / student.rejected / student.interest_confirmed / student.reset with the profile id only.',
      security: admin, parameters: [idParam], requestBody: body(obj({ action: str({ enum: ['verify', 'reject', 'confirm_interest', 'reset'] }) }, ['action'])),
      responses: { 200: ok('Updated', obj({ profileId: int(), studentStatus: ref('StudentStatus'), previousStatus: ref('StudentStatus'),
        sparksAwarded: int({ description: 'Sparks given by this action (0 for reject / reset, or when this reward was already given)' }),
        studentSparksAwarded: int({ description: 'The profile’s total student-status Sparks' }) })), ...errors(400, 401, 403, 404, 409) } }) },
    '/admin/blocked-words': {
      get: op('Admin Moderation', 'Username moderation list (Full Admin and Content Editor)', { security: admin, responses: { 200: ok('Words'), ...errors(401, 403) } }),
      post: op('Admin Moderation', 'Add a blocked or reserved word (English, Gujarati script, or transliteration)', {
        security: admin, requestBody: body(obj({ word: str(), kind: str({ enum: ['blocked', 'reserved'] }) }, ['word'])), responses: { 201: ok('Added'), ...errors(400, 401, 403, 409) } }),
    },
    '/admin/blocked-words/{id}': { delete: op('Admin Moderation', 'Remove a word', { security: admin, parameters: [idParam], responses: { 200: ok('Removed'), ...errors(401, 403, 404) } }) },

    '/admin/dashboard': { get: op('Admin Dashboard', 'Live numbers for the Admin Panel home page (Full Admin). "Today" and chart days are calendar days in DASHBOARD_TIMEZONE (default Asia/Kolkata; returned as timeZone). pendingDeletions = deletion requests with status pending. studentsToVerify = profiles with studentStatus pending_verification + interested (the Users page filter pending_verification,interested). Each card matches GET /admin/users totalRows: adultAccounts ↔ accountType=adult, parentAccounts ↔ accountType=parent, childProfiles ↔ accountType=child, studentsToVerify ↔ studentStatus=pending_verification,interested, newRegistrationsToday (accounts) ↔ joinedSince=todayStartsAt. ageGroup is the stored key; label is the display name (same as the app en.json). No emails or DOBs are returned.', {
      security: admin,
      parameters: [
        { name: 'days', in: 'query', schema: int({ enum: [7, 30], default: 7 }), description: 'New-registrations chart range' },
        { name: 'recent', in: 'query', schema: int({ minimum: 1, maximum: 50, default: 5 }), description: 'Rows in Recent registrations' },
        { name: 'activity', in: 'query', schema: int({ minimum: 1, maximum: 50, default: 10 }), description: 'Rows in Recent admin activity' },
      ],
      responses: { 200: ok('Dashboard', obj({
        generatedAt: str({ format: 'date-time' }), timeZone: str({ example: 'Asia/Kolkata', description: 'DASHBOARD_TIMEZONE' }),
        totals: obj({ accounts: int(), adultAccounts: int(), parentAccounts: int(), profiles: int(), childProfiles: int(), newRegistrationsToday: int(), todayStartsAt: str({ format: 'date-time', description: 'Start of today in timeZone, as UTC' }), pendingDeletions: int(),
          studentsToVerify: int(), studentsPendingVerification: int(), studentsInterested: int() }),
        ageGroups: { type: 'array', items: obj({ ageGroup: ref('AgeGroup'), label: str({ example: 'Yuvaks/Yuvatis A' }), count: int() }) },
        registrations: obj({ days: int(), total: int(), series: { type: 'array', items: obj({ date: str({ format: 'date' }), count: int() }) } }),
        modes: { type: 'array', items: obj({ key: str({ enum: ['sanatan', 'satsang', 'not_set'] }), count: int() }) },
        languages: { type: 'array', items: obj({ key: str({ enum: ['en', 'gu'] }), count: int() }) },
        recentRegistrations: { type: 'array', items: obj({ accountId: int(), profileId: int({ nullable: true }), type: str({ enum: ['adult', 'parent', 'child'] }), username: str({ nullable: true }), ageGroup: str({ nullable: true }), ageGroupLabel: str({ nullable: true }), createdAt: str({ description: 'UTC' }) }) },
        recentAdminActivity: { type: 'array', items: obj({ id: int(), adminId: int({ nullable: true }), adminName: str({ nullable: true }), adminEmail: str({ nullable: true }), action: str(), entityType: str({ nullable: true }), entityId: str({ nullable: true }), details: { type: 'object', nullable: true }, createdAt: str({ description: 'UTC' }) }) },
      })), ...errors(400, 401, 403) } }) },

    '/admin/deletion-requests': { get: op('Admin Deletion Requests', 'The Deletion requests page (Full Admin): one status tab, newest first. counts covers every status with the same q/source filters, for the tab badges (counts.pending is the sidebar badge).', {
      security: admin,
      parameters: [
        { name: 'status', in: 'query', schema: str({ enum: ['pending', 'completed', 'rejected', 'all'], default: 'pending' }) },
        { name: 'q', in: 'query', schema: str(), description: 'Username or email: the live ones on pending/rejected rows, and (Full Admin only) the retained username or email on completed rows until emailRetainedUntil. "123" or "#123" also matches request id 123.' },
        { name: 'source', in: 'query', schema: str({ enum: ['app', 'web', 'admin', 'all'], default: 'all' }) },
        { name: 'page', in: 'query', schema: int({ default: 1 }) }, { name: 'pageSize', in: 'query', schema: int({ default: 25, maximum: 100 }) },
      ],
      responses: { 200: ok('Page of requests', obj({ status: str(), page: int(), pageSize: int(), total: int(),
        counts: obj({ pending: int(), completed: int(), rejected: int(), all: int() }), rows: { type: 'array', items: ref('DeletionRequest') } })), ...errors(400, 401, 403) } }) },
    '/admin/deletion-requests/{id}': { get: op('Admin Deletion Requests', 'The "View" page: the request, the account and its profiles (no DOBs). Audited as deletion_request.viewed.', {
      security: admin, parameters: [idParam],
      responses: { 200: ok('Request detail', obj({ request: ref('DeletionRequest'),
        account: { ...obj({ id: int(), email: str(), accountType: str({ enum: ['adult', 'parent'] }), emailVerified: bool(), createdAt: str({ description: 'UTC' }) }), nullable: true, description: 'Null once completed' },
        profiles: { type: 'array', items: obj({ id: int(), username: str(), isChild: bool(), ageGroup: ref('AgeGroup'), avatarKey: str(), createdAt: str({ description: 'UTC' }) }) } })), ...errors(401, 403, 404) } }) },
    '/admin/deletion-requests/{id}/approve': { post: op('Admin Deletion Requests', 'Approve: permanently deletes the account and all its profiles (a parent’s child profiles too) and ends the user’s sessions. The owner is emailed a deletion confirmation (a mail failure never stops the deletion); the email is kept on the request for RETAINED_EMAIL_DAYS (Full Admins only). Audited as deletion_request.approved, without email or username.', {
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
        newUserWaitingForProfile: bool({ description: 'The new user reward is held: the account (a parent) has no playable profile yet; it is added to the first child profile when created' }),
        referrerWaitingForProfile: bool({ description: 'The referrer reward is held: the referrer account (a parent) has no playable profile yet; it goes to the first child profile when created' }),
      }) } })), ...errors(401, 403) },
    }) },
    '/admin/referrals/settings': {
      get: op('Admin Referrals', 'Referral settings (Full Admin)', { security: admin, responses: { 200: ok('Settings', obj({ settings: ref('ReferralSettings') })), ...errors(401, 403) } }),
      put: op('Admin Referrals', 'Change referral settings (Full Admin, audited as referral_settings.updated). Applies to codes entered from now on.', {
        security: admin, requestBody: body(ref('ReferralSettings')),
        responses: { 200: ok('Saved', obj({ settings: ref('ReferralSettings') })), ...errors(400, 401, 403) },
      }),
    },
    '/admin/profiles/{id}/sparks': { get: op('Admin Sparks', 'One playable profile’s Sparks balance (Full Admin)', {
      security: admin, parameters: [idParam],
      responses: { 200: ok('Balance', { allOf: [obj({ profileId: int(), accountId: int(), username: str(), isChild: bool() }), ref('SparksBalance')] }), ...errors(401, 403, 404) } }) },
    '/admin/profiles/{id}/sparks/history': { get: op('Admin Sparks', 'One profile’s Sparks ledger, newest first, with admin notes (Full Admin)', {
      security: admin, parameters: [idParam, ...pageParams, sparksStatusParam, { name: 'type', in: 'query', schema: str({ enum: SPARKS_TYPES }) }],
      responses: { 200: ok('History', obj({ profileId: int(), accountId: int(), username: str(), isChild: bool(), page: int(), pageSize: int(), total: int(), items: { type: 'array', items: ref('AdminSparksTransaction') } })), ...errors(400, 401, 403, 404) } }) },
    '/admin/profiles/{id}/sparks/adjust': { post: op('Admin Sparks', 'Add (amount > 0) or deduct (amount < 0) Sparks with a reason (Full Admin, audited as sparks.adjusted)', {
      description: 'Type admin_adjust. A deduction is a correction: it lowers the balance and lifetime earned, and can never take the balance below zero (409 INSUFFICIENT_SPARKS, details { balance, needed }). transactionId (optional) makes a retried click safe: the same id again returns 200 duplicate: true and is not audited again; the same id with another amount → 409 TRANSACTION_ID_CONFLICT.',
      security: admin, parameters: [idParam],
      requestBody: body(obj({ amount: int({ minimum: -1000000, maximum: 1000000, description: 'Not 0' }), reason: str({ minLength: 3, maxLength: 255 }), transactionId: str({ maxLength: 64 }) }, ['amount', 'reason'])),
      responses: {
        201: ok('Adjusted', { allOf: [obj({ duplicate: bool(), transaction: ref('AdminSparksTransaction'), profileId: int(), accountId: int(), username: str(), isChild: bool() }), ref('SparksBalance')] }),
        200: ok('Already done (same transactionId)'), ...errors(400, 401, 403, 404, 409),
      } }) },
    '/admin/sparks/config': {
      get: op('Admin Sparks', 'Sparks per activity and per age group (Full Admin). Seeded values are defaults to be confirmed by Loyadham.', {
        security: admin, responses: { 200: ok('Config', ref('SparksRewardConfig')), ...errors(401, 403) } }),
      put: op('Admin Sparks', 'Change Sparks per activity / age group, no app release needed (Full Admin, audited as sparks.config_changed with each from → to)', {
        description: 'Partial update: only the rows sent change; each activity + age group at most once; 0–10000 Sparks.',
        security: admin, requestBody: body(obj({ rewards: { type: 'array', minItems: 1, items: obj({ activity: str({ enum: REWARD_ACTIVITIES }), ageGroup: str({ enum: AGE_GROUP_KEYS }), sparks: int({ minimum: 0, maximum: 10000 }) }, ['activity', 'ageGroup', 'sparks']) } }, ['rewards'])),
        responses: { 200: ok('Saved', { allOf: [obj({ changed: { type: 'array', items: obj({ activity: str(), ageGroup: str(), from: int({ nullable: true }), to: int() }) } }), ref('SparksRewardConfig')] }), ...errors(400, 401, 403) } }),
    },
    '/admin/home/spin-segments': {
      get: op('Admin Home', 'Daily Spin wheel with weights and chance % (Full Admin). Built-in defaults to be confirmed by Loyadham (isDefault).', {
        security: admin, responses: { 200: ok('Wheel', obj({ isDefault: bool(), updatedBy: int({ nullable: true }), updatedAt: str({ nullable: true }), note: str(), segments: { type: 'array', items: obj({ index: int(), label: str({ nullable: true }), sparks: int(), weight: int(), chancePercent: { type: 'number' } }) } })), ...errors(401, 403) } }),
      put: op('Admin Home', 'Replace the wheel: 2–12 segments in order (Full Admin, audited spin.segments_changed with from → to)', {
        security: admin, requestBody: body(obj({ segments: { type: 'array', minItems: 2, maxItems: 12, items: obj({ label: str({ maxLength: 40 }), sparks: int({ minimum: 1, maximum: 10000 }), weight: int({ minimum: 1, maximum: 1000 }) }, ['sparks', 'weight']) } }, ['segments'])),
        responses: { 200: ok('Saved'), ...errors(400, 401, 403) } }),
    },
    '/admin/home/streak-bonus': {
      get: op('Admin Home', 'Streak Bonus amounts per streak day (Full Admin). Built-in defaults to be confirmed by Loyadham.', {
        security: admin, responses: { 200: ok('Amounts', obj({ isDefault: bool(), amounts: { type: 'array', items: int() }, updatedBy: int({ nullable: true }), updatedAt: str({ nullable: true }), note: str() })), ...errors(401, 403) } }),
      put: op('Admin Home', 'Replace the amounts: day 1, 2, … (1–30 values, 0–10000; days after the last use the last) (Full Admin, audited streak.amounts_changed)', {
        security: admin, requestBody: body(obj({ amounts: { type: 'array', minItems: 1, maxItems: 30, items: int({ minimum: 0, maximum: 10000 }) } }, ['amounts'])),
        responses: { 200: ok('Saved'), ...errors(400, 401, 403) } }),
    },
    '/admin/home/donate-url': {
      get: op('Admin Home', 'Donate button URL (Full Admin)', { security: admin, responses: { 200: ok('URL', obj({ donateUrl: str(), isDefault: bool(), defaultDonateUrl: str({ description: 'DONATE_URL setting' }), updatedBy: int({ nullable: true }), updatedAt: str({ nullable: true }) })), ...errors(401, 403) } }),
      put: op('Admin Home', 'Set the Donate URL: Loyadham’s official donation page (http(s)); empty hides the button (Full Admin, audited donate_url.changed)', {
        security: admin, requestBody: body(obj({ donateUrl: str({ maxLength: 255 }) }, ['donateUrl'])), responses: { 200: ok('Saved'), ...errors(400, 401, 403) } }),
    },
    '/admin/news': {
      get: op('Admin Home', 'All news items (Full Admin + Content Editor), pinned first then newest', {
        security: admin, parameters: [{ name: 'q', in: 'query', schema: str() }, { name: 'status', in: 'query', schema: str({ enum: ['all', 'published', 'scheduled', 'inactive'] }) }, ...pageParams],
        responses: { 200: ok('News', obj({ page: int(), pageSize: int(), total: int(), items: { type: 'array', items: ref('AdminNews') } })), ...errors(400, 401, 403) } }),
      post: op('Admin Home', 'Create a news item (Full Admin + Content Editor, audited news.created)', {
        description: 'English title + body required; Gujarati optional. publishAt in the future = scheduled. active default true, pinned default false.',
        security: admin, requestBody: body(obj({ titleEn: str({ maxLength: 150 }), titleGu: str({ maxLength: 150, nullable: true }), bodyEn: str({ maxLength: 10000 }), bodyGu: str({ maxLength: 10000, nullable: true }), imageUrl: str({ nullable: true, description: 'https only' }), publishAt: str({ format: 'date-time', description: 'Default now (create)' }), active: bool(), pinned: bool() }, ['titleEn', 'bodyEn'])),
        responses: { 201: ok('Created', obj({ news: ref('AdminNews') })), ...errors(400, 401, 403) } }),
    },
    '/admin/news/{id}': {
      get: op('Admin Home', 'One news item', { security: admin, parameters: [idParam], responses: { 200: ok('News', obj({ news: ref('AdminNews') })), ...errors(401, 403, 404) } }),
      patch: op('Admin Home', 'Change any fields (audited news.updated with from → to; body texts only "changed")', {
        security: admin, parameters: [idParam], requestBody: body(obj({ titleEn: str({ maxLength: 150 }), titleGu: str({ maxLength: 150, nullable: true }), bodyEn: str({ maxLength: 10000 }), bodyGu: str({ maxLength: 10000, nullable: true }), imageUrl: str({ nullable: true, description: 'https only' }), publishAt: str({ format: 'date-time', description: 'Default now (create)' }), active: bool(), pinned: bool() })), responses: { 200: ok('Updated', obj({ news: ref('AdminNews') })), ...errors(400, 401, 403, 404) } }),
      delete: op('Admin Home', 'Delete a news item (audited news.deleted)', { security: admin, parameters: [idParam], responses: { 200: ok('Deleted', obj({ deleted: bool(), id: int() })), ...errors(401, 403, 404) } }),
    },
    '/admin/feedback': { get: op('Admin Home', 'App feedback, newest first (Full Admin); q = message or username, "#12" = id 12', {
      security: admin, parameters: [{ name: 'q', in: 'query', schema: str() }, { name: 'status', in: 'query', schema: str({ enum: ['all', 'open', 'resolved'] }) }, { name: 'category', in: 'query', schema: str({ enum: ['all', 'bug', 'idea', 'other'] }) }, ...pageParams],
      responses: { 200: ok('Feedback', obj({ page: int(), pageSize: int(), total: int(), openCount: int(), items: { type: 'array', items: ref('Feedback') } })), ...errors(400, 401, 403) } }) },
    '/admin/feedback/{id}': { patch: op('Admin Home', 'Mark resolved or open again, with an optional note (Full Admin, audited feedback.resolved / feedback.reopened)', {
      security: admin, parameters: [idParam], requestBody: body(obj({ status: str({ enum: ['open', 'resolved'] }), note: str({ maxLength: 500, nullable: true }) }, ['status'])),
      responses: { 200: ok('Updated', obj({ feedback: ref('Feedback') })), ...errors(400, 401, 403, 404) } }) },
    '/admin/audit-log': { get: op('Admin Audit', 'Who changed what and when (Full Admin, read-only)', {
      security: admin, parameters: ['adminId', 'action', 'entityType', 'from', 'to', 'page', 'pageSize'].map((n) => ({ name: n, in: 'query', schema: str() })), responses: { 200: ok('Audit entries'), ...errors(401, 403) } }) },
  },
};
