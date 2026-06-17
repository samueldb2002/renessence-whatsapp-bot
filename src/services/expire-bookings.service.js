const cron = require('node-cron');
const mindbodyService = require('./mindbody.service');
const whatsappService = require('./whatsapp.service');
const paymentService = require('./payment.service');
const conversationService = require('./conversation.service');
const db = require('../data/database');
const logger = require('../utils/logger');

// How long an unpaid booking may hold a Mindbody slot before we auto-cancel it.
// Defaults to Stripe's payment window (31 min) plus a small buffer so Stripe's
// own checkout.session.expired webhook gets first chance to handle it cleanly.
function getTimeoutMinutes() {
  const stripeWindow = Math.max(31, parseInt(process.env.PAYMENT_TIMEOUT_MINUTES || '31', 10));
  return stripeWindow + 5;
}

function startExpireBookingsCron() {
  logger.info('Starting expire-stale-bookings cron (every 5 minutes)');
  cron.schedule('*/5 * * * *', async () => {
    try {
      await expireStaleBookings();
    } catch (err) {
      logger.error('Expire-stale-bookings cron error:', err.message);
    }
  });
}

/**
 * Deterministic safety net for unpaid bookings.
 *
 * Expiry no longer depends on Stripe firing checkout.session.expired (which can
 * be delayed) or on the AI having threaded booking_event_id through
 * send_payment (which sometimes leaves rows stuck on 'pending'). We read
 * straight from booking_events and cancel anything unpaid past the timeout.
 */
async function expireStaleBookings() {
  const minutes = getTimeoutMinutes();
  const stale = await db.getStaleUnpaidBookings(minutes);
  if (!stale.length) return;

  logger.info(`expireStaleBookings: ${stale.length} unpaid booking(s) past ${minutes} min`);

  for (const row of stale) {
    const aptId = row.mindbody_appointment_id;
    try {
      // ── SAFETY: never cancel a booking that was actually paid ──────────────
      // The DB status can lag reality when the Stripe webhook fails to flip it
      // to 'paid' (e.g. the booking_event_id was never threaded through
      // send_payment, so the webhook's metadata-keyed update matched nothing).
      // Before cancelling we therefore confirm the REAL state with Stripe.
      if (row.stripe_session_id) {
        const info = await paymentService.getSessionStatus(row.stripe_session_id);

        // Paid (or session completed) → the customer holds a valid, paid
        // booking. Repair the DB row, never cancel. (The "paid but expired"
        // incident.) iDEAL/async methods can land as status='complete' with
        // payment_status briefly 'unpaid'→'paid', so treat 'complete' as paid.
        if (info && (info.paymentStatus === 'paid' || info.status === 'complete')) {
          await db.updateBookingEvent(row.id, {
            status: 'paid',
            paidAt: new Date().toISOString(),
            stripePaymentIntent: row.stripe_payment_intent || null,
          });
          logger.warn(`expireStaleBookings: booking ${row.id} (apt ${aptId}) was PAID but DB lagged — repaired to 'paid', NOT cancelled`);
          continue;
        }

        // Not yet expired/unpaid-final → too early to cancel. Skip; Stripe's own
        // expiry webhook or a later run will handle it once it's truly dead.
        if (!info || info.status !== 'expired') {
          logger.info(`expireStaleBookings: booking ${row.id} session not confirmed dead (status=${info?.status || 'unknown'}/${info?.paymentStatus || '?'}) — skipping to stay safe`);
          continue;
        }

        // Stripe session is 'expired' and not paid → safe to release the slot.
        try {
          await paymentService.cancelPendingPaymentByAppointment(aptId);
        } catch (err) {
          logger.warn(`expireStaleBookings: could not expire Stripe session for ${aptId}:`, err.message);
        }
      } else {
        // No stored Stripe session id. A payment link may still have been sent
        // (the threading bug also drops the session id), so we CANNOT prove this
        // booking is unpaid. Refuse to cancel; flag for manual review instead.
        logger.warn(`expireStaleBookings: booking ${row.id} (apt ${aptId}) has no stripe_session_id — cannot verify payment, leaving for manual review`);
        continue;
      }

      // Cancel the Mindbody appointment (idempotent: tolerate already-cancelled).
      let alreadyGone = false;
      try {
        await mindbodyService.cancelAppointment(aptId);
        logger.info('expireStaleBookings: cancelled unpaid appointment', aptId);
      } catch (err) {
        const msg = (err.response?.data?.Error?.Message || err.message || '').toLowerCase();
        if (msg.includes('cancel') || msg.includes('already') || msg.includes('status') || msg.includes('not found')) {
          alreadyGone = true;
          logger.info('expireStaleBookings: appointment already cancelled/missing', aptId);
        } else {
          logger.error('expireStaleBookings: failed to cancel appointment', aptId, err.message);
          continue; // leave row untouched; retry next run
        }
      }

      await db.updateBookingEvent(row.id, {
        status: 'expired',
        cancelledAt: new Date().toISOString(),
        cancelReason: 'unpaid_timeout',
      });

      // Notify the customer (WhatsApp only; skip web chat + already-gone slots).
      if (!alreadyGone && row.phone && !String(row.phone).startsWith('web_')) {
        const lang = conversationService.get(row.phone)?.lang || 'en';
        const service = row.service_name || (lang === 'nl' ? 'je behandeling' : 'your treatment');
        const message = lang === 'nl'
          ? `Je reservering voor ${service} is geannuleerd omdat de betaling niet op tijd is voltooid.\n\nWil je opnieuw boeken? Stuur ons gerust een bericht.`
          : `Your reservation for ${service} has been cancelled because payment was not completed in time.\n\nWould you like to book again? Just send us a message.`;
        try {
          await whatsappService.sendText(row.phone, message);
        } catch (err) {
          logger.warn('expireStaleBookings: could not notify customer', row.phone, err.message);
        }
      }
    } catch (err) {
      logger.error('expireStaleBookings: unexpected error for booking', row.id, err.message);
    }
  }
}

module.exports = { startExpireBookingsCron, expireStaleBookings };
