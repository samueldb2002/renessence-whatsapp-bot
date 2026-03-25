/**
 * Test WhatsApp connectivity by sending a test message.
 * Usage: node tools/test-whatsapp.js <phone_number>
 * Example: node tools/test-whatsapp.js 31612345678
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const axios = require('axios');

const PHONE = process.argv[2];
if (!PHONE) {
  console.error('Usage: node tools/test-whatsapp.js <phone_number>');
  console.error('Example: node tools/test-whatsapp.js 31612345678');
  process.exit(1);
}

const API_URL = `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

async function main() {
  console.log('Sending test message...');
  console.log(`To: ${PHONE}`);
  console.log(`Phone Number ID: ${process.env.WHATSAPP_PHONE_NUMBER_ID}`);

  try {
    const res = await axios.post(
      API_URL,
      {
        messaging_product: 'whatsapp',
        to: PHONE,
        type: 'text',
        text: { body: 'Dit is een testbericht van de WhatsApp Booking Agent.' },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        },
      }
    );
    console.log('Success! Message ID:', res.data.messages?.[0]?.id);
  } catch (err) {
    console.error('Failed:', err.response?.data || err.message);
  }
}

main();
