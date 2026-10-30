/**
 * Campaign intro: a standard promotion message the bot sends at the start of
 * a fresh WhatsApp conversation, right before it answers the guest.
 *
 * First used for the "Say Hi" One-Month Pass (1–15 Sept 2026, Paula: share
 * the campaign first, then answer the question), then the PT promotion. Since
 * Oct 2026 the team sets it up in the dashboard: a promotion with "send an
 * intro message" on, its English and Dutch text and an optional poster
 * (settings.service.js, section "promotions"). Rules:
 *
 * - One promotion at a time can send an intro (enforced when saving).
 * - Once per guest per campaign (promo_messages_sent, atomic claim — a double
 *   inbound can never produce two promos).
 * - Only at the START of a fresh conversation: skipped when there was chat
 *   activity or a reminder in the last 24h, and on any button/list tap, so
 *   it never interrupts an ongoing booking flow (a "Confirm" tap must not be
 *   answered with a promotion).
 * - The promotion's dates only; outside them nothing is sent.
 * - WhatsApp guests only (the web-chat widget can't receive WhatsApp media).
 * - Dutch for guests we know or can see write Dutch, English otherwise.
 * - Failure here must never affect normal message handling — callers treat it
 *   as best-effort, and a failed send after a claim just means that guest
 *   skips the promo (logged), never that they get it twice.
 */
const fs = require('fs');
const path = require('path');
const db = require('../data/database');
const whatsappService = require('./whatsapp.service');
const logger = require('../utils/logger');
const settings = require('./settings.service');
const { DEFAULT_PROMOTIONS } = require('../config/default-promotions');

const CONVERSATION_GAP_MS = 24 * 60 * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, '../../public');
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://agent.renessence.zenithintelligence.ai';
const UPLOADED_POSTER = /^\/public\/campaign\/([0-9a-f-]{36})\.(jpg|png)$/;

const imageLogText = (promotion, caption) => `📷 ${promotion.name} image\n\n${caption}`;

/**
 * Is this logged chat line one of our campaign intros (not a real conversation)?
 * Intros are logged with their promotion id, so an edited text still counts.
 * Rows logged before that (Oct 2026) only have the text: matched against the
 * captions the code used to send.
 */
function isPromoMessage(content, campaignId) {
  if (campaignId) return true;
  return DEFAULT_PROMOTIONS.some(p => p.intro.enabled
    && ['en', 'nl'].some(lang => content === p.intro[lang] || content === imageLogText(p, p.intro[lang])));
}

/**
 * The poster's public URL, or null when there is none or it is gone: WhatsApp
 * accepts a send with a broken image URL and then delivers nothing, so a
 * missing poster means the text goes out alone.
 */
async function posterUrl(image) {
  if (!image) return null;
  const uploaded = UPLOADED_POSTER.exec(image);
  const exists = uploaded
    ? await Promise.resolve().then(() => db.campaignImageExists(uploaded[1])).catch(() => false)
    : fs.existsSync(path.join(PUBLIC_DIR, path.basename(image)));
  return exists ? `${PUBLIC_BASE_URL}${image}` : null;
}

// Words that only show up in Dutch messages (not "hallo", "je", "morgen",
// "dank", "wat" — German, French and English guests use those too; "hoi"
// stays: a bare "Hoi" is a very common Dutch opener). One is enough: a first message
// is short ("Hoi, kan ik een massage boeken?"), and a wrong guess only means
// the promo reads in the other language.
const DUTCH_WORDS = new Set([
  'ik', 'jij', 'jullie', 'wil', 'willen', 'graag', 'hoi', 'goedemorgen', 'goedemiddag', 'goedenavond',
  'afspraak', 'boeken', 'reserveren', 'kun', 'kunnen', 'een', 'het', 'niet', 'hoe', 'voor',
  'mijn', 'bedankt', 'vandaag', 'heb', 'hebben', 'nog', 'ook', 'welke', 'wanneer', 'waar',
  'zijn', 'zou', 'beschikbaar', 'behandeling', 'vraag', 'tijd',
]);
function looksDutch(text) {
  const words = String(text || '').toLowerCase().match(/[a-zà-ÿ]+/g) || [];
  return words.some(w => DUTCH_WORDS.has(w));
}

async function languageFor(from, text) {
  const known = await db.getGuestLanguage(from).catch(() => null);
  if (known === 'nl' || known === 'en') return known;
  return looksDutch(text) ? 'nl' : 'en';
}

/**
 * Send the running promotion's intro if this inbound qualifies. Call BEFORE
 * the agent runs (the current inbound is not yet logged, so getLastMessageAt
 * reflects the previous conversation). Returns true when the promo was sent.
 */
async function maybeSendIntroPromo(from, { text = '', isTap = false, now = new Date() } = {}) {
  const promotion = settings.introPromotion(now);
  if (!promotion) return false;
  if (String(from).startsWith('web_')) return false;
  if (isTap) return false; // a tap always answers an earlier bot message

  // Reminders aren't in the chat log: a reply to one is mid-conversation too.
  const [lastAt, lastReminderAt] = await Promise.all([db.getLastMessageAt(from), db.getLastReminderAt(from)]);
  for (const at of [lastAt, lastReminderAt]) {
    if (at && now - new Date(at) < CONVERSATION_GAP_MS) return false; // mid-conversation
  }

  if (!(await db.claimPromoMessage(promotion.id, from))) return false; // already had it (or DB flaky — fail closed)

  try {
    const lang = await languageFor(from, text);
    const caption = promotion.intro[lang] || promotion.intro.en;
    const url = await posterUrl(promotion.intro.image);
    if (url) {
      await whatsappService.sendImage(from, url, caption);
      await db.logMessage(from, 'assistant', imageLogText(promotion, caption), { campaignId: promotion.id });
    } else {
      await whatsappService.sendText(from, caption);
      await db.logMessage(from, 'assistant', caption, { campaignId: promotion.id });
    }
    logger.info(`[${from}] Intro promo sent (${promotion.id}, ${lang})`);
    return true;
  } catch (err) {
    logger.warn(`[${from}] Intro promo send failed (claim kept, will not retry):`, err.message);
    return false;
  }
}

module.exports = { maybeSendIntroPromo, isPromoMessage, looksDutch };
