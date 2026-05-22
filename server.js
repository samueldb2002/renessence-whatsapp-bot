require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const config = require('./src/config');
const webhookRouter = require('./src/routes/webhook');
const dashboardRouter = require('./src/routes/dashboard.routes');
const { startReminderCron } = require('./src/services/reminder.service');
const logger = require('./src/utils/logger');
const db = require('./src/data/database');

const paymentService = require('./src/services/payment.service');
const whatsappService = require('./src/services/whatsapp.service');
const mindbodyService = require('./src/services/mindbody.service');
const emailService = require('./src/services/email.service');
const webchatRouter = require('./src/routes/webchat.routes');

const app = express();

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

// Stripe webhook needs raw body — must be before express.json()
app.post('/stripe-webhook', stripeLimiter, express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const event = paymentService.constructWebhookEvent(
      req.body,
      req.headers['stripe-signature']
    );

    logger.info('Stripe webhook event:', event.type);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      // C4: idempotency — skip if already processed
      const existing = await db.getBookingByStripeSession(session.id);
      if (existing?.status === 'paid') {
        logger.info('Stripe webhook: session already paid, skipping duplicate:', session.id);
        return res.json({ received: true });
      }

      const pending = paymentService.handlePaymentSuccess(session.id) || {
        appointmentId:    session.metadata?.appointment_ids || session.metadata?.appointmentId,
        bookingEventIds:  session.metadata?.booking_event_ids,
        from:             session.metadata?.from,
        serviceName:      session.metadata?.items_summary || session.metadata?.serviceName,
        dateTime:         session.metadata?.dateTime || '',
        customerEmail:    session.customer_email || session.customer_details?.email,
        customerName:     session.customer_details?.name || '',
      };

      if (pending?.from) {
        // Mark all booking_events for this session as paid (C4: awaited)
        await db.updateBookingByStripeSession(session.id, {
          status: 'paid',
          paidAt: new Date().toISOString(),
          stripePaymentIntent: session.payment_intent,
          paymentMethod: session.payment_method_types?.[0] || 'card',
        }).catch(err => logger.error('Failed to mark session as paid:', err.message));

        // Build WhatsApp confirmation message
        if (!pending.from.startsWith('web_')) {
          const confirmMsg = pending.serviceName?.includes('+') || pending.serviceName?.includes(',')
            ? `Payment received! ✅\n\nYour bookings are confirmed:\n${pending.serviceName}\n\nSee you at Renessence! 🙏\n\nIs there anything else I can help you with?`
            : `Payment received! ✅\n\nYour booking for *${pending.serviceName}* on ${pending.dateTime} is now fully confirmed.\n\nSee you at Renessence! 🙏\n\nIs there anything else I can help you with, or would you like to make another booking?`;
          await whatsappService.sendText(pending.from, confirmMsg);
        }

        // Confirmation email (for single-service sessions only — multi-booking email not yet supported)
        if (pending.customerEmail && !pending.serviceName?.includes('+')) {
          emailService.sendBookingConfirmationEmail({
            customerEmail: pending.customerEmail,
            customerName:  pending.customerName,
            serviceName:   pending.serviceName,
            date: pending.dateTime?.split(' ')?.[0] || pending.dateTime,
            time: pending.dateTime?.split(' ')?.[1] || '',
          }).catch(err => logger.error('Confirmation email error:', err.message));
        }
      }
    }

    if (event.type === 'checkout.session.expired') {
      const session = event.data.object;
      const pending = paymentService.handlePaymentExpired(session.id) || {
        appointmentId: session.metadata?.appointment_ids || session.metadata?.appointmentId,
        from:          session.metadata?.from,
        serviceName:   session.metadata?.items_summary || session.metadata?.serviceName,
        dateTime:      session.metadata?.dateTime || '',
      };

      if (pending?.appointmentId) {
        db.updateBookingByStripeSession(session.id, {
          status: 'expired',
          cancelledAt: new Date().toISOString(),
          cancelReason: 'expired',
        });

        // Cancel all Mindbody appointments in this session
        const appointmentIds = String(pending.appointmentId).split(',').map(s => s.trim()).filter(Boolean);
        let alreadyCancelled = false;
        for (const aptId of appointmentIds) {
          try {
            await mindbodyService.cancelAppointment(aptId);
            logger.info('Auto-cancelled unpaid appointment:', aptId);
          } catch (err) {
            const msg = (err.response?.data?.Error?.Message || err.message || '').toLowerCase();
            if (msg.includes('cancel') || msg.includes('already') || msg.includes('status') || msg.includes('not found')) {
              alreadyCancelled = true;
              logger.info('Appointment already cancelled/missing, skipping:', aptId);
            } else {
              logger.error('Failed to auto-cancel appointment:', err.message);
            }
          }
        }

        if (!alreadyCancelled && pending.from && !pending.from.startsWith('web_')) {
          await whatsappService.sendText(
            pending.from,
            `Your reservation for ${pending.serviceName} has been cancelled because payment was not completed in time.\n\nWould you like to book again? Just send us a message.`
          );
        }
      }
    }

    res.json({ received: true });
  } catch (err) {
    logger.error('Stripe webhook error:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

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
  });
}).catch(err => {
  logger.error('Failed to initialize database:', err.message);
  // Start anyway without DB — bot still works, just no analytics
  app.listen(config.PORT, () => {
    logger.info(`WhatsApp Booking Agent running on port ${config.PORT} (without DB)`);
    startReminderCron();
  });
});
