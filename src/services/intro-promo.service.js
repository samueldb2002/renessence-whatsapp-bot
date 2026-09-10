/**
 * "Say Hi" One-Month Pass + Renessence app intro (Sept 2026 campaign).
 *
 * Team request (Paula, 7 Sept): when people text on WhatsApp to ask a
 * question, the bot first shares the One-Month Pass campaign (with the poster
 * image) and the new app, then answers their question. Rules encoded here:
 *
 * - Once per customer, ever (intro_promo_sent table, atomic claim — a double
 *   inbound can never produce two posters).
 * - Only at the START of a fresh conversation: skipped when there was chat
 *   activity in the last 24h, so it never interrupts an ongoing booking flow
 *   (e.g. a "Confirm" tap must not be answered with a marketing poster).
 * - Campaign window only: the pass sign-up runs 1–15 Sept 2026; from 16 Sept
 *   the whole intro stops automatically (nothing to clean up after).
 * - WhatsApp customers only (web-chat widget can't receive WhatsApp media).
 * - Failure here must never affect normal message handling — callers treat it
 *   as best-effort, and a failed send after a claim just means that customer
 *   skips the promo (logged), never that they get it twice.
 */
const fs = require('fs');
const path = require('path');
const db = require('../data/database');
const whatsappService = require('./whatsapp.service');
const logger = require('../utils/logger');

// Server TZ is pinned to Europe/Amsterdam (server.js), so this is midnight
// Amsterdam time after the last sign-up day (15 Sept inclusive).
const CAMPAIGN_END = new Date('2026-09-16T00:00:00');
const CONVERSATION_GAP_MS = 24 * 60 * 60 * 1000;

// Versioned filename: if the team refreshes the poster again after go-live,
// ship it as -v3 etc. so WhatsApp/CDN caches can never serve the old design.
const IMAGE_FILE = path.join(__dirname, '../../public/one-month-pass-v2.jpg');
const IMAGE_URL = `${process.env.PUBLIC_BASE_URL || 'https://agent.renessence.zenithintelligence.ai'}/public/one-month-pass-v2.jpg`;

// Paula's draft, with WhatsApp formatting fixed (*single asterisks*, no stray
// spaces inside the markers — "* Renessence app*" would render literally).
const CAPTION = `Before we assist you, we'd love to share two new ways to make the most of your time at Renessence ✨

*Our One-Month Pass* gives you access to our *tech treatments and gym for a full month for €250* (instead of €400). A great way to create more balance in your routine while exploring everything Renessence has to offer. Limited availability — sign up until 15 September.

We've also just launched the *Renessence app* 📱 Discover our latest offerings, manage your bookings and stay up to date with upcoming *events and concerts* — all in one place.

We look forward to welcoming you at Renessence.`;

/**
 * Send the campaign intro if this inbound message qualifies. Call BEFORE the
 * agent runs (the current inbound is not yet logged, so getLastMessageAt
 * reflects the previous conversation). Returns true when the promo was sent.
 */
async function maybeSendIntroPromo(from, now = new Date()) {
  if (now >= CAMPAIGN_END) return false;
  if (String(from).startsWith('web_')) return false;

  const lastAt = await db.getLastMessageAt(from);
  if (lastAt && now - new Date(lastAt) < CONVERSATION_GAP_MS) return false; // mid-conversation

  if (!(await db.claimIntroPromo(from))) return false; // already had it (or DB flaky — fail closed)

  try {
    if (fs.existsSync(IMAGE_FILE)) {
      await whatsappService.sendImage(from, IMAGE_URL, CAPTION);
    } else {
      // Poster missing from the deploy — still deliver the message.
      await whatsappService.sendText(from, CAPTION);
    }
    db.logMessage(from, 'assistant', `📷 One-Month Pass campaign image\n\n${CAPTION}`);
    logger.info(`[${from}] Intro promo sent (One-Month Pass + app)`);
    return true;
  } catch (err) {
    logger.warn(`[${from}] Intro promo send failed (claim kept, will not retry):`, err.message);
    return false;
  }
}

module.exports = { maybeSendIntroPromo, CAPTION, CAMPAIGN_END };
