const config = require('../config');
const { readText } = require('./appSettings');

// Shared pieces of the Home tab (Milestone 2, chunk 2.3A).

const FEEDBACK_CATEGORIES = ['bug', 'idea', 'other'];
const FEEDBACK_PER_HOUR = 5;    // per account (all its profiles), rolling hour
const FEEDBACK_PER_DAY = 20;    // per account, rolling 24 h

/**
 * Features the app shows as "Coming Soon" in V1 (contract: Leaderboards UI, Customize Profile Avatar; never
 * "Mascot"). Fixed values: turning one on is new scope.
 */
const FEATURES = { leaderboards: 'coming_soon', customizeAvatar: 'coming_soon' };

/** Donate button URL: the Full Admin's saved value, else DONATE_URL ("" = the app hides the button). */
const donateUrl = async () => (await readText('donate_url', config.donateUrl));

/** App view (both languages; the app picks by content language, falling back to English). Admin adds the rest. */
function newsView(r, { admin = false } = {}) {
  const v = {
    id: Number(r.id),
    title: { en: r.title_en, gu: r.title_gu ?? null },
    body: { en: r.body_en, gu: r.body_gu ?? null },
    imageUrl: r.image_url ?? null,
    publishAt: r.publish_at,
    pinned: !!r.is_pinned,
  };
  if (admin) {
    Object.assign(v, {
      active: !!r.is_active, createdBy: r.created_by == null ? null : Number(r.created_by),
      updatedBy: r.updated_by == null ? null : Number(r.updated_by), createdAt: r.created_at, updatedAt: r.updated_at,
    });
  }
  return v;
}

module.exports = { FEEDBACK_CATEGORIES, FEEDBACK_PER_HOUR, FEEDBACK_PER_DAY, FEATURES, donateUrl, newsView };
