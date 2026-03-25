require('dotenv').config();

const required = [
  'WHATSAPP_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_VERIFY_TOKEN',
  'MINDBODY_API_KEY',
  'MINDBODY_SITE_ID',
  'MINDBODY_USERNAME',
  'MINDBODY_PASSWORD',
  'OPENAI_API_KEY',
];

const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0 && process.env.NODE_ENV !== 'development') {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

module.exports = {
  PORT: process.env.PORT || 3001,
  NODE_ENV: process.env.NODE_ENV || 'development',

  // WhatsApp
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN,

  // Mindbody
  MINDBODY_API_KEY: process.env.MINDBODY_API_KEY,
  MINDBODY_SITE_ID: process.env.MINDBODY_SITE_ID,
  MINDBODY_USERNAME: process.env.MINDBODY_USERNAME,
  MINDBODY_PASSWORD: process.env.MINDBODY_PASSWORD,

  // OpenAI
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o',

  // Stripe
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,

  // Business
  SPA_NAME: process.env.SPA_NAME || 'Onze Spa',
  SPA_ADDRESS: process.env.SPA_ADDRESS || '',
  SPA_PHONE: process.env.SPA_PHONE || '',
  SPA_OPENING_HOURS: process.env.SPA_OPENING_HOURS || '',
};
