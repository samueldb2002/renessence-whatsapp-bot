const Stripe = require('stripe');
const logger = require('../utils/logger');
const db = require('../data/database');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Bank verification (3D Secure) on every card payment. 'any' tells Stripe to
// never use an SCA exemption: EU cards always verify, US cards verify whenever
// their bank supports 3DS, and a card whose bank can't verify still pays
// normally — a booking is never lost to this flag. A verified payment shifts
// "that wasn't me" chargeback liability to the customer's bank. iDEAL needs
// nothing here: an iDEAL payment IS a bank-app approval by design.
const CARD_PAYMENT_OPTIONS = { card: { request_three_d_secure: 'any' } };

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

// Services that are paid ONLINE via a Stripe link BEFORE the visit.
// Everything else (Float, saunas, oxygen, red light, hydrowave and the gym
// combos) is booked without any online payment and paid AT RECEPTION — the
// Mindbody appointment is tagged "UNPAID" so the front desk collects it there.
// This is an explicit allow-list on purpose: charging money should be opt-in,
// so a newly added service defaults to pay-on-location (never accidentally
// billed) until it is deliberately added here.
const PAY_ONLINE_SERVICES = new Set([
  31, 32, 35, 36, 37, 38, // Massages — Tailored / Prenatal / Lymphatic (60 & 80 min)
  41, 30,                 // Renewal Facial (+ LED Light Face Therapy add-on)
  45, 63,                 // Nervous System Reset (60 & 80 min)
  109,                    // Let It Go (psycho-energetic therapy)
  43, 44, 52,             // Acupuncture — intake & follow-ups
  83,                     // Studio Classes
]);

/**
 * Does this treatment require online (Stripe) payment before the visit?
 * false → booked without payment, settled on location (Mindbody note "UNPAID").
 */
function requiresOnlinePayment(sessionTypeId) {
  return PAY_ONLINE_SERVICES.has(Number(sessionTypeId));
}

// Above this journey total, EVERY treatment in the journey is billed online —
// including the ones that would normally be settled at reception. A single €80
// float at the desk is fine; a €240 massage + LED + float walking in with
// nothing paid is not. Tunable without a deploy via env.
const JOURNEY_PREPAY_THRESHOLD_CENTS = Math.max(
  0,
  parseInt(process.env.JOURNEY_PREPAY_THRESHOLD_CENTS || '15000', 10) || 15000
);

/**
 * Decide which of a journey's bookings go on the Stripe link.
 *
 * Below the threshold this is the long-standing billing boundary: pay-online
 * treatments are billed, pay-on-location ones are left for reception. At or
 * above it the whole journey is prepaid.
 *
 * Items with no session_type_id predate that field or came from a trusted
 * path, so they are always billed — the classifier is an allow-list and only
 * ever removes pay-on-location treatments.
 *
 * @param {Array<{session_type_id?: number, amount_cents?: number}>} cart
 * @returns {Array} a new array; the caller never mutates the cart through it
 */
function selectBillableItems(cart) {
  const items = Array.isArray(cart) ? cart : [];
  const journeyTotal = items.reduce((sum, b) => sum + (Number(b.amount_cents) || 0), 0);

  if (journeyTotal >= JOURNEY_PREPAY_THRESHOLD_CENTS) return [...items];

  return items.filter(b => b.session_type_id == null || requiresOnlinePayment(b.session_type_id));
}

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

    // Treatments normally settled at reception that this journey prepays. Their
    // Mindbody note still says "UNPAID — pay on location"; the webhook clears it
    // once the money lands so the front desk doesn't charge them a second time.
    const prepaidOnLocationIds = items
      .filter(i => i.payOnLocation && i.appointmentId)
      .map(i => i.appointmentId)
      .join(',');

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'ideal'],
      payment_method_options: CARD_PAYMENT_OPTIONS,
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
        ...(prepaidOnLocationIds ? { prepaid_on_location_apt_ids: prepaidOnLocationIds.substring(0, 490) } : {}),
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
 * Create a standalone Stripe payment link for a custom amount, sent MANUALLY by
 * the team from the dashboard. Not tied to a Mindbody booking and NOT given the
 * auto-expiry/cancel timeline — it just collects the amount the team specifies.
 */
async function createCustomPaymentLink({ amountCents, description, customerEmail, from }) {
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card', 'ideal'],
    payment_method_options: CARD_PAYMENT_OPTIONS,
    line_items: [{
      price_data: {
        currency: 'eur',
        product_data: { name: description || 'Renessence' },
        unit_amount: amountCents,
      },
      quantity: 1,
    }],
    mode: 'payment',
    customer_email: customerEmail || undefined,
    success_url: 'https://renessence.com',
    cancel_url: 'https://renessence.com',
    metadata: {
      manual: 'true', // flags a team-sent link so the webhook's booking-marking logic skips it
      from: String(from || ''),
      description: String(description || '').substring(0, 480),
    },
  });
  logger.info(`Manual Stripe payment link created: ${session.id} (${amountCents} cents) for ${from}`);
  return { sessionId: session.id, paymentUrl: session.url };
}

/**
 * Create a Stripe Checkout Session for a booking
 */
async function createPaymentLink({ appointmentId, clientId, from, serviceName, dateTime, amount, customerEmail, customerName }) {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'ideal'],
      payment_method_options: CARD_PAYMENT_OPTIONS,
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
  createCustomPaymentLink,
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
  requiresOnlinePayment,
  selectBillableItems,
  JOURNEY_PREPAY_THRESHOLD_CENTS,
  PAY_ONLINE_SERVICES,
  PRICE_MAP,
  pendingPayments,
};
