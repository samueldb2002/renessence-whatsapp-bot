// L8: Stripe webhook handler extracted from server.js
const express = require('express');
const router = express.Router();
const paymentService = require('../services/payment.service');
const whatsappService = require('../services/whatsapp.service');
const mindbodyService = require('../services/mindbody.service');
const emailService = require('../services/email.service');
const db = require('../data/database');
const logger = require('../utils/logger');

// POST /stripe-webhook — raw body required for signature verification
// express.raw() middleware is applied in server.js before mounting this router
router.post('/', async (req, res) => {
  try {
    const event = paymentService.constructWebhookEvent(
      req.body,
      req.headers['stripe-signature']
    );

    logger.info('Stripe webhook event:', event.type);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      // With card + iDEAL, 'completed' always arrives paid. But if a
      // delayed-notification method (SEPA, bank transfer) is ever enabled,
      // 'completed' can arrive with payment_status 'unpaid' and the money can
      // STILL FAIL later — marking rows 'paid' here would then let every
      // paid-row guard protect an unfunded booking. Refuse until the async
      // succeeded webhook exists for it.
      if (session.payment_status && session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
        logger.error(`Stripe webhook: session ${session.id} completed with payment_status '${session.payment_status}' — NOT marking paid (async payment method?). Add an async_payment_succeeded handler before enabling such methods.`);
        return res.json({ received: true });
      }

      // C4: idempotency — skip if already processed
      const existing = await db.getBookingByStripeSession(session.id);
      if (existing?.status === 'paid') {
        logger.info('Stripe webhook: session already paid, skipping duplicate:', session.id);
        return res.json({ received: true });
      }

      // Manual team-sent payment link (dashboard): there is no booking to mark —
      // just confirm receipt to the customer and stop. Without this the standard
      // flow below would try to confirm a non-existent booking ("... *undefined*").
      if (session.metadata?.manual === 'true') {
        logger.info('Stripe webhook: manual payment link paid:', session.id);
        const mFrom = session.metadata?.from;
        const mDesc = session.metadata?.description || '';
        if (mFrom && !String(mFrom).startsWith('web_')) {
          const lang = require('../services/conversation.service').get(mFrom)?.lang || 'en';
          const msg = lang === 'nl'
            ? `Betaling ontvangen! ✅ Bedankt${mDesc ? ` — ${mDesc} is betaald` : ''}.`
            : `Payment received! ✅ Thank you${mDesc ? ` — ${mDesc} is paid` : ''}.`;
          await whatsappService.sendText(mFrom, msg).catch(err => logger.warn('Manual payment confirm failed:', err.message));
          await db.logMessage(mFrom, 'assistant', msg).catch(() => {});
        }
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

      // Robust status update: update booking_events by their IDs from Stripe
      // metadata (always present), falling back to stripe_session_id match.
      // This guarantees the row is marked paid even if the session_id was
      // never linked to the row at link-creation time.
      const paidUpdates = {
        status: 'paid',
        paidAt: new Date().toISOString(),
        stripeSessionId: session.id,
        stripePaymentIntent: session.payment_intent,
        paymentMethod: session.payment_method_types?.[0] || 'card',
      };
      const bookingEventIds = String(pending.bookingEventIds || session.metadata?.booking_event_ids || '')
        .split(',').map(s => s.trim()).filter(Boolean);

      // C4 (extended): idempotency by booking_event id — if the first row is
      // already paid, this is a duplicate webhook; skip the customer message.
      // A payment can land on a booking whose slot was ALREADY released (the
      // session outlived the 15-min cancel because expireSession failed). The
      // money is real but the appointment is gone — saying "fully confirmed"
      // would be a lie. Detect it here so the messaging below can route the
      // team in instead.
      let paidDeadBooking = false;
      if (bookingEventIds.length > 0) {
        const first = await db.getBookingEventById(bookingEventIds[0]).catch(() => null);
        if (first?.status === 'paid') {
          logger.info('Stripe webhook: booking_event already paid, skipping duplicate:', bookingEventIds[0]);
          return res.json({ received: true });
        }
        if (first && (first.status === 'expired' || first.status === 'cancelled')) {
          paidDeadBooking = true;
          logger.error(`Stripe webhook: payment ${session.id} landed on ${first.status} booking_event ${first.id} — appointment was already released. Escalating to team.`);
        }
      }

      if (bookingEventIds.length > 0) {
        await Promise.all(bookingEventIds.map(id =>
          db.updateBookingEvent(id, paidUpdates)
            .catch(err => logger.error(`Failed to mark booking_event ${id} as paid:`, err.message))
        ));
      } else {
        await db.updateBookingByStripeSession(session.id, paidUpdates)
          .catch(err => logger.error('Failed to mark session as paid:', err.message));
      }

      // Treatments normally settled at reception that this journey prepaid (the
      // over-threshold case) still carry "UNPAID — pay on location" in Mindbody.
      // Clear it now the money has landed, or the front desk charges a guest who
      // has already paid. Best-effort: a note failure must never break the
      // confirmation the customer is waiting for.
      const prepaidOnLocationIds = String(session.metadata?.prepaid_on_location_apt_ids || '')
        .split(',').map(s => s.trim()).filter(Boolean);
      if (prepaidOnLocationIds.length > 0) {
        await Promise.all(prepaidOnLocationIds.map(aptId =>
          mindbodyService.updateAppointmentNotes(aptId, '📱 WhatsApp Bot | PAID online')
            .catch(err => logger.warn(`Could not clear UNPAID note on appointment ${aptId}:`, err.message))
        ));
      }

      if (pending?.from) {

        // Build WhatsApp confirmation message. If the payment landed on a
        // booking whose slot was already released, do NOT claim it is
        // confirmed — tell the customer the team is on it, and actually tell
        // the team (they must rebook the slot or refund).
        if (!pending.from.startsWith('web_')) {
          const confirmMsg = paidDeadBooking
            ? `Payment received! ✅\n\nWe're just double-checking your booking on our side — our team will confirm it with you shortly. Nothing more needed from you right now 🙏`
            : (pending.serviceName?.includes('+') || pending.serviceName?.includes(',')
              ? `Payment received! ✅\n\nYour bookings are confirmed:\n${pending.serviceName}\n\nSee you at Renessence! 🙏\n\nIs there anything else I can help you with?`
              : `Payment received! ✅\n\nYour booking for *${pending.serviceName}* on ${pending.dateTime} is now fully confirmed.\n\nSee you at Renessence! 🙏\n\nIs there anything else I can help you with, or would you like to make another booking?`);
          await whatsappService.sendText(pending.from, confirmMsg);
        }
        if (paidDeadBooking) {
          emailService.sendEscalationEmail({
            customerName: pending.customerName || 'Unknown',
            customerPhone: pending.from,
            customerEmail: pending.customerEmail,
            message: `PAYMENT ON RELEASED BOOKING: Stripe session ${session.id} was paid for "${pending.serviceName}" (${pending.dateTime}), but the appointment(s) [${pending.appointmentId}] were already cancelled by the payment timeout. Rebook the slot for the customer or refund the payment.`,
          }).catch(err => logger.error('Dead-booking escalation email failed:', err.message));
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
        // A session's metadata names the rows it billed AT MINT TIME — but by
        // the time the expiry event arrives (possibly minutes late, possibly
        // redelivered), those rows may have moved on: rebilled on a newer
        // session after a rollback, or PAID via another link. Expiry may only
        // destroy what still BELONGS to this session: rows whose
        // stripe_session_id equals this session and whose status is still
        // in-flight. Everything else is skipped, and appointments are only
        // cancelled for rows this handler actually expired. This also makes
        // redelivery idempotent: the second delivery finds the rows already
        // 'expired' and touches nothing.
        const expiredUpdates = {
          status: 'expired',
          cancelledAt: new Date().toISOString(),
          cancelReason: 'expired',
        };
        const expiredEventIds = String(pending.bookingEventIds || session.metadata?.booking_event_ids || '')
          .split(',').map(s => s.trim()).filter(Boolean);

        const aptIdsToCancel = [];
        if (expiredEventIds.length > 0) {
          for (const id of expiredEventIds) {
            const row = await db.getBookingEventById(id).catch(() => null);
            if (!row) {
              logger.warn(`Expired-session webhook: booking_event ${id} unreadable — leaving untouched (fail safe)`);
              continue;
            }
            if (row.stripe_session_id !== session.id) {
              logger.info(`Expired-session webhook: booking_event ${id} now belongs to session ${row.stripe_session_id || '(none)'} — not ours to expire`);
              continue;
            }
            if (row.status !== 'payment_sent' && row.status !== 'pending') {
              logger.info(`Expired-session webhook: booking_event ${id} is '${row.status}' — nothing to expire`);
              continue;
            }
            const ok = await db.updateBookingEventIfStatus(id, ['pending', 'payment_sent'], expiredUpdates);
            if (ok === true && row.mindbody_appointment_id) {
              aptIdsToCancel.push(String(row.mindbody_appointment_id));
            } else if (ok !== true) {
              logger.warn(`Expired-session webhook: booking_event ${id} slipped away mid-expiry (${ok === false ? 'status changed' : 'DB error'}) — not cancelling its appointment`);
            }
          }
        } else {
          // Legacy fallback (no metadata ids): keyed by stripe_session_id, so
          // ownership is inherent; the status guard still protects paid rows.
          await db.updateBookingByStripeSession(session.id, expiredUpdates)
            .catch(err => logger.error('Failed to mark session expired:', err.message));
          aptIdsToCancel.push(...String(pending.appointmentId).split(',').map(s => s.trim()).filter(Boolean));
        }

        // Cancel ONLY the appointments whose rows this handler expired.
        let cancelledAny = false;
        for (const aptId of aptIdsToCancel) {
          try {
            // Belt-and-braces: even for rows we just expired, refuse if the
            // appointment's LATEST row reads paid (multi-row edge cases).
            const row = await db.getBookingEventByAppointment(aptId).catch(() => null);
            if (row?.status === 'paid') {
              logger.warn(`Expired-session webhook: apt ${aptId} reads PAID — refusing to cancel`);
              continue;
            }
            await mindbodyService.cancelAppointment(aptId);
            cancelledAny = true;
            logger.info('Auto-cancelled unpaid appointment:', aptId);
          } catch (err) {
            const msg = (err.response?.data?.Error?.Message || err.message || '').toLowerCase();
            if (msg.includes('cancel') || msg.includes('already') || msg.includes('status') || msg.includes('not found')) {
              logger.info('Appointment already cancelled/missing, skipping:', aptId);
            } else {
              logger.error('Failed to auto-cancel appointment:', err.message);
            }
          }
        }

        // Tell the customer only if this event actually released something.
        if (cancelledAny && pending.from && !pending.from.startsWith('web_')) {
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

module.exports = router;
