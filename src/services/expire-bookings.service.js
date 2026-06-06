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
      // Expire the Stripe session first (if any) so a late payment can't land
      // on an already-cancelled appointment.
      if (row.stripe_session_id) {
        try {
          await paymentService.cancelPendingPaymentByAppointment(aptId);
        } catch (err) {
          logger.warn(`expireStaleBookings: could not expire Stripe session for ${aptId}:`, err.message);
        }
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
