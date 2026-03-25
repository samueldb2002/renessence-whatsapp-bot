const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

const API_URL = `https://graph.facebook.com/v21.0/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`;

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${config.WHATSAPP_TOKEN}`,
};

async function sendText(to, body) {
  try {
    await axios.post(
      API_URL,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body },
      },
      { headers }
    );
    logger.debug(`Sent text to ${to}: ${body.substring(0, 50)}...`);
  } catch (err) {
    logger.error('WhatsApp sendText error:', err.response?.data || err.message);
    throw err;
  }
}

async function sendButtons(to, bodyText, buttons) {
  try {
    await axios.post(
      API_URL,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: bodyText },
          action: {
            buttons: buttons.slice(0, 3).map((b) => ({
              type: 'reply',
              reply: { id: b.id, title: b.title.substring(0, 20) },
            })),
          },
        },
      },
      { headers }
    );
  } catch (err) {
    logger.error('WhatsApp sendButtons error:', err.response?.data || err.message);
    throw err;
  }
}

async function sendList(to, bodyText, buttonTitle, sections) {
  try {
    await axios.post(
      API_URL,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: bodyText },
          action: {
            button: buttonTitle.substring(0, 20),
            sections: sections.map((s) => ({
              title: s.title.substring(0, 24),
              rows: s.rows.slice(0, 10).map((r) => ({
                id: r.id,
                title: r.title.substring(0, 24),
                description: r.description ? r.description.substring(0, 72) : undefined,
              })),
            })),
          },
        },
      },
      { headers }
    );
  } catch (err) {
    logger.error('WhatsApp sendList error:', err.response?.data || err.message);
    throw err;
  }
}

async function sendCTAButton(to, bodyText, buttonTitle, url) {
  try {
    await axios.post(
      API_URL,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'cta_url',
          body: { text: bodyText },
          action: {
            name: 'cta_url',
            parameters: {
              display_text: buttonTitle.substring(0, 20),
              url,
            },
          },
        },
      },
      { headers }
    );
  } catch (err) {
    logger.error('WhatsApp sendCTAButton error:', err.response?.data || err.message);
    throw err;
  }
}

module.exports = { sendText, sendButtons, sendList, sendCTAButton };
