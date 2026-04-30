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

  // Log to DB
  db.logConversation(from, name, null, null);

  // Run the AI agent
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
