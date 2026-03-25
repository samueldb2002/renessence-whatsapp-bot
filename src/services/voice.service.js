const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const OpenAI = require('openai');
const config = require('../config');
const logger = require('../utils/logger');

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

/**
 * Download media from WhatsApp Cloud API
 */
async function downloadWhatsAppMedia(mediaId) {
  try {
    // Step 1: Get media URL
    const mediaRes = await axios.get(
      `https://graph.facebook.com/v21.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${config.WHATSAPP_TOKEN}` } }
    );
    const mediaUrl = mediaRes.data.url;

    // Step 2: Download the actual file
    const fileRes = await axios.get(mediaUrl, {
      headers: { Authorization: `Bearer ${config.WHATSAPP_TOKEN}` },
      responseType: 'arraybuffer',
    });

    return fileRes.data;
  } catch (err) {
    logger.error('Failed to download WhatsApp media:', err.message);
    throw err;
  }
}

/**
 * Transcribe audio buffer using OpenAI Whisper
 */
async function transcribeAudio(audioBuffer, mimeType) {
  try {
    // Write to temp file (Whisper needs a file)
    const ext = mimeType?.includes('ogg') ? 'ogg' : mimeType?.includes('mp4') ? 'mp4' : 'ogg';
    const tmpFile = path.join(os.tmpdir(), `voice_${Date.now()}.${ext}`);
    fs.writeFileSync(tmpFile, Buffer.from(audioBuffer));

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpFile),
      model: 'whisper-1',
      language: 'nl', // Will auto-detect, but hint Dutch
    });

    // Clean up temp file
    fs.unlinkSync(tmpFile);

    logger.info('Voice transcription:', transcription.text);
    return transcription.text;
  } catch (err) {
    logger.error('Whisper transcription error:', err.message);
    throw err;
  }
}

/**
 * Full pipeline: download WhatsApp voice message and transcribe
 */
async function transcribeWhatsAppVoice(mediaId, mimeType) {
  const audioBuffer = await downloadWhatsAppMedia(mediaId);
  return transcribeAudio(audioBuffer, mimeType);
}

module.exports = { transcribeWhatsAppVoice, downloadWhatsAppMedia, transcribeAudio };
