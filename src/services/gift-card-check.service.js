const crypto = require('crypto');
const logger = require('../utils/logger');

// Old gift-card numbers from the Mindbody migration (31.10.25). When Mindbody
// migrated gift cards, hundreds of holders were left with their OLD number and
// no working new one — paying online with an old number errors out. We keep the
// old numbers here (SHA-256 hashed, never in plain text) so the bot can spot one
// a customer sends, explain the situation, and route them to the team for a
// manual transfer instead of letting them hit a confusing online error.

let hashSet = new Set();
try {
  const data = require('../data/old-gift-cards.json');
  hashSet = new Set(data.hashes || []);
  logger.info(`Loaded ${hashSet.size} old gift-card hashes for migration checks`);
} catch (err) {
  logger.warn('Could not load old-gift-cards.json — old-card detection disabled:', err.message);
}

/**
 * Normalize a gift-card number for matching: strip every non-alphanumeric
 * character (spaces, dashes, dots) and uppercase. MUST stay identical to the
 * normalization used when the hash file was generated, or matches will miss.
 */
function normalizeGiftCard(raw) {
  return String(raw || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

function hashGiftCard(normalized) {
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Is this gift-card number one of the OLD (pre-migration) numbers that no longer
 * works online? Returns false for empty/too-short input so a stray word never
 * false-positives.
 */
function isOldGiftCard(raw) {
  const norm = normalizeGiftCard(raw);
  if (norm.length < 3) return false;
  return hashSet.has(hashGiftCard(norm));
}

module.exports = { normalizeGiftCard, isOldGiftCard, _size: () => hashSet.size };
