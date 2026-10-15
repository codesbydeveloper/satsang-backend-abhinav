const { z } = require('zod');
const { isValidDob } = require('./ageGroup');

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

module.exports = { email, password, username, dob, avatarId, language, mode, pin, code, phone };
