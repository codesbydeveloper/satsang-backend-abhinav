const { query } = require('../db');

/**
 * Settings a Full Admin changes in the Admin Panel (table app_settings, audited). Each key has a default (used when
 * the row is missing) and a range; a NULL value means "not limited" where `nullable` is set.
 */
const REFERRAL_SETTINGS = {
  referral_new_user_sparks: { default: 25, min: 0, max: 10000 },
  referral_referrer_sparks: { default: 50, min: 0, max: 10000 },
  referral_window_hours: { default: 48, min: 1, max: 24 * 365 },
  referral_max_per_referrer: { default: null, min: 1, max: 1000000, nullable: true },   // unlimited until Loyadham decides
};

const toValue = (def, raw) => {
  if (raw === null || raw === undefined) return def.nullable ? null : def.default;
  const n = Number(raw);
  return Number.isInteger(n) ? n : def.default;
};

/** { key: number|null } for the given definitions. */
async function readSettings(defs = REFERRAL_SETTINGS, conn = null) {
  const keys = Object.keys(defs);
  const q = conn ? conn.query : query;
  const rows = await q(`SELECT setting_key, value FROM app_settings WHERE setting_key IN (${keys.map(() => '?').join(',')})`, keys);
  const byKey = new Map(rows.map((r) => [r.setting_key, r]));
  return Object.fromEntries(keys.map((k) => [k, byKey.has(k) ? toValue(defs[k], byKey.get(k).value) : defs[k].default]));
}

/** Saves the given values (already validated). Returns the settings after the change. */
async function writeSettings(values, adminId, defs = REFERRAL_SETTINGS) {
  for (const [k, v] of Object.entries(values)) {
    if (!defs[k]) continue;
    await query(
      'INSERT INTO app_settings (setting_key, value, updated_by) VALUES (?,?,?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by)',
      [k, v === null ? null : String(v), adminId]);
  }
  return readSettings(defs);
}

module.exports = { REFERRAL_SETTINGS, readSettings, writeSettings };
