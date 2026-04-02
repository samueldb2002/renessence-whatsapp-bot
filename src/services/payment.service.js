const Stripe = require('stripe');
const logger = require('../utils/logger');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Track pending payments: sessionId -> { appointmentId, clientId, from, serviceName, dateTime, createdAt }
const pendingPayments = new Map();

// Price mapping: Mindbody session type ID -> price in cents (EUR)
const PRICE_MAP = {
  // Tech Treatments
  58: 8000,   // Float Journey (60 min) - €80
  70: 9500,   // Hyperbaric Oxygen Hydroxy Laying (60 min) - €95
  71: 5000,   // Hyperbaric Oxygen Hydroxy Laying (30 min) - €50
  74: 5000,   // Hyperbaric Oxygen Hydroxy Seated (30 min) - €50
  75: 9500,   // Hyperbaric Oxygen Hydroxy Seated (60 min) - €95
  68: 3000,   // Small Infrared Sauna (1 person) - €30
  65: 3500,   // Large Infrared Sauna 1 (1 person) - €35
  77: 3500,   // Large Infrared Sauna 2 (1 person) - €35
  67: 4500,   // Private Infrared Sauna 1 (2 people) - €45
  76: 4500,   // Private Infrared Sauna 2 (2 people) - €45
  69: 8000,   // Finnish Sauna (2 people) - €80
  66: 9000,   // Finnish Sauna (3 people) - €90
  64: 4500,   // Red Light Therapy (15 min) - €45
  // Traditional Treatments
  43: 15000,  // Acupuncture First Session (75min) - €150
  44: 12000,  // Acupuncture Follow-up (60min) - €120
  52: 15000,  // Acupuncture Follow-up (75min) - €150
  41: 16500,  // Orchid Stem Cell Renewal Facial (60min) - €165
  37: 13000,  // Lymphatic Drainage Massage (60min) - €130
  38: 17000,  // Lymphatic Drainage Massage (80min) - €170
  31: 13000,  // Tailored Massage (60min) - €130
  32: 17000,  // Tailored Massage (80min) - €170
  30: 3000,   // LED Light Face Therapy (Add-on) - €30
  35: 13000,  // Prenatal Massage (60min) - €130
  36: 17000,  // Prenatal Massage (80min) - €170
  45: 13000,  // Nervous System Treatment (60min) - €130
  63: 17000,  // Nervous System Treatment (80min) - €170
};

/**
 * Get price in cents for a session type ID
 */
function getPriceInCents(sessionTypeId) {
  return PRICE_MAP[sessionTypeId] || null;
}

/**
 * Get price in EUR for a session type ID
 */
function getPrice(sessionTypeId) {
  const cents = PRICE_MAP[sessionTypeId];
  return cents ? cents / 100 : null;
}

/**
 * Create a Stripe Checkout Session for a booking
 */
async function createPaymentLink({ appointmentId, clientId, from, serviceName, dateTime, amount, customerEmail, customerName }) {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'ideal'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: serviceName,
            description: `Renessence - ${dateTime}`,
          },
          unit_amount: amount, // in cents
        },
        quantity: 1,
      }],
      mode: 'payment',
      customer_email: customerEmail || undefined,
      success_url: 'https://renessence.com/booking-confirmed',
      cancel_url: 'https://renessence.com/booking-cancelled',
      metadata: {
        appointmentId: String(appointmentId),
        clientId: String(clientId),
        from,
        serviceName,
        dateTime,
      },
      expires_at: Math.floor(Date.now() / 1000) + (Math.max(31, parseInt(process.env.PAYMENT_TIMEOUT_MINUTES || '45')) * 60),
    });

    // Track this pending payment
    pendingPayments.set(session.id, {
      appointmentId,
      clientId,
      from,
      serviceName,
      dateTime,
      customerEmail,
      customerName: customerName || serviceName,
      createdAt: Date.now(),
      sessionId: session.id,
    });

    logger.info('Stripe session created:', session.id, 'for appointment:', appointmentId);

    return {
      sessionId: session.id,
      paymentUrl: session.url,
    };
  } catch (err) {
    logger.error('Stripe createPaymentLink error:', err.message);
    throw err;
  }
}

/**
 * Handle Stripe webhook event for completed payment
 */
function handlePaymentSuccess(sessionId) {
  const pending = pendingPayments.get(sessionId);
  if (pending) {
    pendingPayments.delete(sessionId);
    logger.info('Payment completed for appointment:', pending.appointmentId);
  }
  return pending;
}

/**
 * Handle expired session (payment not completed in time)
 */
function handlePaymentExpired(sessionId) {
  const pending = pendingPayments.get(sessionId);
  if (pending) {
    pendingPayments.delete(sessionId);
    logger.info('Payment expired for appointment:', pending.appointmentId);
  }
  return pending;
}

/**
 * Get pending payment by session ID
 */
function getPendingPayment(sessionId) {
  return pendingPayments.get(sessionId);
}

/**
 * Construct Stripe webhook event from request
 */
function constructWebhookEvent(body, signature) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    // If no webhook secret, parse body directly (less secure, ok for dev)
    return typeof body === 'string' ? JSON.parse(body) : body;
  }
  return stripe.webhooks.constructEvent(body, signature, webhookSecret);
}

module.exports = {
  createPaymentLink,
  handlePaymentSuccess,
  handlePaymentExpired,
  getPendingPayment,
  constructWebhookEvent,
  getPriceInCents,
  getPrice,
  PRICE_MAP,
  pendingPayments,
};
