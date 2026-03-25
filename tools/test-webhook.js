/**
 * Simulate an incoming WhatsApp webhook payload for local testing.
 * Usage: node tools/test-webhook.js "Ik wil een massage boeken"
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const axios = require('axios');

const PORT = process.env.PORT || 3001;
const MESSAGE = process.argv[2] || 'Hallo';
const FROM = process.argv[3] || '31612345678';

const payload = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '123456789',
      changes: [
        {
          value: {
            messaging_product: 'whatsapp',
            metadata: {
              display_phone_number: '31201234567',
              phone_number_id: process.env.WHATSAPP_PHONE_NUMBER_ID,
            },
            contacts: [
              {
                profile: { name: 'Test Klant' },
                wa_id: FROM,
              },
            ],
            messages: [
              {
                from: FROM,
                id: `wamid.test_${Date.now()}`,
                timestamp: Math.floor(Date.now() / 1000).toString(),
                type: 'text',
                text: { body: MESSAGE },
              },
            ],
          },
          field: 'messages',
        },
      ],
    },
  ],
};

async function main() {
  console.log(`Sending test webhook to http://localhost:${PORT}/webhook`);
  console.log(`Message: "${MESSAGE}"`);
  console.log(`From: ${FROM}`);
  console.log('');

  try {
    const res = await axios.post(`http://localhost:${PORT}/webhook`, payload, {
      headers: { 'Content-Type': 'application/json' },
    });
    console.log(`Response: ${res.status}`);
    console.log('Check the server logs for processing output.');
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error(`Server is not running on port ${PORT}. Start it first with: npm run dev`);
    } else {
      console.error('Error:', err.response?.data || err.message);
    }
  }
}

main();
