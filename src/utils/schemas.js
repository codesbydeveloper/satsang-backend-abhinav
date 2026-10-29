const { z } = require('zod');
const { isValidDob } = require('./ageGroup');
const { isCountryCode } = require('./countries');

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const password = z.string().min(8, 'Use at least 8 characters').max(72, 'Use at most 72 characters')
  .regex(/[A-Za-z]/, 'Include at least one letter').regex(/\d/, 'Include at least one number');
const username = z.string().trim().min(3).max(20);
const dob = z.string().refine(isValidDob, 'Enter a valid date of birth (YYYY-MM-DD) that is not in the future');
const avatarId = z.number().int().min(1).max(16);
const language = z.enum(['en', 'gu']);
const mode = z.enum(['sanatan', 'satsang']);
const pin = z.string().regex(/^\d{4}$/, 'PIN must be exactly 4 digits');
const code = z.string().regex(/^\d{6}$/, 'Code must be 6 digits');
const phone = z.string().trim().regex(/^\+?[0-9 ()\-]{7,20}$/, 'Enter a valid phone number');

// First / last name (Sign Up): letters of any script with their marks (Gujarati vowel signs are marks), spaces, '-'
// and apostrophes; 1–50 characters after trimming. A typographic apostrophe (iOS keyboards) is stored as '.
const NAME_RE = /^[\p{L}\p{M}' -]+$/u;
const nameProblem = (s) => {
  if (s.length < 1) return 'Enter a name';
  if (s.length > 50) return 'Use at most 50 characters';
  if (!NAME_RE.test(s)) return 'Use letters, spaces, - and \' only';
  if (!/\p{L}/u.test(s)) return 'Include at least one letter';
  return null;
};
// One message per field (the app shows it under the field).
const personName = z.string().transform((s) => s.normalize('NFC').replace(/[\u2018\u2019\u02BC]/g, "'").trim())
  .superRefine((s, ctx) => { const message = nameProblem(s); if (message) ctx.addIssue({ code: 'custom', message }); });
const gender = z.enum(['male', 'female', 'prefer_not_to_say']);
// Country / region of a profile: ISO 3166-1 alpha-2 ("IN", "US", "GB"; "in" is accepted and stored upper case). Private.
const country = z.string().trim().toUpperCase().refine(isCountryCode, 'Choose a country or region from the list');

module.exports = { email, password, username, dob, avatarId, language, mode, pin, code, phone, personName, gender, country, NAME_RE };
