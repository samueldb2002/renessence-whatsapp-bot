const conversationService = require('../services/conversation.service');
const whatsappService = require('../services/whatsapp.service');
const agent = require('../agents/renessence.agent');
const logger = require('../utils/logger');
const db = require('../data/database');
const introPromoService = require('../services/intro-promo.service');
const teamQueue = require('../services/team-queue.service');
const { isBotPaused } = require('../routes/dashboard.routes');
const { TEXT_ONLY_ACK } = require('../config/non-text');

// H5: per-user lock — prevents concurrent agent.run() for the same phone number
const { withUserLock } = require('../utils/user-lock');

async function handle(incomingMessage) {
  const { from, name, text, buttonReply, listReply } = incomingMessage;

  // Determine what the user said
  let userMessage;
  if (text) {
    userMessage = text;
  } else if (buttonReply?.id || listReply?.id) {
    userMessage = agent.decodeInput(buttonReply, listReply);
  } else {
    const lang = conversationService.get(from)?.lang || 'en';
    return handleNonText({
      from, name, type: incomingMessage.type || 'unsupported',
      ack: lang === 'nl' ? TEXT_ONLY_ACK.nl : TEXT_ONLY_ACK.en,
    });
  }

  // Record an explicit booking-confirmation tap so book_appointment can verify
  // the customer actually confirmed (hard gate against skipping the confirmation).
  if (buttonReply?.id === 'confirm_booking') {
    // A fresh tap opens a fresh gate: reset the per-confirmation usage so the
    // agent's "close a used gate at the next turn" sweep doesn't eat this tap.
    conversationService.set(from, { bookingConfirmedAt: Date.now(), bookingConfirmUsed: false, bookingsUnderConfirm: 0 });
  }

  // Remember whether the guest picked a specific therapist ("staff_<id>") or
  // "any" — a paid booking may only switch therapist when they didn't choose.
  const tappedId = buttonReply?.id || listReply?.id || '';
  if (tappedId.startsWith('staff_')) {
    conversationService.set(from, { therapistChoice: tappedId === 'staff_any' ? 'any' : Number(tappedId.slice(6)) || 'any' });
  }

  // Same hard gate for CANCELLING — the destructive one. Without this the model
  // could cancel a real booking off an ambiguous message (a customer asking
  // "did anyone cancel? is a later time possible?" had her booking destroyed).
  // cancel_appointments refuses to run unless this tap was recorded.
  if (buttonReply?.id === 'confirm_cancel') {
    conversationService.set(from, { cancelConfirmedAt: Date.now() });
  }

  // H1: block __RESUME__ from external WhatsApp users — only the dashboard may send it
  if (userMessage.startsWith('__RESUME__')) {
    logger.warn(`[${from}] External __RESUME__ attempt blocked`);
    return;
  }

  logger.info(`[${from}] ${name}: ${userMessage}`);

  // Always update the conversation record (upsert)
  db.logConversation(from, name, null, null);

  // Blocked number (fraud): record the incoming message so the team can still
  // see it in the dashboard, but do NOT run the bot and do NOT reply. Silent —
  // the sender gets no response and cannot book. Takes precedence over pause.
  if (await db.isBlocked(from)) {
    db.logMessage(from, 'user', userMessage);
    logger.info(`[${from}] Blocked number — message saved, bot silent`);
    return;
  }

  // Auto-unarchive: if this conversation was archived, move it back to the active inbox
  db.unarchiveConversation(from).catch(err =>
    logger.warn('Auto-unarchive error:', err.message)
  );

  // H11: global kill-switch check
  if (isBotPaused()) {
    logger.info(`[${from}] Bot globally paused — message dropped`);
    return;
  }

  // Per-customer pause check
  const paused = await db.isPaused(from);
  if (paused) {
    // Agent won't run, so we log the message here — and the team is the only
    // one who will answer, so the guest now needs a reply from us.
    await db.logMessage(from, 'user', userMessage);
    db.setNeedsReply(from, 'New message — bot is paused');
    // Their message re-opened WhatsApp's 24h window: deliver any team reply
    // that was waiting for exactly that.
    await teamQueue.deliverQueuedTeamMessages(from).catch(err => logger.warn('Queued team delivery failed:', err.message));
    logger.info(`[${from}] Bot paused — message saved, agent skipped`);
    return;
  }

  // "Say Hi" One-Month Pass + app intro (through 15 Sept 2026): once per
  // customer, only at the start of a fresh conversation, sent BEFORE the
  // agent's answer so it reads as "before we assist you". Must run before the
  // agent logs this inbound (the fresh-conversation check relies on that),
  // and its failure must never block normal handling.
  try {
    await introPromoService.maybeSendIntroPromo(from);
  } catch (err) {
    logger.warn('Intro promo error (ignored):', err.message);
  }

  // When not paused, the agent logs the message itself (after its DB restore,
  // so the restore doesn't incorrectly treat new customers as returning ones)
  try {
    await withUserLock(from, () => agent.run(from, name, userMessage));
    // A team reply parked for this guest (24h window) goes out now too.
    await teamQueue.deliverQueuedTeamMessages(from).catch(err => logger.warn('Queued team delivery failed:', err.message));
  } catch (err) {
    logger.error('Agent unhandled error:', err.message, err.stack);
    const lang = conversationService.get(from)?.lang || 'en';
    await whatsappService.sendText(from, lang === 'nl'
      ? 'Er ging iets mis. Probeer het opnieuw of stuur een bericht naar welcome@renessence.com.'
      : 'Something went wrong. Please try again or reach us at welcome@renessence.com.');
  }
}

/**
 * A guest message the bot can't answer as text (a photo without caption, a
 * sticker, a video…). It still counts as the guest writing: it re-opens
 * WhatsApp's 24h window (so parked team replies go out), and on a paused chat
 * it is the team's to answer — no automatic reply then.
 * @param {{from:string,name?:string,type:string,alreadyLogged?:boolean,ack?:string}} m
 */
async function handleNonText({ from, name, type, alreadyLogged = false, ack = null }) {
  db.logConversation(from, name, null, null);
  if (!alreadyLogged) await db.logMessage(from, 'user', `[${type} message]`);
  if (await db.isBlocked(from)) return;
  db.unarchiveConversation(from).catch(err => logger.warn('Auto-unarchive error:', err.message));

  if (await db.isPaused(from)) {
    db.setNeedsReply(from, `New ${type} — bot is paused`);
  } else if (ack && !isBotPaused()) {
    try {
      await whatsappService.sendText(from, ack);
      // Logged so the chat reads as answered (the outage catch-up replays
      // unanswered guest messages — it must not "answer" a sticker).
      await db.logMessage(from, 'assistant', ack);
    } catch (err) {
      logger.warn('Non-text ack failed:', err.message);
    }
  }
  await teamQueue.deliverQueuedTeamMessages(from).catch(err => logger.warn('Queued team delivery failed:', err.message));
}

module.exports = { handle, handleNonText };
