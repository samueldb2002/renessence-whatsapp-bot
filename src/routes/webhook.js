const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const messageHandler = require('../handlers/message.handler');
const voiceService = require('../services/voice.service');
const logger = require('../utils/logger');
const db = require('../data/database');

const router = express.Router();

// Verify Meta's X-Hub-Signature-256 header
function verifyWhatsAppSignature(req) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) {
    if (process.env.NODE_ENV !== 'development') {
      logger.error('WHATSAPP_APP_SECRET not set — refusing unverified webhook in production');
      return false;
    }
    logger.warn('WHATSAPP_APP_SECRET not set — skipping signature check (development only)');
    return true;
  }
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(req.rawBody || JSON.stringify(req.body)).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Deduplication: in-memory cache for hot path + DB fallback that survives restarts.
// Meta retries failed webhooks up to 24h — the DB layer catches retries that arrive
// after a redeploy cleared the in-memory map.
const processedIds = new Map(); // messageId → timestamp (hot cache)
const DEDUP_TTL_MS = 30 * 60 * 1000; // 30 min in-memory window

async function isDuplicate(messageId) {
  const now = Date.now();
  // Clean up stale in-memory entries
  for (const [id, ts] of processedIds) {
    if (now - ts > DEDUP_TTL_MS) processedIds.delete(id);
  }
  // Fast path: in-memory hit
  if (processedIds.has(messageId)) return true;
  // Slow path: check DB (handles retries after restart)
  const alreadyInDb = await db.isWebhookProcessed(messageId);
  if (alreadyInDb) {
    processedIds.set(messageId, now); // repopulate cache
    return true;
  }
  // Mark as processed in both layers
  processedIds.set(messageId, now);
  db.markWebhookProcessed(messageId).catch(() => {}); // fire-and-forget
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
  // Verify Meta signature before processing
  if (!verifyWhatsAppSignature(req)) {
    logger.warn('WhatsApp webhook signature verification failed — request rejected');
    return res.sendStatus(401);
  }

  // Acknowledge immediately to prevent Meta retries
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    // Skip status updates (delivery receipts, read receipts)
    if (!value?.messages?.[0]) return;

    const message = value.messages[0];
    const contact = value.contacts?.[0];

    // Skip duplicate deliveries of the same message (in-memory + DB-backed)
    if (message.id && await isDuplicate(message.id)) {
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
