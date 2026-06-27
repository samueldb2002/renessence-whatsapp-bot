const Stripe = require('stripe');
const logger = require('../utils/logger');
const db = require('../data/database');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Track pending payments: sessionId -> { appointmentId, clientId, from, serviceName, dateTime, createdAt }
const pendingPayments = new Map();

// Price mapping: Mindbody session type ID -> price in cents (EUR)
const PRICE_MAP = {
  // Gym + Treatment combos - €50
  99:  5000,  // Heat & Meet (Gym + Finnish Sauna 2p)
  100: 5000,  // Lift & Drift (Gym + Float)
  101: 5000,  // Move & Massage (Gym + Hydrowave)
  102: 5000,  // Boost & Breathe (Gym + Hyperbaric 30 min)
  103: 5000,  // Sweat & Reset 1p (Gym + IR Sauna)
  104: 5000,  // Glow & Go (Gym + Red Light)
  105: 5000,  // Sweat & Reset 2p (Gym + IR Sauna)
  // Tech Treatments
  58: 8000,   // Float Journey (60 min) - €80
  // Oxygen Hydroxy — active session types
  71: 5000,   // 2. Hyperbaric Oxygen Hydroxy Laying (30 min) - €50
  93: 9500,   // 4. Hyperbaric Oxygen Hydroxy Laying (60 min) - €95
  92: 5000,   // 3. Hyperbaric Oxygen Hydroxy Seated (30 min) - €50
  94: 9500,   // 5. Hyperbaric Oxygen Hydroxy Seated (60 min) - €95
  // Infrared Sauna — active session types
  98: 3000,   // 3. Small Infrared Sauna Journey (1 person) - €30
  65: 3500,   // 4. Large Infrared Sauna Journey (1 person) - €35
  97: 4500,   // 5. Large Infrared Sauna Journey (2 people) - €45
  // Finnish Sauna — active session types
  87: 8000,   // 2. Finnish Sauna (1 person) - €80
  69: 8000,   // 3. Finnish Sauna (2 people) - €80
  91: 9000,   // 4. Finnish Sauna (3 people) - €90
  // Legacy/inactive session types kept for old bookings/lookups
  70: 9500, 74: 5000, 75: 9500, 68: 3000, 77: 3500, 67: 4500, 76: 4500, 66: 9000,
  64: 4500,   // Red Light Therapy (15 min) - €45
  80: 3000,   // Hydrowave (25 min) - €30
  83: 2200,   // Studio Classes (60 min) - €22
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
  109: 18000, // Let It Go — psycho-energetic therapy (90 min) - €180
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
 * Create a single Stripe Checkout Session covering multiple bookings.
 * items: [{ bookingEventId, appointmentId, serviceName, dateTimeLabel, amountCents }]
 */
async function createCombinedPaymentLink({ items, customerEmail, customerName, from }) {
  try {
    const lineItems = items.map(item => ({
      price_data: {
        currency: 'eur',
        product_data: {
          name: item.serviceName,
          description: `Renessence – ${item.dateTimeLabel}`,
        },
        unit_amount: item.amountCents,
      },
      quantity: 1,
    }));

    const bookingEventIds = items.map(i => i.bookingEventId).join(',');
    const appointmentIds  = items.map(i => i.appointmentId).join(',');
    const itemsSummary    = items.map(i => `${i.serviceName} (${i.dateTimeLabel})`).join(' + ');

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'ideal'],
      line_items: lineItems,
      mode: 'payment',
      customer_email: customerEmail || undefined,
      success_url: 'https://renessence.com',
      cancel_url:  'https://renessence.com',
      metadata: {
        booking_event_ids: bookingEventIds,
        appointment_ids:   appointmentIds,
        from,
        items_summary: itemsSummary.substring(0, 490),
      },
      expires_at: Math.floor(Date.now() / 1000) + (Math.max(31, parseInt(process.env.PAYMENT_TIMEOUT_MINUTES || '31')) * 60),
    });

    pendingPayments.set(session.id, {
      appointmentId: appointmentIds,
      bookingEventIds,
      from,
      serviceName: itemsSummary,
      dateTime: items[0]?.dateTimeLabel || '',
      customerEmail,
      customerName,
      createdAt: Date.now(),
      sessionId: session.id,
    });

    logger.info(`Stripe combined session created: ${session.id} for ${items.length} booking(s)`);
    return { sessionId: session.id, paymentUrl: session.url };
  } catch (err) {
    logger.error('Stripe createCombinedPaymentLink error:', err.message);
    throw err;
  }
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
      expires_at: Math.floor(Date.now() / 1000) + (Math.max(31, parseInt(process.env.PAYMENT_TIMEOUT_MINUTES || '31')) * 60),
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
 * Cancel any pending Stripe session for a given Mindbody appointment ID.
 * Called when the customer cancels the booking through the bot so the
 * Stripe session.expired webhook doesn't fire and send a redundant message.
 * C8: falls back to DB lookup when the in-memory map is empty (e.g. after restart).
 */
