/**
 * Normalize phone numbers to international format.
 * WhatsApp sends numbers like "31612345678" (no +).
 * Mindbody may store them as "+31612345678" or "0612345678".
 */
function normalize(phone) {
  if (!phone) return null;
  let cleaned = phone.replace(/[\s\-()]/g, '');

  // Already in full international format
  if (cleaned.startsWith('+')) return cleaned;

  // WhatsApp format: country code without +
  if (cleaned.startsWith('31') && cleaned.length >= 11) {
    return `+${cleaned}`;
  }

  // Dutch local format: 06xxxxxxxx
  if (cleaned.startsWith('0') && cleaned.length === 10) {
    return `+31${cleaned.slice(1)}`;
  }

  // Fallback: prepend +
  return `+${cleaned}`;
}

function toWhatsAppFormat(phone) {
  const normalized = normalize(phone);
  // WhatsApp API expects number without +
  return normalized ? normalized.replace('+', '') : null;
}

module.exports = { normalize, toWhatsAppFormat };
