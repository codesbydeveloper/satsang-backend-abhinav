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
    { name: 'Admin Auth' }, { name: 'Admin Management' }, { name: 'Admin Users' }, { name: 'Admin Moderation' }, { name: 'Admin Audit' },
  ],
  components: {
    securitySchemes: {
      userBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'App access token from login / verify-email / refresh.' },
      adminBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Admin token from the 2FA step (the step tokens from /admin/auth/login are only accepted by the TOTP endpoints).' },
    },
    schemas: {
      Error: obj({ error: obj({ code: str(), message: str(), details: { type: 'array', items: obj({ field: str(), message: str() }) } }) }),
      Profile: obj({
        id: int(), username: str(), avatarId: int({ minimum: 1, maximum: 16 }), ageGroup: str({ example: 'Bals/Balikas B' }),
        isChild: bool(), language: str({ enum: ['en', 'gu'] }), mode: str({ enum: ['sanatan', 'satsang'], nullable: true }),
        dob: str({ format: 'date', description: 'Only returned to the profile’s own account.' }), createdAt: str(),
      }),
      Account: obj({ id: int(), email: str(), accountType: str({ enum: ['adult', 'parent'] }), phone: str({ nullable: true }), language: str({ enum: ['en', 'gu'] }), emailVerified: bool(), parentPinSet: bool() }),
      AuthResponse: obj({ accessToken: str(), refreshToken: str(), account: ref('Account'), profiles: { type: 'array', items: ref('Profile') }, activeProfileId: int({ nullable: true }) }),
      Admin: obj({ id: int(), email: str(), name: str(), role: str({ enum: ['full_admin', 'content_editor'] }), totpEnabled: bool() }),
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
      responses: { 200: ok('Deleted'), ...errors(401, 429) } }) },

    '/auth/register': { post: op('Auth', 'Create an adult/independent or parent account and email a verification code', {
      requestBody: body(obj({
        email: str(), password: str({ description: '8–72 chars, at least one letter and one number' }), accountType: str({ enum: ['adult', 'parent'] }),
        phone: str({ description: 'Optional contact only — never used to log in' }), language: str({ enum: ['en', 'gu'] }),
        acceptPrivacyPolicy: { type: 'boolean', enum: [true] }, confirmAdult: { type: 'boolean', description: 'Required for parent accounts' },
        profile: obj({ username: str(), avatarId: int(), dob: str({ format: 'date' }), mode: str({ enum: ['sanatan', 'satsang'] }) }, ['username', 'avatarId', 'dob']),
      }, ['email', 'password', 'accountType', 'acceptPrivacyPolicy'])),
      responses: { 201: ok('Account created, verification email sent'), ...errors(400, 409, 429) } }) },
    '/auth/verify-email': { post: op('Auth', 'Confirm the 6-digit email code and start a session', {
      requestBody: body(obj({ email: str(), code: str() }, ['email', 'code'])), responses: { 200: ok('Logged in', ref('AuthResponse')), ...errors(400, 429) } }) },
    '/auth/resend-code': { post: op('Auth', 'Send a new verification code (always answers ok)', { requestBody: body(obj({ email: str() }, ['email'])), responses: { 200: ok('ok'), ...errors(429) } }) },
    '/auth/login': { post: op('Auth', 'Log in with email + password', {
      requestBody: body(obj({ email: str(), password: str() }, ['email', 'password'])), responses: { 200: ok('Logged in', ref('AuthResponse')), ...errors(401, 403, 429) } }) },
    '/auth/refresh': { post: op('Auth', 'Exchange a refresh token for a new pair (the old refresh token stops working)', {
      requestBody: body(obj({ refreshToken: str() }, ['refreshToken'])), responses: { 200: ok('New tokens', ref('AuthResponse')), ...errors(401) } }) },
    '/auth/logout': { post: op('Auth', 'End this device session', { security: user, responses: { 200: ok('ok'), ...errors(401) } }) },
    '/auth/forgot-password': { post: op('Auth', 'Email a password-reset code (always answers ok)', { requestBody: body(obj({ email: str() }, ['email'])), responses: { 200: ok('ok'), ...errors(429) } }) },
    '/auth/reset-password': { post: op('Auth', 'Set a new password with the emailed code; logs out every device', {
      requestBody: body(obj({ email: str(), code: str(), newPassword: str() }, ['email', 'code', 'newPassword'])), responses: { 200: ok('ok'), ...errors(400, 429) } }) },

    '/me': {
      get: op('Account', 'Current account, its profiles, and the active profile', { security: user, responses: { 200: ok('Account', obj({ account: ref('Account'), profiles: { type: 'array', items: ref('Profile') }, activeProfileId: int({ nullable: true }) })), ...errors(401) } }),
      patch: op('Account', 'Update phone or language', { security: user, requestBody: body(obj({ phone: str({ nullable: true }), language: str({ enum: ['en', 'gu'] }) }), false), responses: { 200: ok('Updated'), ...errors(400, 401) } }),
      delete: op('Account', 'Delete the account after password check. Deleting a parent account deletes every child profile.', {
        security: user, requestBody: body(obj({ password: str(), confirm: { type: 'boolean', enum: [true] } }, ['password', 'confirm'])), responses: { 200: ok('Deleted'), ...errors(400, 401) } }),
    },
    '/me/change-password': { post: op('Account', 'Change password; other devices are logged out and this device gets fresh tokens', {
      security: user, requestBody: body(obj({ currentPassword: str(), newPassword: str() }, ['currentPassword', 'newPassword'])), responses: { 200: ok('New session', ref('AuthResponse')), ...errors(400, 401) } }) },

    '/profiles': {
      get: op('Profiles', 'List the account’s profiles', { security: user, responses: { 200: ok('Profiles'), ...errors(401) } }),
      post: op('Profiles', 'Add a child profile (parent accounts; needs Parent PIN and recorded parental consent)', {
        security: user, requestBody: body(obj({ pin: str(), username: str(), avatarId: int(), dob: str({ format: 'date' }), language: str({ enum: ['en', 'gu'] }), mode: str({ enum: ['sanatan', 'satsang'] }), parentalConsent: { type: 'boolean', enum: [true] } }, ['pin', 'username', 'avatarId', 'dob', 'parentalConsent'])),
        responses: { 201: ok('Created', obj({ profile: ref('Profile') })), ...errors(400, 401, 403, 409, 429) } }),
    },
    '/profiles/{id}': {
      patch: op('Profiles', 'Change avatar, language or mode (a parent editing a child from parent mode must send the PIN)', {
        security: user, parameters: [idParam], requestBody: body(obj({ avatarId: int(), language: str({ enum: ['en', 'gu'] }), mode: str({ enum: ['sanatan', 'satsang'], nullable: true }), pin: str() }), false),
        responses: { 200: ok('Updated', obj({ profile: ref('Profile') })), ...errors(400, 401, 404, 429) } }),
      delete: op('Profiles', 'Delete one child profile with the Parent PIN; the parent account and siblings are unaffected', {
        security: user, parameters: [idParam], requestBody: body(obj({ pin: str(), confirm: { type: 'boolean', enum: [true] } }, ['pin', 'confirm'])), responses: { 200: ok('Deleted'), ...errors(400, 401, 403, 404, 429) } }),
    },
    '/profiles/{id}/switch': { post: op('Profiles', 'Switch this device to a child profile (Parent PIN required)', {
      security: user, parameters: [idParam], requestBody: body(obj({ pin: str() }, ['pin'])), responses: { 200: ok('New access token for the child profile'), ...errors(401, 403, 404, 429) } }) },
    '/profiles/parent-mode': { post: op('Profiles', 'Leave child mode and return to parent settings (Parent PIN required)', {
      security: user, requestBody: body(obj({ pin: str() }, ['pin'])), responses: { 200: ok('New access token in parent mode'), ...errors(401, 403, 429) } }) },

    '/parent/pin': { post: op('Parent PIN', 'Create the 4-digit Parent PIN (first time; needs the account password)', {
      security: user, requestBody: body(obj({ pin: str(), password: str() }, ['pin', 'password'])), responses: { 201: ok('Created'), ...errors(401, 403, 409) } }) },
    '/parent/pin/verify': { post: op('Parent PIN', 'Check the PIN. Five wrong tries lock it for 15 minutes.', {
      security: user, requestBody: body(obj({ pin: str() }, ['pin'])), responses: { 200: ok('Correct'), ...errors(401, 409, 429) } }) },
    '/parent/pin/reset': { post: op('Parent PIN', 'Forgot the PIN: set a new one with the account password (also clears a lock)', {
      security: user, requestBody: body(obj({ password: str(), newPin: str() }, ['password', 'newPin'])), responses: { 200: ok('Reset'), ...errors(401) } }) },

    '/profiles/activity': { post: op('Profiles', 'Heartbeat: add active seconds (1–300 per call) to today’s total for the active profile', {
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
    '/admin/users/{accountId}': { get: op('Admin Users', 'One account with its profiles (logged in the audit log)', {
      security: admin, parameters: [{ name: 'accountId', in: 'path', required: true, schema: int() }], responses: { 200: ok('Account detail'), ...errors(401, 403, 404) } }) },
    '/admin/users/profiles/{id}/age-group': { patch: op('Admin Users', 'Manually set an age group (or null to go back to the DOB-derived group). Reason is required and audited.', {
      security: admin, parameters: [idParam], requestBody: body(obj({ ageGroup: { ...ref('AgeGroup'), nullable: true }, reason: str() }, ['ageGroup', 'reason'])), responses: { 200: ok('Updated'), ...errors(400, 401, 403, 404) } }) },

    '/admin/blocked-words': {
      get: op('Admin Moderation', 'Username moderation list (Full Admin and Content Editor)', { security: admin, responses: { 200: ok('Words'), ...errors(401, 403) } }),
      post: op('Admin Moderation', 'Add a blocked or reserved word (English, Gujarati script, or transliteration)', {
        security: admin, requestBody: body(obj({ word: str(), kind: str({ enum: ['blocked', 'reserved'] }) }, ['word'])), responses: { 201: ok('Added'), ...errors(400, 401, 403, 409) } }),
    },
    '/admin/blocked-words/{id}': { delete: op('Admin Moderation', 'Remove a word', { security: admin, parameters: [idParam], responses: { 200: ok('Removed'), ...errors(401, 403, 404) } }) },

    '/admin/audit-log': { get: op('Admin Audit', 'Who changed what and when (Full Admin, read-only)', {
      security: admin, parameters: ['adminId', 'action', 'entityType', 'from', 'to', 'page', 'pageSize'].map((n) => ({ name: n, in: 'query', schema: str() })), responses: { 200: ok('Audit entries'), ...errors(401, 403) } }) },
  },
};
