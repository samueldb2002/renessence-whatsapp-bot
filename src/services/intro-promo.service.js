/**
 * Campaign intro: a standard promotion message the bot sends at the start of
 * a fresh WhatsApp conversation, right before it answers the guest.
 *
 * First used for the "Say Hi" One-Month Pass (1–15 Sept 2026, Paula: share
 * the campaign first, then answer the question). Now the PT promotion — "Buy a
 * Pass, get 1 complimentary PT session", 19 October – 1 November 2026 (team
 * launch document: "install the PT promotion as a standard WhatsApp message
 * for guests"). Rules:
 *
 * - Once per guest per campaign (promo_messages_sent, atomic claim — a double
 *   inbound can never produce two promos).
 * - Only at the START of a fresh conversation: skipped when there was chat
 *   activity or a reminder in the last 24h, and on any button/list tap, so
 *   it never interrupts an ongoing booking flow (a "Confirm" tap must not be
 *   answered with a promotion).
 * - Campaign window only; outside it nothing is sent (nothing to clean up).
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
const offering = require('../config/offering');

const CONVERSATION_GAP_MS = 24 * 60 * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, '../../public');
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://agent.renessence.zenithintelligence.ai';

const CAMPAIGNS = [
  {
    id: 'pt-promo-2026-10',
    label: 'PT promotion',
    start: offering.PT_PROMO_START,
    end: offering.PT_PROMO_END,
    // Optional poster: drop it into public/ under this (versioned) name and
    // redeploy; without it the message goes out as plain text.
    image: 'pt-promo-2026-10.jpg',
    caption: {
      en: `Before we help you, something we'd love to share ✨

*Buy a Pass, get a complimentary Personal Training session*

From now until 1 November, every *1 Month Pass* (€295), *3 Month Pass* (€275 per month) or *6 Month Pass* (€250 per month) comes with one personal training session, on us. After your purchase we'll connect you with one of our personal trainers, and you plan the session together.

Get your Pass at renessence.com/gym-and-members-club, in the Renessence app or at reception.

We look forward to welcoming you at Renessence.`,
      nl: `Voordat we je helpen, iets wat we graag met je delen ✨

*Koop een Pass en krijg een gratis Personal Training-sessie*

Tot en met 1 november krijg je bij elke *1 Month Pass* (€295), *3 Month Pass* (€275 per maand) of *6 Month Pass* (€250 per maand) een personal training-sessie cadeau. Na je aankoop brengen we je in contact met een van onze personal trainers, en plannen jullie samen de sessie in.

Je Pass koop je via renessence.com/gym-and-members-club, in de Renessence-app of bij de receptie.

We kijken ernaar uit je te verwelkomen bij Renessence.`,
    },
  },
];

const activeCampaign = (now) => CAMPAIGNS.find(c => now >= c.start && now < c.end) || null;
const imageLogText = (campaign, caption) => `📷 ${campaign.label} image\n\n${caption}`;

/** Is this logged chat line one of our campaign intros (not a real conversation)? */
function isPromoMessage(content) {
  return CAMPAIGNS.some(c => Object.values(c.caption).some(cap => content === cap || content === imageLogText(c, cap)));
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
 * Send the active campaign's message if this inbound qualifies. Call BEFORE
 * the agent runs (the current inbound is not yet logged, so getLastMessageAt
 * reflects the previous conversation). Returns true when the promo was sent.
 */
async function maybeSendIntroPromo(from, { text = '', isTap = false, now = new Date() } = {}) {
  const campaign = activeCampaign(now);
  if (!campaign) return false;
  if (String(from).startsWith('web_')) return false;
  if (isTap) return false; // a tap always answers an earlier bot message

  // Reminders aren't in the chat log: a reply to one is mid-conversation too.
  const [lastAt, lastReminderAt] = await Promise.all([db.getLastMessageAt(from), db.getLastReminderAt(from)]);
  for (const at of [lastAt, lastReminderAt]) {
    if (at && now - new Date(at) < CONVERSATION_GAP_MS) return false; // mid-conversation
  }

  if (!(await db.claimPromoMessage(campaign.id, from))) return false; // already had it (or DB flaky — fail closed)

  try {
    const lang = await languageFor(from, text);
    const caption = campaign.caption[lang] || campaign.caption.en;
    const imageFile = campaign.image && path.join(PUBLIC_DIR, campaign.image);
    if (imageFile && fs.existsSync(imageFile)) {
      await whatsappService.sendImage(from, `${PUBLIC_BASE_URL}/public/${campaign.image}`, caption);
      await db.logMessage(from, 'assistant', imageLogText(campaign, caption));
    } else {
      await whatsappService.sendText(from, caption);
      await db.logMessage(from, 'assistant', caption);
    }
    logger.info(`[${from}] Intro promo sent (${campaign.id}, ${lang})`);
    return true;
  } catch (err) {
    logger.warn(`[${from}] Intro promo send failed (claim kept, will not retry):`, err.message);
    return false;
  }
}

module.exports = { maybeSendIntroPromo, isPromoMessage, CAMPAIGNS, looksDutch };
