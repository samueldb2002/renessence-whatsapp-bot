// Pin the process timezone to Amsterdam BEFORE any Date is constructed. The
// availability pipeline assumes the server clock is Amsterdam-local; on a UTC
// host (e.g. alpine without TZ) valid same-day slots get shifted/filtered out.
process.env.TZ = process.env.TZ || 'Europe/Amsterdam';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const config = require('./src/config');
const webhookRouter = require('./src/routes/webhook');
const dashboardRouter = require('./src/routes/dashboard.routes');
const { startReminderCron } = require('./src/services/reminder.service');
const { startExpireBookingsCron } = require('./src/services/expire-bookings.service');
const logger = require('./src/utils/logger');
const db = require('./src/data/database');

const webchatRouter = require('./src/routes/webchat.routes');
const stripeRouter = require('./src/routes/stripe.routes');

const app = express();

// Trust the reverse proxy (Coolify / Caddy / nginx) so express-rate-limit
// can read X-Forwarded-For without throwing ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
app.set('trust proxy', 1);

// L2: security headers
app.use(helmet({ contentSecurityPolicy: false })); // CSP off — widget iframe needs flexibility

// H2: rate limiting per route
const webhookLimiter  = rateLimit({ windowMs: 60_000, max: 100, standardHeaders: true, legacyHeaders: false });
const webchatLimiter  = rateLimit({ windowMs: 60_000, max: 15,  standardHeaders: true, legacyHeaders: false });
const dashboardLimiter = rateLimit({ windowMs: 60_000, max: 60,  standardHeaders: true, legacyHeaders: false });
const stripeLimiter   = rateLimit({ windowMs: 60_000, max: 30,  standardHeaders: true, legacyHeaders: false });

// CORS for dashboard + website widget
app.use(cors({
  origin: [
    'https://dashboard.renessence.zenithintelligence.ai',
    'https://renessence.com',
    'https://www.renessence.com',
    'http://localhost:3000',
  ],
  credentials: true,
}));

// L8: Stripe webhook — raw body must be parsed before express.json() middleware
app.use('/stripe-webhook', stripeLimiter, express.raw({ type: 'application/json' }), stripeRouter);

// Preserve raw body for WhatsApp signature verification
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; },
}));
app.use('/public', express.static('public'));
app.use(express.static('public'));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// TEMP diagnostic — remove after use. Read-only, key-gated. Reports the RAW
// Mindbody availability windows (StartDateTime/EndDateTime/staff) per session
// type for a date, plus bookable-item counts, to see exactly what Mindbody
// returns (e.g. whether a room's weekend window runs too late).
app.get('/diag/avail', async (req, res) => {
  if (req.query.key !== 'renessence-diag-2026') return res.status(404).end();
  try {
    const mb = require('./src/services/mindbody.service');
    const start = req.query.start || '2026-07-12';
    const end = req.query.end || '2026-07-12';
    const ids = (req.query.ids || '58').split(',').map(s => s.trim()).filter(Boolean).map(Number);
    const out = {};
    for (const id of ids) {
      try {
        const items = await mb.getBookableItems(id, start, end);
        out[id] = {
          count: items.length,
          windows: items.map(it => ({
            start: it.StartDateTime,
            end: it.EndDateTime,
            staff: it.Staff?.Name || it.Staff?.Id || null,
          })),
        };
      } catch (e) { out[id] = { error: `ERR ${e.response?.status || e.message}` }; }
    }
    res.json({ start, end, tz: process.env.TZ || '(unset)', serverNow: new Date().toString(), items: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// WhatsApp webhook
app.use('/webhook', webhookLimiter, webhookRouter);

// Web chat widget API
app.use('/webchat', webchatLimiter, webchatRouter);

// Dashboard API
app.use('/api/dashboard', dashboardLimiter, dashboardRouter);

// Global error handler — log to DB
app.use((err, req, res, next) => {
  db.logError('unhandled', err.message, err.stack, req.originalUrl);
  logger.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// H7 — process-level error handlers so background errors don't go unnoticed
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err.message, err.stack);
});

// Initialize DB and start server
db.initialize().then(() => {
  app.listen(config.PORT, () => {
    logger.info(`WhatsApp Booking Agent running on port ${config.PORT}`);
    startReminderCron();
    startExpireBookingsCron();
  });
}).catch(err => {
  logger.error('Failed to initialize database:', err.message);
  // Start anyway without DB — bot still works, just no analytics
  app.listen(config.PORT, () => {
    logger.info(`WhatsApp Booking Agent running on port ${config.PORT} (without DB)`);
    startReminderCron();
    startExpireBookingsCron();
  });
});
