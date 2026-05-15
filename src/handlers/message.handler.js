const conversationService = require('../services/conversation.service');
const whatsappService = require('../services/whatsapp.service');
const agent = require('../agents/renessence.agent');
const logger = require('../utils/logger');
const db = require('../data/database');

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

  logger.info(`[${from}] ${name}: ${userMessage}`);

  // Always update the conversation record (upsert)
  db.logConversation(from, name, null, null);

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
    await agent.run(from, name, userMessage);
  } catch (err) {
    logger.error('Agent unhandled error:', err.message, err.stack);
    const lang = conversationService.get(from)?.lang || 'en';
    await whatsappService.sendText(from, lang === 'nl'
      ? 'Er ging iets mis. Probeer het opnieuw of stuur een bericht naar welcome@renessence.com.'
      : 'Something went wrong. Please try again or reach us at welcome@renessence.com.');
  }
}

module.exports = { handle };
