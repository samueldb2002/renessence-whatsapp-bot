require('dotenv').config();
const express = require('express');
const cors = require('cors');
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

const app = express();

// CORS for dashboard
app.use(cors({
  origin: [
    'https://dashboard.renessence.zenithintelligence.ai',
    'http://localhost:3000',
  ],
  credentials: true,
}));

// Stripe webhook needs raw body — must be before express.json()
app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const event = paymentService.constructWebhookEvent(
      req.body,
      req.headers['stripe-signature']
    );

    logger.info('Stripe webhook event:', event.type);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const pending = paymentService.handlePaymentSuccess(session.id) || (session.metadata?.appointmentId ? {
        appointmentId: session.metadata.appointmentId,
        from: session.metadata.from,
        serviceName: session.metadata.serviceName,
        dateTime: session.metadata.dateTime,
        customerEmail: session.customer_email || session.customer_details?.email,
        customerName: session.customer_details?.name || session.metadata.serviceName,
      } : null);
      if (pending) {
        // Log payment to DB
        db.updateBookingByStripeSession(session.id, {
          status: 'paid',
          paidAt: new Date().toISOString(),
          stripePaymentIntent: session.payment_intent,
          paymentMethod: session.payment_method_types?.[0] || 'card',
        });

        // Send payment confirmation via WhatsApp
        await whatsappService.sendText(
          pending.from,
          `Payment received! ✅\n\nYour booking for *${pending.serviceName}* on ${pending.dateTime} is now fully confirmed.\n\nSee you at Renessence! 🙏`
        );

        // Send confirmation email
        if (pending.customerEmail) {
          emailService.sendBookingConfirmationEmail({
            customerEmail: pending.customerEmail,
            customerName: pending.customerName,
            serviceName: pending.serviceName,
            date: pending.dateTime?.split(' ')?.[0] || pending.dateTime,
            time: pending.dateTime?.split(' ')?.[1] || '',
          }).catch(err => logger.error('Confirmation email error:', err.message));
        }
      }
    }

    if (event.type === 'checkout.session.expired') {
      const session = event.data.object;
      const pending = paymentService.handlePaymentExpired(session.id) || (session.metadata?.appointmentId ? {
        appointmentId: session.metadata.appointmentId,
        from: session.metadata.from,
        serviceName: session.metadata.serviceName,
        dateTime: session.metadata.dateTime,
      } : null);
      if (pending && pending.appointmentId) {
        // Log expiry to DB
        db.updateBookingByStripeSession(session.id, {
          status: 'expired',
          cancelledAt: new Date().toISOString(),
          cancelReason: 'expired',
        });

        // Cancel the appointment in Mindbody
        try {
          await mindbodyService.cancelAppointment(pending.appointmentId);
          logger.info('Auto-cancelled unpaid appointment:', pending.appointmentId);
        } catch (err) {
          logger.error('Failed to auto-cancel appointment:', err.message);
        }
        // Notify the customer
        await whatsappService.sendText(
          pending.from,
          `Your reservation for ${pending.serviceName} on ${pending.dateTime} has been cancelled because payment was not completed within 45 minutes.\n\nWould you like to book again? Just send us a message.`
        );
      }
    }

    res.json({ received: true });
  } catch (err) {
    logger.error('Stripe webhook error:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

app.use(express.json());
app.use('/public', express.static('public'));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// DEBUG ENDPOINT — remove after use
app.get('/debug/availability', async (req, res) => {
  try {
    const serviceId = parseInt(req.query.service || '58');
    const start = req.query.start || new Date().toISOString().split('T')[0];
    const end = req.query.end || start;
    const items = await mindbodyService.getBookableItems(serviceId, start, end);
    res.json({ serviceId, start, end, count: items.length, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DEBUG ENDPOINT — remove after use
app.get('/debug/activetimes', async (req, res) => {
  try {
    const { default: axios } = await Promise.resolve().then(() => require('axios'));
    const mbConfig = require('./src/config');
    // Get token
    const tokenRes = await axios.post('https://api.mindbodyonline.com/public/v6/usertoken/issue', {
      Username: mbConfig.MINDBODY_USERNAME,
      Password: mbConfig.MINDBODY_PASSWORD,
    }, { headers: { 'Content-Type': 'application/json', 'Api-Key': mbConfig.MINDBODY_API_KEY, SiteId: mbConfig.MINDBODY_SITE_ID } });
    const token = tokenRes.data.AccessToken;
    const res2 = await axios.get('https://api.mindbodyonline.com/public/v6/site/activetimes', {
      headers: { 'Content-Type': 'application/json', 'Api-Key': mbConfig.MINDBODY_API_KEY, SiteId: mbConfig.MINDBODY_SITE_ID, Authorization: token },
      params: { ScheduleType: 'Appointment' },
    });
    res.json(res2.data);
  } catch (err) {
    res.status(500).json({ error: err.message, details: err.response?.data });
  }
});

// WhatsApp webhook
app.use('/webhook', webhookRouter);

// Dashboard API
app.use('/api/dashboard', dashboardRouter);

// Global error handler — log to DB
app.use((err, req, res, next) => {
  db.logError('unhandled', err.message, err.stack, req.originalUrl);
  logger.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
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
