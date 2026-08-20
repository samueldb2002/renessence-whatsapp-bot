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

// Session types that are CLASS enrolments, not appointments — their release
// goes through the class API. Kept in sync with isClass in
// dynamic-catalog.service.js (not imported here: that module pulls in the
// Stripe-backed payment service, which this cron doesn't otherwise need).
const CLASS_SESSION_TYPES = new Set([83]); // Studio Classes

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

  // Bookings whose appointment already STARTED while never billed: cancelling
  // helps no one (the customer may be on the table), but silence turns them
  // into free treatments — flag each once for the team instead. The status
  // flip to 'needs_review' keeps them out of this query on the next run.
  const started = await db.getUnpaidStartedBookings(minutes);
  for (const row of started) {
    db.logError('unpaid_attended_booking', `Booking ${row.id} (${row.service_name || '?'}, apt ${row.mindbody_appointment_id}, ${row.phone}) started without ever being billed. MANUAL REVIEW: collect payment or write off.`, '', JSON.stringify({ bookingEventId: row.id }));
    await db.updateBookingEvent(row.id, { status: 'needs_review' });
    logger.error(`expireStaleBookings: booking ${row.id} attended unpaid — flagged needs_review`);
  }

  // RECONCILIATION: 'payment_sent' rows whose appointment already started
  // without resolving to paid or expired. Every stranded-row failure mode
  // converges here — an aborted mint whose write landed despite reporting
  // failure, a webhook that couldn't read the row, a release that failed.
  // Ask Stripe what actually happened: paid → repair the row (all is well);
  // anything else → the guest attended on an unpaid link: flag for the team.
  const attended = await db.getAttendedUnresolvedBookings();
  for (const row of attended) {
    try {
      const info = row.stripe_session_id ? await paymentService.getSessionStatus(row.stripe_session_id) : null;
      if (info && (info.paymentStatus === 'paid' || info.status === 'complete')) {
        await db.updateBookingEvent(row.id, { status: 'paid', paidAt: new Date().toISOString() });
        logger.warn(`expireStaleBookings: attended booking ${row.id} was PAID but DB lagged — repaired`);
      } else if (!info && row.stripe_session_id) {
        logger.warn(`expireStaleBookings: attended booking ${row.id} — Stripe unreachable, retrying next run`);
      } else {
        db.logError('unpaid_attended_booking', `Booking ${row.id} (${row.service_name || '?'}, apt ${row.mindbody_appointment_id}, ${row.phone}) attended with payment link unpaid (session ${row.stripe_session_id || 'none'}). MANUAL REVIEW: collect payment or write off.`, '', JSON.stringify({ bookingEventId: row.id }));
        await db.updateBookingEvent(row.id, { status: 'needs_review' });
        logger.error(`expireStaleBookings: attended booking ${row.id} unpaid — flagged needs_review`);
      }
    } catch (err) {
      logger.error('expireStaleBookings reconciliation error for booking', row.id, err.message);
    }
  }

  // Rows about to age past the 24h floor of every sweep while still
  // unresolved: flag them on the way out, or they go permanently silent.
  const aging = await db.getAgingUnresolvedBookings();
  for (const row of aging) {
    db.logError('unresolved_booking_aging_out', `Booking ${row.id} (${row.service_name || '?'}, apt ${row.mindbody_appointment_id || 'none'}, ${row.phone}) is still '${row.status}' 24h after creation and is leaving the safety-net window. MANUAL REVIEW.`, '', JSON.stringify({ bookingEventId: row.id }));
    await db.updateBookingEvent(row.id, { status: 'needs_review' });
    logger.error(`expireStaleBookings: booking ${row.id} aged out unresolved — flagged needs_review`);
  }

  const stale = await db.getStaleUnpaidBookings(minutes);
  if (!stale.length) return;

  logger.info(`expireStaleBookings: ${stale.length} unpaid booking(s) past ${minutes} min`);

  for (const row of stale) {
    const aptId = row.mindbody_appointment_id;
    let cancelReason = 'unpaid_timeout';
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
      } else if (row.status === 'pending') {
        // Never billed. send_payment writes stripe_session_id and status
        // 'payment_sent' in ONE update, so a row still on 'pending' with no
        // session id proves no payment link was ever minted — nothing can be in
        // flight, and no customer has been asked for money. This is the slot
        // that used to sit in Mindbody forever: booked, confirmed and unpaid,
        // because the model never called send_payment. Release it.
        //
        // Pay-on-location rows ('pay_on_location') are never returned by
        // getStaleUnpaidBookings, so they cannot land here. Known, accepted
        // degradation: if the server restarts before an ABOVE-THRESHOLD journey
        // is billed, the in-memory cart is lost — this branch releases the
        // journey's pay-ONLINE bookings, while its pay-on-location siblings
        // simply survive as ordinary pay-at-reception bookings (their Mindbody
        // note still says UNPAID, so the front desk collects). No money is
        // lost; the journey just isn't prepaid as a whole after a restart.
        cancelReason = 'never_billed';
        logger.warn(`expireStaleBookings: booking ${row.id} (apt ${aptId}) was never billed — releasing the slot`);
      } else {
        // Reached 'payment_sent' but the session id failed to persist: a link
        // WAS minted, so money may be in flight. Cannot prove it unpaid —
        // refuse to cancel and flag for manual review instead.
        logger.warn(`expireStaleBookings: booking ${row.id} (apt ${aptId}) is '${row.status}' with no stripe_session_id — cannot verify payment, leaving for manual review`);
        continue;
      }

      // Release the Mindbody booking. Only an explicit already-gone signal is
      // benign — the old substring filter classified genuine failures
      // (HTTP 5xx text, "Cancellation did not take effect") as benign and then
      // marked rows expired while their appointments lived on.
      //
      // CLASS rows must go through the class API: feeding a class id to the
      // appointment API returns not-found — which LOOKS benign while the
      // enrolment lives on (round-5 verify finding). The class API needs the
      // client id, recovered from the row's phone.
      let alreadyGone = false;
      const isClassRow = CLASS_SESSION_TYPES.has(Number(row.session_type_id));
      try {
        if (isClassRow) {
          const client = row.phone && !String(row.phone).startsWith('web_')
            ? await mindbodyService.getClientByPhone(row.phone, null)
            : null;
          if (!client) throw new Error(`no client found for phone ${row.phone} — cannot release class enrolment`);
          await mindbodyService.removeClientFromClass(client.Id, aptId);
          logger.info('expireStaleBookings: released unpaid class enrolment', aptId);
        } else {
          await mindbodyService.cancelAppointment(aptId);
          logger.info('expireStaleBookings: cancelled unpaid appointment', aptId);
        }
      } catch (err) {
        // Benign is only meaningful from the API that owns the booking — and
        // each branch above calls exactly that API, so a benign answer here is
        // a genuine already-gone. (The client-lookup failure message matches
        // nothing benign, so it lands in the flag branch.)
        if (mindbodyService.isBenignCancelError(err)) {
          alreadyGone = true;
          logger.info(`expireStaleBookings: ${isClassRow ? 'class enrolment' : 'appointment'} already released/missing`, aptId);
        } else {
          // Flag once, retry quietly: the cron re-attempts every 5 minutes,
          // and re-flagging a stuck row ~280 times per day would train the
          // team to ignore this flag type. cancel_reason doubles as the
          // "already flagged" marker without changing the row's status.
          if (row.cancel_reason !== 'release_failed_flagged') {
            db.logError('appointment_release_failed', `Cron could not release ${isClassRow ? 'class' : 'apt'} ${aptId} (booking ${row.id}): ${err.message}. Row left in-flight for retry.`, '', JSON.stringify({ bookingEventId: row.id }));
            await db.updateBookingEvent(row.id, { cancelReason: 'release_failed_flagged' });
          }
          logger.error('expireStaleBookings: failed to release booking', aptId, err.message);
          continue; // leave row untouched; retry next run
        }
      }

      await db.updateBookingEvent(row.id, {
        status: 'expired',
        cancelledAt: new Date().toISOString(),
        cancelReason,
      });

      // The appointment no longer exists, so it must leave the in-memory cart
      // too — otherwise a customer who keeps chatting (each message refreshes
      // the conversation TTL) could later say "send me the payment link" and
      // PAY for a slot this cron just released (audit finding #2). Billing also
      // re-verifies rows before charging; this is the first of those two layers.
      const conv = conversationService.get(row.phone);
      if (conv?.pendingBookings?.length) {
        conversationService.update(row.phone, {
          pendingBookings: conv.pendingBookings.filter(b => String(b.appointment_id) !== String(aptId)),
        });
      }

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

module.exports = { startExpireBookingsCron, expireStaleBookings, CLASS_SESSION_TYPES };
