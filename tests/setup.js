// Run before every test file.
// Set NODE_ENV=development so src/config/index.js skips the process.exit(1)
// check for missing env vars.
process.env.NODE_ENV = 'development';

// Provide stub values for all required env vars so config loads cleanly.
const stubs = {
  WHATSAPP_TOKEN:           'test_wa_token',
  WHATSAPP_PHONE_NUMBER_ID: 'test_phone_id',
  WHATSAPP_VERIFY_TOKEN:    'test_verify',
  MINDBODY_API_KEY:         'test_mb_key',
  MINDBODY_SITE_ID:         '-99',
  MINDBODY_USERNAME:        'test_user',
  MINDBODY_PASSWORD:        'test_pass',
  OPENAI_API_KEY:           'test_openai_key',
  STRIPE_SECRET_KEY:        'sk_test_stub',
  STRIPE_WEBHOOK_SECRET:    'whsec_test_stub',
  DATABASE_URL:             'postgres://localhost/test',
};

for (const [key, val] of Object.entries(stubs)) {
  if (!process.env[key]) process.env[key] = val;
}
