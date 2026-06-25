const conversationService = require('../services/conversation.service');
const whatsappService = require('../services/whatsapp.service');
const agent = require('../agents/renessence.agent');
const logger = require('../utils/logger');
const db = require('../data/database');
const { isBotPaused } = require('../routes/dashboard.routes');

// H5: per-user lock — prevents concurrent agent.run() for the same phone number
const userLocks = new Map();
function withUserLock(phone, fn) {
  const prev = userLocks.get(phone) || Promise.resolve();
  const current = prev.then(fn, fn);
  userLocks.set(phone, current);
  current.finally(() => { if (userLocks.get(phone) === current) userLocks.delete(phone); });
  return current;
}

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
    return whatsappService.sendText(from, lang === 'nl'
      ? 'Sorry, ik kan alleen tekstberichten verwerken.'
      : 'Sorry, I can only process text messages.');
  }

  // Record an explicit booking-confirmation tap so book_appointment can verify
  // the customer actually confirmed (hard gate against skipping the confirmation).
  if (buttonReply?.id === 'confirm_booking') {
    conversationService.set(from, { bookingConfirmedAt: Date.now() });
  }

  // H1: block __RESUME__ from external WhatsApp users — only the dashboard may send it
  if (userMessage.startsWith('__RESUME__')) {
    logger.warn(`[${from}] External __RESUME__ attempt blocked`);
    return;
  }

  logger.info(`[${from}] ${name}: ${userMessage}`);

  // Always update the conversation record (upsert)
  db.logConversation(from, name, null, null);

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
    // Agent won't run, so we log the message here
    db.logMessage(from, 'user', userMessage);
    logger.info(`[${from}] Bot paused — message saved, agent skipped`);
    return;
  }

  // When not paused, the agent logs the message itself (after its DB restore,
  // so the restore doesn't incorrectly treat new customers as returning ones)
  try {
    await withUserLock(from, () => agent.run(from, name, userMessage));
  } catch (err) {
    logger.error('Agent unhandled error:', err.message, err.stack);
    const lang = conversationService.get(from)?.lang || 'en';
    await whatsappService.sendText(from, lang === 'nl'
      ? 'Er ging iets mis. Probeer het opnieuw of stuur een bericht naar welcome@renessence.com.'
      : 'Something went wrong. Please try again or reach us at welcome@renessence.com.');
  }
}

module.exports = { handle };