async function cancelPendingPaymentByAppointment(appointmentId) {
  const strAppointmentId = String(appointmentId);

  // Fast path: in-memory map (populated when server hasn't restarted)
  for (const [sessionId, pending] of pendingPayments.entries()) {
    if (String(pending.appointmentId) === strAppointmentId) {
      try {
        await stripe.checkout.sessions.expire(sessionId);
        logger.info('Stripe session expired (bot cancel):', sessionId);
      } catch (err) {
        logger.warn('Could not expire Stripe session:', sessionId, err.message);
      }
      pendingPayments.delete(sessionId);
      return true;
    }
  }

  // C8: slow path — query DB for unpaid stripe session after restart
  try {
    const sessionId = await db.getPendingStripeSessionByAppointment(appointmentId);
    if (sessionId) {
      try {
        await stripe.checkout.sessions.expire(sessionId);
        logger.info('Stripe session expired via DB lookup (bot cancel):', sessionId);
      } catch (err) {
        logger.warn('Could not expire Stripe session (DB path):', sessionId, err.message);
      }
      return true;
    }
  } catch (err) {
    logger.warn('cancelPendingPaymentByAppointment DB lookup error:', err.message);
  }

  return false;
}

/**
 * Retrieve a Checkout Session's live status from Stripe.
 * Returns { status, paymentStatus } or null if it can't be fetched.
 *   status:        'open' | 'complete' | 'expired'
 *   paymentStatus: 'paid' | 'unpaid' | 'no_payment_required'
 * Used as a safety check before auto-cancelling a booking, so a paid
 * session is never cancelled just because the DB status lagged behind.
 */
async function getSessionStatus(sessionId) {
  if (!sessionId) return null;
  try {
    const s = await stripe.checkout.sessions.retrieve(sessionId);
    return { status: s.status, paymentStatus: s.payment_status };
  } catch (err) {
    logger.warn('getSessionStatus error:', sessionId, err.message);
    return null;
  }
}

/**
 * Manually expire a Checkout Session (e.g. our custom 15-min payment timeout,
 * shorter than Stripe's 30-min minimum auto-expiry). Expiring fires a
 * checkout.session.expired webhook, which cancels the Mindbody appointment and
 * notifies the customer. Idempotent: a paid/already-expired session just no-ops.
 */
async function expireSession(sessionId) {
  if (!sessionId) return false;
  try {
    await stripe.checkout.sessions.expire(sessionId);
    logger.info('Stripe session expired (custom timeout):', sessionId);
    return true;
  } catch (err) {
    logger.warn('expireSession (already paid/expired?):', sessionId, err.message);
    return false;
  }
}

/**
 * Construct Stripe webhook event from request
 */
function constructWebhookEvent(body, signature) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    if (process.env.NODE_ENV !== 'development') {
      throw new Error('STRIPE_WEBHOOK_SECRET is not set — refusing to process unverified webhook in production');
    }
    logger.warn('STRIPE_WEBHOOK_SECRET not set — skipping signature verification (development only)');
    return typeof body === 'string' ? JSON.parse(body) : body;
  }
  return stripe.webhooks.constructEvent(body, signature, webhookSecret);
}

module.exports = {
  createCombinedPaymentLink,
  createPaymentLink,
  handlePaymentSuccess,
  handlePaymentExpired,
  getPendingPayment,
  cancelPendingPaymentByAppointment,
  getSessionStatus,
  expireSession,
  constructWebhookEvent,
  getPriceInCents,
  getPrice,
  PRICE_MAP,
  pendingPayments,
};
