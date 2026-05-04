const express = require('express');
const config = require('../config');
const messageHandler = require('../handlers/message.handler');
const voiceService = require('../services/voice.service');
const logger = require('../utils/logger');

const router = express.Router();

// Deduplication: track recently processed message IDs (last 5 min)
const processedIds = new Map(); // messageId → timestamp
const DEDUP_TTL_MS = 5 * 60 * 1000;
function isDuplicate(messageId) {
  const now = Date.now();
  // Clean up old entries
  for (const [id, ts] of processedIds) {
    if (now - ts > DEDUP_TTL_MS) processedIds.delete(id);
  }
  if (processedIds.has(messageId)) return true;
  processedIds.set(messageId, now);
  return false;
}

// Meta webhook verification (GET)
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.WHATSAPP_VERIFY_TOKEN) {
    logger.info('Webhook verified successfully');
    return res.status(200).send(challenge);
  }
  logger.warn('Webhook verification failed');
  return res.sendStatus(403);
});

// Incoming messages (POST)
router.post('/', async (req, res) => {
  // Acknowledge immediately to prevent Meta retries
  res.sendStatus(200);

  try {
    // Check if bot is paused via dashboard
    const dashboardRoutes = require('./dashboard.routes');
    if (dashboardRoutes.isBotPaused()) {
      logger.info('Bot is paused — ignoring incoming message');
      return;
    }

    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    // Skip status updates (delivery receipts, read receipts)
    if (!value?.messages?.[0]) return;

    const message = value.messages[0];
    const contact = value.contacts?.[0];

    // Skip duplicate deliveries of the same message
    if (message.id && isDuplicate(message.id)) {
      logger.info('Duplicate message ignored:', message.id);
      return;
    }

    // Handle voice/audio messages
    let textContent = message.text?.body || '';
    if (message.type === 'audio' && message.audio?.id) {
      logger.info('Voice message received from', message.from, '- transcribing...');
      try {
        const transcription = await voiceService.transcribeWhatsAppVoice(
          message.audio.id,
          message.audio.mime_type
        );
        textContent = transcription;
        logger.info('Voice transcribed:', transcription);
      } catch (err) {
        logger.error('Voice transcription failed:', err.message);
        const whatsappService = require('../services/whatsapp.service');
        await whatsappService.sendText(message.from, "Sorry, I couldn't understand your voice message. Could you type your message instead?");
        return;
      }
    }

    await messageHandler.handle({
      from: message.from,
      name: contact?.profile?.name || '',
      type: message.type,
      text: textContent,
      buttonReply: message.interactive?.button_reply || null,
      listReply: message.interactive?.list_reply || null,
      timestamp: message.timestamp,
    });
  } catch (err) {
    logger.error('Webhook processing error:', err);
  }
});

module.exports = router;
