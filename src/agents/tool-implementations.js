/**
 * Tool implementations for the Renessence AI Agent.
 */

const conversationService = require('../services/conversation.service');
const mindbodyService = require('../services/mindbody.service');
const paymentService = require('../services/payment.service');
const whatsappService = require('../services/whatsapp.service');
const emailService = require('../services/email.service');
const giftCardCheck = require('../services/gift-card-check.service');
const db = require('../data/database');
const logger = require('../utils/logger');
const { formatDutchDate, formatDutchTime, formatDateISO, addDays } = require('../utils/date');
const { SERVICE_SLOT_TIMES, SERVICE_DURATIONS, FIXED_GRID_SERVICES } = require('../config/slot-times');
const dynamicCatalogService = require('../services/dynamic-catalog.service');

// Static catalog (synchronous — loaded at startup)
const _catalog = dynamicCatalogService.getCatalog();

function getServiceName(sessionTypeId) {
  return dynamicCatalogService.getServiceName(sessionTypeId);
}

// Session types that are only bookable on specific days of week (0=Sun,1=Mon,...,5=Fri,6=Sat)
const DAY_RESTRICTIONS = {
  45: [5],    // Nervous System Reset 60 min — Fridays only
  63: [5],    // Nervous System Reset 80 min — Fridays only
  43: [4, 6], // Acupuncture First — Thursdays & Saturdays only
  44: [4, 6], // Acupuncture Follow-up 60 min — Thursdays & Saturdays only
  52: [4, 6], // Acupuncture Follow-up 75 min — Thursdays & Saturdays only
  109: [2],   // Let It Go (Midgie) — Tuesdays only
};

async function toolCheckAvailability(from, { session_type_ids, start_date, end_date, part_of_day }) {
  // C6: fetch all session types in parallel instead of sequentially
  let anySuccess = false;
  const results = await Promise.all(
    session_type_ids.map(id =>
      mindbodyService.getBookableItems(id, start_date, end_date)
        .then(items => {
          anySuccess = true;
          return items.filter(item => {
            const restriction = DAY_RESTRICTIONS[id];
            if (!restriction) return true;
            return restriction.includes(new Date(item.StartDateTime).getDay());
          });
        })
        .catch(err => { logger.warn(`check_availability failed for id ${id}:`, err.message); return []; })
    )
  );
  let allItems = results.flat();

  // M8: distinguish "no availability" from "all API calls failed"
  if (!anySuccess) return { error: 'availability_check_failed', slots: [], staff: [] };
  if (allItems.length === 0) return { slots: [], staff: [] };

  const now = new Date();
  const slots = [];
  const staffMap = {};

  for (const item of allItems) {
    const windowStart = new Date(item.StartDateTime);
    // Use EndDateTime as the hard end of the staff's shift.
    // A slot is only valid if the full session fits: slotTime + duration <= shiftEnd.
    const shiftEnd = new Date(item.EndDateTime);
    const staffId = item.Staff?.Id || 0;
    const staffName = item.Staff?.Name || null;
    const sessionTypeId = item.SessionType?.Id || 0;
    const windowDateStr = item.StartDateTime.split('T')[0];
    const validTimes = SERVICE_SLOT_TIMES[sessionTypeId];
    const durationMs = (SERVICE_DURATIONS[sessionTypeId] || 60) * 60000;
    // Authoritative price for this treatment, so the confirmation summary can
    // show the correct amount (esp. for pay-on-location treatments paid at
    // reception). Same source as billing, so it always matches.
    const priceEur = paymentService.getPrice(sessionTypeId);
    const priceLabel = priceEur != null ? `€${priceEur}` : null;

    if (staffId && staffName) staffMap[staffId] = staffName;

    const pad = n => String(n).padStart(2, '0');

    // Helper to push a slot if it passes all validity checks
    const tryAddSlot = (slotTime, timeLabel) => {
      const slotEnd = new Date(slotTime.getTime() + durationMs);
      if (slotTime > now && slotTime >= windowStart && slotEnd <= shiftEnd) {
        const dateTime = `${windowDateStr}T${timeLabel}:00`;
        slots.push({
          id: `slot_${dateTime}_${staffId}_${sessionTypeId}`,
          dateTime,
          dateLabel: formatDutchDate(dateTime),
          timeLabel,
          staffId,
          staffName,
          sessionTypeId,
          serviceName: getServiceName(sessionTypeId),
          price: priceLabel,
        });
      }
    };

    if (validTimes) {
      const windowDurationMs = shiftEnd - windowStart;
      // Narrow window = pre-scheduled specific slot (e.g. therapist booked 12:50-14:00 for a
      // 60-min session, ratio 1.17x). Only the exact StartDateTime is a valid Mindbody slot.
      // Wide window = open availability block (e.g. sauna room open 08:00-20:00 for 25-min
      // sessions, ratio 28.8x). Use fixed slot times within the window.
      const isNarrowWindow = windowDurationMs < durationMs * 2;

      // Room/resource services (Float, saunas, oxygen, etc.) must ONLY be offered
      // on their fixed grid — a window that starts off-grid (e.g. a 17:55
      // leftover gap) is not a real bookable slot and Mindbody rejects it at
      // booking, causing a ghost-slot retry loop. So force the grid path for
      // these, even for narrow windows. Per-therapist services keep the
      // narrow-window behaviour, where an off-grid window start IS bookable.
      const gridOnly = FIXED_GRID_SERVICES.has(sessionTypeId);

      if (isNarrowWindow && !gridOnly) {
        // Pre-scheduled therapist window: the exact windowStart is the valid slot
        const wsLabel = `${pad(windowStart.getHours())}:${pad(windowStart.getMinutes())}`;
        tryAddSlot(windowStart, wsLabel);
      } else {
        // Wide open block — generate from fixed slot times only.
        // Do NOT add windowStart if it falls outside the fixed times: arbitrary shift-start
        // times (e.g. 12:10 after a previous booking) would produce slots that Mindbody
        // rejects at booking time ("Resource is required" / invalid start time).
        for (const timeStr of validTimes) {
          const slotTime = new Date(`${windowDateStr}T${timeStr}:00`);
          tryAddSlot(slotTime, timeStr);
        }
      }
    } else {
      // Fallback: every 60 min rounded to half hour
      let t = new Date(windowStart);
      const m = t.getMinutes();
      if (m > 0 && m <= 30) t.setMinutes(30, 0, 0);
      else if (m > 30) t.setHours(t.getHours() + 1, 0, 0, 0);

      while (new Date(t.getTime() + durationMs) <= shiftEnd) {
        if (t > now) {
          const dateTime = `${t.getFullYear()}-${pad(t.getMonth()+1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}:00`;
          slots.push({
            id: `slot_${dateTime}_${staffId}_${sessionTypeId}`,
            dateTime,
            dateLabel: formatDutchDate(dateTime),
            timeLabel: `${pad(t.getHours())}:${pad(t.getMinutes())}`,
            staffId,
            staffName,
            sessionTypeId,
            serviceName: getServiceName(sessionTypeId),
            price: priceLabel,
          });
        }
        t = new Date(t.getTime() + 60 * 60000);
      }
    }
  }

  // Deduplicate by dateTime + staffId + sessionTypeId
  const seen = new Set();
  const unique = slots.filter(s => {
    const key = `${s.dateTime}_${s.staffId}_${s.sessionTypeId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => a.dateTime.localeCompare(b.dateTime));

  // Unique staff available
  const staff = Object.entries(staffMap).map(([id, name]) => ({ id: Number(id), name }));

  // Loop-breaker: drop any slot the customer already tried to book that failed
  // in this conversation, so a ghost/just-taken slot can never be re-offered.
  const failedSlots = conversationService.get(from)?.failedSlots || [];
  const failedSet = new Set(failedSlots.map(f => `${f.dateTime}_${f.sessionTypeId}`));
  const usable = failedSet.size ? unique.filter(s => !failedSet.has(`${s.dateTime}_${s.sessionTypeId}`)) : unique;

  // If every requested treatment has already failed to book twice, stop the
  // loop: tell the model to escalate to the team instead of re-offering.
  const failCount = {};
  for (const f of failedSlots) failCount[f.sessionTypeId] = (failCount[f.sessionTypeId] || 0) + 1;
  const requested = session_type_ids || [];
  if (requested.length > 0 && requested.every(id => (failCount[id] || 0) >= 2)) {
    return {
      slots: [],
      staff: [],
      repeated_failure: true,
      message: 'Booking this treatment has failed repeatedly. Do NOT offer the same slot again. Apologise to the customer and call request_human_handoff (reason "repeated booking failure") so the team can help.',
    };
  }

  if (usable.length === 0) {
    return {
      slots: [],
      staff: [],
      no_availability: true,
      message: 'No availability found for the requested date(s). Respond to the customer with a friendly message and suggest they try a different date.',
    };
  }

  // The WhatsApp list shows max 10 rows and the slots are sorted by time, so a
  // full-day treatment (e.g. Sweat & Reset every 35 min) would only ever show
  // the first 10 = MORNING, and an "afternoon" request still got morning slots.
  // Filter by the requested part of day so the customer sees the right times.
  const hourOf = (dt) => parseInt(dt.slice(11, 13), 10);
  let pool = usable;
  if (part_of_day) {
    const p = String(part_of_day).toLowerCase();
    pool = usable.filter(s => {
      const h = hourOf(s.dateTime);
      if (p === 'morning') return h < 12;
      if (p === 'afternoon') return h >= 12 && h < 17;
      if (p === 'evening') return h >= 17;
      return true;
    });
  }

  // One row per (date+time, treatment): a service with several rooms/therapists
  // free at the same time (e.g. two IR chambers) would otherwise show the same
  // time twice — "12:15, 12:15, ...". Keep the first (it carries a valid
  // resource/staff for booking; the exact room is picked at booking time).
  const seenTime = new Set();
  pool = pool.filter(s => {
    const k = `${s.dateTime}_${s.sessionTypeId}`;
    if (seenTime.has(k)) return false;
    seenTime.add(k);
    return true;
  });

  const range = { earliest: usable[0].timeLabel, latest: usable[usable.length - 1].timeLabel };

  if (pool.length === 0) {
    // The requested part of day is empty, but other times ARE free — don't imply
    // there's nothing; tell the model the real range so it can offer alternatives.
    return {
      slots: [],
      staff,
      no_slots_in_part: true,
      requested_part: part_of_day,
      available_range: range,
      message: `No ${part_of_day} slots for the requested date, but there IS availability at other times (from ${range.earliest} to ${range.latest}). Tell the customer there are no ${part_of_day} slots, mention the times that ARE available, and offer another part of the day.`,
    };
  }

  // Deterministic safety net (does NOT depend on the model): with no part-of-day
  // preference and more slots than fit in the 10-row list, show an even SPREAD
  // across the whole day instead of the earliest 10. Otherwise a full-day
  // treatment always looked "mornings only" — the exact bug reported. When the
  // model DID pass part_of_day, pool is already the right window, so keep those
  // adjacent (slice).
  const pickSpread = (arr, n) => {
    if (arr.length <= n) return arr;
    const stepN = (arr.length - 1) / (n - 1);
    const seen = new Set();
    const out = [];
    for (let i = 0; i < n; i++) {
      const s = arr[Math.round(i * stepN)];
      if (s && !seen.has(s.dateTime)) { seen.add(s.dateTime); out.push(s); }
    }
    return out;
  };
  const spreadShown = !part_of_day && pool.length > 10;
  const shownSlots = spreadShown ? pickSpread(pool, 10) : pool.slice(0, 10);

  return {
    slots: shownSlots,
    staff,
    total_available: usable.length,
    shown: shownSlots.length,
    // When spread is true the times shown are sampled across the whole day (not
    // consecutive) — if the customer wants a specific part of day, call again
    // with part_of_day for the exact adjacent times there.
    spread: spreadShown,
    available_range: range, // full span of the day, so you never imply "morning only"
  };
}

async function toolLookupClient(from) {
  if (from.startsWith('web_')) return { found: false };
  try {
    const client = await mindbodyService.getClientByPhone(from, null);
    if (client) {
      return {
        found: true,
        name: `${client.FirstName} ${client.LastName}`.trim(),
        email: client.Email || null,
        clientId: String(client.Id),
      };
    }
    return { found: false };
  } catch (err) {
    logger.warn('lookup_client error:', err.message);
    return { found: false };
  }
}

// Append a real booking to the per-conversation pending list so send_payment
// never has to trust AI-provided IDs. De-duplicates by booking_event_id so a
// reused/idempotent booking doesn't create a second Stripe line item.
function recordPendingBooking(from, booking) {
  const list = conversationService.get(from)?.pendingBookings || [];
  // De-dup by booking_event_id, falling back to appointment_id (the Mindbody id
  // is present even when logBookingEvent failed and booking_event_id is null),
  // so the same appointment never produces two Stripe line items.
  const dup = list.some(b =>
    (booking.booking_event_id && b.booking_event_id === booking.booking_event_id) ||
    (booking.appointment_id && b.appointment_id === booking.appointment_id)
  );
  if (dup) return;
  list.push(booking);
  conversationService.set(from, { pendingBookings: list });
}

// Record a slot that just failed to book so check_availability never re-offers
// it (loop-breaker). Uses set() — update() no-ops if the conversation TTL'd out.
function recordFailedSlot(from, sessionTypeId, dateTime) {
  const failed = conversationService.get(from)?.failedSlots || [];
  conversationService.set(from, { failedSlots: [...failed, { sessionTypeId, dateTime }] });
}

// Custom payment timeline after a link is sent (WhatsApp only). The customer is
// told they have 10 minutes; then:
//   T+5  → reminder: pay within 5 minutes
//   T+10 → tell the customer their payment time has expired
//   T+15 → if STILL unpaid, silently remove the booking from Mindbody (NO
//          message — they were already told at T+10). The 10→15 gap is a quiet
//          grace buffer so someone who pays a minute or two late is still
//          honoured.
// Stripe's own minimum auto-expiry is 30 min, so we drive the short window
// ourselves. In-memory timers; on restart it falls back to the 30-min Stripe
// expiry + the every-5-min safety cron.
function schedulePaymentTimeline(from, sessionId, paymentUrl, appointmentIds) {
  if (!sessionId || String(from).startsWith('web_')) return;
  const lang = conversationService.get(from)?.lang || 'en';

  const stillUnpaid = async () => {
    const info = await paymentService.getSessionStatus(sessionId);
    return !!info && info.status === 'open' && info.paymentStatus !== 'paid';
  };
  const sendLink = async (msg) => {
    if (paymentUrl) await whatsappService.sendCTAButton(from, msg, lang === 'nl' ? 'Betaal Nu' : 'Pay Now', paymentUrl);
    else await whatsappService.sendText(from, msg);
    db.logMessage(from, 'assistant', msg);
  };

  // T+5: reminder
  setTimeout(async () => {
    try {
      if (!(await stillUnpaid())) return;
      await sendLink(lang === 'nl'
        ? '⏳ Snelle herinnering: je boeking is nog niet bevestigd. Rond je betaling binnen 5 minuten af, anders wordt je plek vrijgegeven. Hier is je betaallink 👇'
        : '⏳ Quick reminder: your booking isn\'t confirmed yet. Please complete your payment within 5 minutes, otherwise your spot is released. Here\'s your payment link 👇');
    } catch (err) { logger.warn('Payment reminder (5m) failed:', err.message); }
  }, 5 * 60 * 1000);

  // T+10: tell them the payment time has expired (the link still quietly works
  // for a few more minutes so a slightly-late payment is honoured).
  setTimeout(async () => {
    try {
      if (!(await stillUnpaid())) return;
      await sendLink(lang === 'nl'
        ? '⌛ Je betaaltijd is verlopen en je boeking komt te vervallen. Als je net hebt betaald of nu nog betaalt, gaat je boeking gewoon door. 👇'
        : '⌛ Your payment time has expired and your booking will be released. If you have just paid, or pay right now, your booking will still go through. 👇');
    } catch (err) { logger.warn('Payment warning (10m) failed:', err.message); }
  }, 10 * 60 * 1000);

  // T+15: SILENTLY remove the booking from Mindbody if still unpaid. We cancel
  // the appointments first (so no second message), then expire the Stripe
  // session so a payment can no longer land on a released slot.
  setTimeout(async () => {
    try {
      if (!(await stillUnpaid())) return;
      for (const aptId of (appointmentIds || []).filter(Boolean)) {
        try {
          // Never cancel an appointment whose row reads PAID — this session
          // may be an orphaned duplicate while the customer paid another link
          // for the same booking (verify finding: refire). stillUnpaid() only
          // vouches for THIS session, so check the appointment itself.
          const row = await db.getBookingEventByAppointment(aptId);
          if (row?.status === 'paid') {
            logger.warn(`Payment timeout: apt ${aptId} reads PAID (another session) — refusing to cancel`);
            continue;
          }
          try {
            await mindbodyService.cancelAppointment(aptId);
          } catch (cancelErr) {
            if (!mindbodyService.isBenignCancelError(cancelErr)) {
              // Real release failure: do NOT mark the row expired — leaving it
              // 'payment_sent' keeps it inside the cron's retry and the
              // reconciliation sweep's reach. Flag it for the team.
              db.logError('appointment_release_failed', `T+15 timeout could not release apt ${aptId}: ${cancelErr.message}. Row left in-flight for the cron.`, '', JSON.stringify({ aptId }));
              logger.error('Payment-timeout cancel failed for apt', aptId, cancelErr.message);
              continue;
            }
            // Benign already-gone: fall through and mark expired.
          }
          db.query(
            `UPDATE booking_events SET status='expired', cancelled_at=NOW(), cancel_reason='payment_timeout' WHERE mindbody_appointment_id=$1 AND status <> 'paid'`,
            [aptId]
          ).catch(() => {});
        } catch (err) {
          logger.warn('Payment-timeout handling failed for apt', aptId, err.message);
        }
      }
      // Close the payment window — and CONFIRM it closed. A zombie session
      // that survives here stays payable until Stripe's own expiry while the
      // slots are already released; clearing lastBillingLink stops the
      // re-share path from surfacing it (the completed-webhook's dead-booking
      // escalation is the backstop if it does get paid).
      let expiredOk = await paymentService.expireSession(sessionId);
      if (!expiredOk) expiredOk = await paymentService.expireSession(sessionId);
      if (!expiredOk) {
        db.logError('zombie_session_after_timeout', `Session ${sessionId} for ${from} could not be expired after its bookings were released — a payment on it will need the team (dead-booking escalation covers it).`, '', JSON.stringify({ from }));
      }
      const convLink = conversationService.get(from)?.lastBillingLink;
      if (convLink?.sessionId === sessionId) {
        conversationService.update(from, { lastBillingLink: null });
      }
      logger.info('Payment timeout (silent): released booking, session', sessionId, 'for', from);

      // Turn the lost booking into a chance to improve: invite feedback with a
      // free treatment as a thank-you. (Only people who didn't pay get this.)
      try {
        const fbMsg = lang === 'nl'
          ? 'Je boeking is helaas niet afgerond. We maken het graag beter 🌿 Wil je ons kort vertellen hoe je onze boekings-assistent hebt ervaren? Als dank krijg je een GRATIS Red Light Therapy of Hydrowave massage 💚'
          : 'Your booking wasn\'t completed. We\'d love to do better 🌿 Would you share a little feedback on how our booking assistant worked for you? As a thank-you you\'ll get a FREE Red Light Therapy or Hydrowave massage 💚';
        await whatsappService.sendCTAButton(from, fbMsg, lang === 'nl' ? 'Geef feedback' : 'Give feedback', 'https://renessence.com/help-us-improve');
        db.logMessage(from, 'assistant', fbMsg);
      } catch (fbErr) { logger.warn('Feedback invite failed:', fbErr.message); }
    } catch (err) { logger.warn('Payment cancel (15m) failed:', err.message); }
  }, 15 * 60 * 1000);
}

async function toolBookAppointment(from, { session_type_id, start_date_time, staff_id, client_name, client_email, notes, skip_payment, defer_payment, client_phone }) {
  // 1. Find or create client
  const phoneForLookup = from.startsWith('web_') ? (client_phone || null) : from;
  let client = phoneForLookup ? await mindbodyService.getClientByPhone(phoneForLookup, client_email || null) : null;
  if (!client) {
    if (!client_name || !client_email) {
      return { error: 'client_info_required', message: 'Need full name and email to create account.' };
    }
    if (from.startsWith('web_') && !client_phone) {
      return { error: 'client_phone_required', message: 'Need phone number to create account.' };
    }
    const parts = client_name.trim().split(' ');
    const firstName = parts[0];
    const lastName = parts.slice(1).join(' ') || (from.startsWith('web_') ? 'Web' : 'WhatsApp');
    try {
      client = await mindbodyService.addClient({ firstName, lastName, email: client_email, mobilePhone: phoneForLookup || from, city: 'Amsterdam' });
    } catch (addErr) {
      if (addErr.response?.data?.Error?.Code === 'InvalidClientCreation') {
        client = await mindbodyService.getClientByPhone(from, client_email);
        if (!client) throw addErr;
      } else throw addErr;
    }
  }

  // Idempotency guard: if this customer already has a fresh, non-cancelled
  // booking for this exact session type + time, reuse it instead of creating a
  // duplicate. The model sometimes re-fires book_appointment (e.g. after a
  // transient "slot taken"), which previously double-booked the customer.
  if (!skip_payment) {
    const existingBooking = await db.getRecentBooking(from, session_type_id, start_date_time);
    if (existingBooking && existingBooking.mindbody_appointment_id) {
      logger.info('Idempotent book_appointment: reusing existing booking', existingBooking.mindbody_appointment_id);
      const priceCentsX = paymentService.getPriceInCents(session_type_id);
      const dateLabelX = formatDutchDate(start_date_time);
      const timeLabelX = formatDutchTime(start_date_time);
      const langX = conversationService.get(from)?.lang || 'en';
      const dateTimeLabelX = `${dateLabelX} ${langX === 'nl' ? 'om' : 'at'} ${timeLabelX}`;
      const serviceNameX = getServiceName(session_type_id);

      // What happens next depends on how far the ORIGINAL booking got. Blindly
      // re-adding to the cart here re-armed auto-billing for bookings that were
      // already billed or already PAID — a second Stripe session whose 15-min
      // timeline could cancel the very appointment the customer paid for
      // (audit finding #1/#5). getRecentBooking matches any non-cancelled row
      // from the last 15 minutes, so 'paid' and 'payment_sent' land here too.
      const base = {
        success: true,
        appointment_id: existingBooking.mindbody_appointment_id,
        service_name: serviceNameX,
        date_time_label: dateTimeLabelX,
        dateLabel: dateLabelX,
        timeLabel: timeLabelX,
        already_booked: true,
      };

      // These two status checks run BEFORE the pay-online/pay-on-location
      // split: a pay-on-location treatment that was prepaid as part of an
      // over-threshold journey has a 'paid'/'payment_sent' row too, and
      // answering it with "pay at reception" would contradict a live payment
      // link whose fuse can then silently cancel it (verify finding: refire).
      if (existingBooking.status === 'paid') {
        return {
          ...base,
          already_paid: true,
          requiresPayment: false,
          message: 'This booking is already PAID. Confirm it warmly; do NOT mention payment or send any payment link.',
        };
      }

      if (existingBooking.status === 'payment_sent') {
        // Re-share ONLY the link that belongs to THIS booking's session.
        // lastBillingLink is conversation-global; in a two-journey chat it may
        // be journey 2's link, and pointing booking 1's customer at it would
        // have them pay the wrong session while booking 1's fuse burns.
        const link = conversationService.get(from)?.lastBillingLink;
        const linkMatches = link?.url && existingBooking.stripe_session_id
          && link.sessionId === existingBooking.stripe_session_id;
        return {
          ...base,
          payment_link_already_sent: true,
          requiresPayment: false,
          ...(linkMatches ? { paymentUrl: link.url } : {}),
          message: 'A payment link was already sent for this booking. Tell the customer to use the link they received' + (linkMatches ? ' (re-share it via cta_button if helpful)' : '') + '; do NOT call send_payment again.',
        };
      }

      // Still unbilled. getRecentBooking DELIBERATELY matches 'pay_on_location'
      // rows (so a re-fire is de-duplicated instead of creating a second
      // Mindbody appointment). A re-fired pay-on-location booking returns the
      // same shape as a fresh one; recordPendingBooking below de-dups it in
      // the cart, so the journey total stays correct without double entries.
      if (!paymentService.requiresOnlinePayment(session_type_id)) {
        return {
          ...base,
          appointmentId: existingBooking.mindbody_appointment_id,
          serviceName: serviceNameX,
          dateTimeLabel: dateTimeLabelX,
          requiresPayment: false,
          payOnLocation: true,
          amount_cents: priceCentsX,
          price: priceCentsX != null ? `€${priceCentsX / 100}` : null,
        };
      }

      // Still unbilled ('pending') → same as a fresh booking: back into the
      // cart, auto-billing re-armed. recordPendingBooking de-dups by id.
      recordPendingBooking(from, {
        booking_event_id: existingBooking.id,
        appointment_id: existingBooking.mindbody_appointment_id,
        session_type_id,
        service_name: serviceNameX,
        date_time_label: dateTimeLabelX,
        amount_cents: priceCentsX,
      });
      scheduleAutoPaymentLink(from);
      return {
        ...base,
        booking_event_id: existingBooking.id,
        amount_cents: priceCentsX,
        requiresPayment: !!priceCentsX,
        deferred: true,
      };
    }
  }

  // Journey cap: more than 3 treatments in one journey (one payment batch) is
  // arranged personally by the team, not auto-booked. If 3 are already in the
  // cart, refuse the 4th and route to a human handoff.
  if (!skip_payment) {
    const cartCount = (conversationService.get(from)?.pendingBookings || []).length;
    if (cartCount >= 3) {
      return {
        error: 'too_many_treatments',
        message: 'The customer already has 3 treatments in this booking journey and is trying to add a 4th. Journeys of more than 3 treatments are arranged personally by our team — do NOT book this one. Tell the customer that for 4 or more treatments in one visit our team will set it up for them, ask for their email, then call request_human_handoff with the reason "journey of 4+ treatments".',
      };
    }
  }

  // Hard confirmation gate: creating a NEW appointment requires that the
  // customer actually tapped the "Confirm" button (id=confirm_booking) within
  // the last 10 minutes. This guarantees the confirmation summary — which
  // carries the health declaration and cancellation policy — is never skipped,
  // no matter how the model behaves. Reschedules (skip_payment) are exempt:
  // they have their own confirmation in the reschedule flow.
  if (!skip_payment) {
    const conf = conversationService.get(from)?.bookingConfirmedAt;
    const confirmedRecently = conf && (Date.now() - conf) < 10 * 60 * 1000;
    if (!confirmedRecently) {
      return {
        error: 'confirmation_required',
        message: 'You have not received the customer\'s confirmation yet. Before booking you MUST show the confirmation summary (treatment, date, time, name + the health and cancellation declaration) with Confirm/Cancel buttons (id "confirm_booking"), and only call book_appointment after the customer taps "Confirm". Show that confirmation now — do NOT book yet.',
      };
    }
    // Consume the confirmation so it covers exactly one booking.
    conversationService.update(from, { bookingConfirmedAt: null });
  }

  // 2. Book appointment — extract Mindbody error message on failure
  // Always tag bookings made via the WhatsApp bot so staff can identify them in Mindbody.
  // Pay-on-location treatments (Float, saunas, oxygen, etc.) carry no Stripe link,
  // so we tag them UNPAID in Mindbody — that's how the front desk knows to collect
  // payment at the visit.
  const payOnLocation = !paymentService.requiresOnlinePayment(session_type_id);
  const botTag = '📱 WhatsApp Bot';
  const noteParts = [botTag];
  if (payOnLocation) noteParts.push('UNPAID — pay on location');
  if (notes) noteParts.push(notes);
  const finalNotes = noteParts.join(' | ');

  let appointment;
  try {
    appointment = await mindbodyService.addAppointment({
      clientId: client.Id,
      sessionTypeId: session_type_id,
      staffId: staff_id || 0,
      startDateTime: start_date_time,
      notes: finalNotes,
    });
  } catch (bookErr) {
    const mbMsg = bookErr.response?.data?.Error?.Message || bookErr.message;
    const mbCode = bookErr.response?.data?.Error?.Code || '';
    logger.warn('toolBookAppointment first attempt failed:', mbMsg);

    // If staff-related error and we had a specific staffId, retry without it
    const isStaffError = mbMsg && (
      mbMsg.toLowerCase().includes('staff') ||
      mbMsg.toLowerCase().includes('subscriber')
    );
    if (isStaffError && staff_id) {
      logger.info('Retrying booking without staffId...');
      try {
        appointment = await mindbodyService.addAppointment({
          clientId: client.Id,
          sessionTypeId: session_type_id,
          staffId: 0,
          startDateTime: start_date_time,
          notes: finalNotes,
        });
      } catch (retryErr) {
        const retryMsg = retryErr.response?.data?.Error?.Message || retryErr.message;
        const retryCode = retryErr.response?.data?.Error?.Code || '';
        logger.error('toolBookAppointment retry also failed:', retryMsg);
        db.logError('booking_failed', retryMsg, retryCode, JSON.stringify({
          phone: from, session_type_id, start_date_time, staff_id, mbCode, firstError: mbMsg,
        }));
        recordFailedSlot(from, session_type_id, start_date_time);
        return { error: 'booking_failed', mindbody_message: retryMsg };
      }
    } else {
      logger.error('toolBookAppointment Mindbody error:', mbMsg);
      db.logError('booking_failed', mbMsg, mbCode, JSON.stringify({
        phone: from, session_type_id, start_date_time, staff_id,
      }));
      recordFailedSlot(from, session_type_id, start_date_time);
      return { error: 'booking_failed', mindbody_message: mbMsg };
    }
  }

  const serviceName = getServiceName(session_type_id);
  const dateLabel = formatDutchDate(start_date_time);
  const timeLabel = formatDutchTime(start_date_time);
  const lang = conversationService.get(from)?.lang || 'en';
  const atWord = lang === 'nl' ? 'om' : 'at';
  const dateTimeLabel = `${dateLabel} ${atWord} ${timeLabel}`;

  // 3. Log to DB
  // One atomic INSERT — the appointment id and date must never arrive in a
  // separate write, because a row without them is invisible to every
  // safety-net query (round-5 verify finding).
  const bookingEventId = await db.logBookingEvent({
    phone: from,
    customerName: client_name || `${client.FirstName} ${client.LastName}`.trim(),
    sessionTypeId: session_type_id,
    serviceName,
    // Pay-on-location bookings get their own status so the unpaid-timeout cron
    // (which only scans 'pending'/'confirmed'/'payment_sent') never touches them —
    // they are legitimately unpaid-online and must not be auto-cancelled.
    status: payOnLocation ? 'pay_on_location' : 'pending',
    amountCents: paymentService.getPriceInCents(session_type_id),
    appointmentDate: start_date_time,
    mindbodyAppointmentId: appointment.Id,
  });
  if (!bookingEventId && !payOnLocation && !skip_payment) {
    // logBookingEvent swallows DB errors and returns undefined. For a PAY-ONLINE
    // booking that leaves a live Mindbody slot with NO audit row — and the
    // unpaid-timeout cron reads only booking_events, so it could never bill it,
    // expire it, or even flag it: a free, unbillable, uncleanable slot. Safer to
    // roll the appointment back and fail so the customer simply retries.
    // (Pay-on-location and skip_payment reschedules are exempt: for them the
    // Mindbody appointment is itself the source of truth and no billing is owed.)
    logger.error(`book_appointment: no audit row persisted for pay-online booking apt ${appointment.Id} — rolling back to avoid an unbilled orphan slot`);
    try {
      await mindbodyService.cancelAppointment(appointment.Id);
    } catch (rollbackErr) {
      // Orphan slot: booked in Mindbody, no audit row, rollback failed. No
      // query can ever find it — flag it for the team explicitly.
      db.logError('orphan_unbilled_appointment', `Apt ${appointment.Id} (${serviceName || session_type_id}, ${from}) exists in Mindbody with NO audit row and could not be rolled back: ${rollbackErr.message}. MANUAL REVIEW: cancel or collect.`, '', JSON.stringify({ appointmentId: appointment.Id }));
      logger.error('book_appointment: rollback cancel failed:', rollbackErr.message);
    }
    return { error: 'booking_failed', mindbody_message: 'We could not fully confirm your booking just now. Please try again in a moment.' };
  }

  // Booking succeeded — clear any failed-slot records for this treatment so a
  // slot that later freed up isn't permanently blocked from being re-offered.
  const priorFailed = conversationService.get(from)?.failedSlots;
  if (priorFailed?.length) {
    conversationService.set(from, { failedSlots: priorFailed.filter(f => f.sessionTypeId !== session_type_id) });
  }

  // 4. Payment
  const priceCents = paymentService.getPriceInCents(session_type_id);

  // Pay-on-location treatments (Float, saunas, oxygen, red light, hydrowave, gym
  // combos) are settled at reception and the appointment is tagged UNPAID in
  // Mindbody. They still join the journey cart, because the prepay threshold is
  // a property of the JOURNEY, not of the treatment: on its own a €80 float is
  // paid at the desk, but as part of a €240 journey it is billed upfront with
  // everything else. paymentService.selectBillableItems makes that call at
  // billing time — recording it here only makes it visible to that decision.
  if (payOnLocation) {
    // skip_payment is a RESCHEDULE of an existing booking — the money for it is
    // already settled or already owed at reception. It must never enter the
    // cart, or moving a float to another day could push a later journey over
    // the threshold and bill the customer for it a second time.
    if (!skip_payment) {
      recordPendingBooking(from, {
        booking_event_id: bookingEventId,
        appointment_id: appointment.Id,
        session_type_id,
        service_name: serviceName,
        date_time_label: dateTimeLabel,
        amount_cents: priceCents,
        pay_on_location: true,
      });
      // Only bills if the journey later crosses the threshold; a sub-threshold
      // pay-on-location cart resolves to nothing_to_pay and sends no link.
      scheduleAutoPaymentLink(from);
    }
    return { success: true, appointmentId: appointment.Id, serviceName, dateLabel, timeLabel, dateTimeLabel, requiresPayment: false, payOnLocation: true, amount_cents: priceCents, price: priceCents != null ? `€${priceCents / 100}` : null };
  }

  // skip_payment: reschedule of same paid treatment — no payment needed at all
  if (skip_payment || !priceCents) {
    return { success: true, appointmentId: appointment.Id, serviceName, dateLabel, timeLabel, dateTimeLabel, requiresPayment: false };
  }

  // Record the real booking server-side so send_payment never has to trust
  // AI-provided IDs. The model sometimes hallucinates booking_event_id /
  // appointment_id (e.g. "1"), which detaches the Stripe payment from the real
  // appointment: the webhook marks a non-existent booking paid, the real row
  // stays 'pending', and the expiry cron then cancels a slot the customer paid
  // for. Storing the truth here closes that hole.
  recordPendingBooking(from, {
    booking_event_id: bookingEventId,
    appointment_id: appointment.Id,
    session_type_id,
    service_name: serviceName,
    date_time_label: dateTimeLabel,
    amount_cents: priceCents,
  });

  // Keep the billing details on the conversation so the automatic payment link
  // below can pre-fill the Stripe checkout even though the model isn't involved.
  conversationService.set(from, {
    customerEmail: client_email || conversationService.get(from)?.customerEmail || client.Email || null,
    customerName:  client_name  || conversationService.get(from)?.customerName  || `${client.FirstName || ''} ${client.LastName || ''}`.trim() || null,
  });

  // Payment is deferred so the bot can show "Add another treatment / Send
  // payment link" and bill a multi-treatment journey on ONE link. If the
  // customer never taps either button, scheduleAutoPaymentLink bills them
  // anyway after 5 minutes — the slot is already held, so it cannot be left
  // sitting there unpaid and unasked-for.
  scheduleAutoPaymentLink(from);

  return {
    success: true,
    booking_event_id: bookingEventId,
    appointment_id: appointment.Id,
    service_name: serviceName,
    date_time_label: dateTimeLabel,
    amount_cents: priceCents,
    dateLabel,
    timeLabel,
    requiresPayment: true,
    deferred: true,
  };
}

/**
 * Bill whatever is sitting in this conversation's cart.
 *
 * Shared by the send_payment tool (customer tapped "Send payment link") and by
 * the automatic sweep 5 minutes after a pay-online booking. The auto path is
 * why this is extracted: the link used to exist ONLY if the model chose to call
 * send_payment, so a customer who ignored the buttons kept a confirmed,
 * unpaid slot and was never asked for money.
 */
// One billing operation per conversation at a time. Without this, the T+5 auto
// timer and a customer tapping "Send payment link" in the same instant could
// each mint a Stripe session for the same cart — and whichever link the
// customer did NOT pay would have its 15-min timeline cancel the appointment
// they DID pay for (audit finding #3). The second caller simply receives the
// first caller's result.
const billingInFlight = new Map();

async function billPendingBookings(from, args) {
  const inFlight = billingInFlight.get(from);
  if (inFlight) return inFlight;
  const run = _billPendingBookings(from, args).finally(() => billingInFlight.delete(from));
  billingInFlight.set(from, run);
  return run;
}

async function _billPendingBookings(from, { customer_email, customer_name }) {
  // Bill ONLY the bookings recorded server-side during book_appointment. We do
  // NOT trust the model's `bookings` argument: it sometimes invents IDs (which
  // detaches the payment from the real appointment) and — now that most
  // treatments are pay-on-location — it could pass a pay-on-location treatment
  // that must never be charged online. recordPendingBooking runs for every
  // pay-online booking, so this list is the single source of truth for what to bill.
  const stored = conversationService.get(from)?.pendingBookings;
  const rawStored = (Array.isArray(stored) && stored.length) ? stored : [];

  // The cart is a MIRROR of booking_events, and mirrors go stale: the expiry
  // cron may have released an item, a re-fire may have re-added one that was
  // already billed, or the customer may have paid seconds ago. Money decisions
  // are made against the DB row, never the mirror: an item is billable only
  // while its row is still 'pending' (or 'pay_on_location') — audit #1/#2.
  //
  // Three buckets, because "not billable" and "not VERIFIABLE" are different
  // problems. A row in a resolved status is dropped for good. A row we cannot
  // READ (DB blip) postpones the WHOLE billing attempt instead: dropping it
  // would resolve the journey and permanently skip a legitimate charge — for
  // an appointment starting within ~40 min the cron's appointment_date filter
  // would then never rescue the slot either (verify finding: db-verify).
  const rawEffective = [];
  const unverifiable = [];
  for (const b of rawStored) {
    if (!b.booking_event_id) {
      // No audit row means no verification, no CAS write, no expiry ownership —
      // a rowless item sits outside every money guard, so it must never reach
      // a Stripe link (verify finding: paid-guards walked a cancelled rowless
      // float being charged). It stays desk-payable: its Mindbody note still
      // says UNPAID, so reception collects. Excluded from the journey total
      // too — an unverifiable amount must not tip other items into prepay.
      logger.warn(`send_payment: cart item for apt ${b.appointment_id} has no audit row — leaving it pay-at-reception, excluded from billing`);
      continue;
    }
    const row = await db.getBookingEventById(b.booking_event_id);
    if (row && (row.status === 'pending' || row.status === 'pay_on_location')) {
      rawEffective.push(b);
    } else if (!row) {
      unverifiable.push(b);
    } else {
      logger.warn(`send_payment: dropping cart item (booking_event ${b.booking_event_id}) — row status is '${row.status}', not billable`);
    }
  }

  if (unverifiable.length > 0) {
    // Leave the cart untouched and retry (bounded). Nothing is resolved,
    // nothing is minted: billing against state we cannot read risks a double
    // charge, and resolving the journey risks a permanent free slot.
    return postponeBilling(from, `${unverifiable.length} cart item(s) unverifiable (DB unreachable?)`, rawStored);
  }

  // Billing boundary — final hard guard on what may be charged online. Below
  // the journey prepay threshold this drops every pay-on-location treatment, as
  // it always has; at or above it the whole journey is billed upfront (a €240
  // massage + LED + float must not walk in unpaid). The rule lives in
  // payment.service so the money decision sits with the money code.
  const effective = paymentService.selectBillableItems(rawEffective);
  if (effective.length < rawEffective.length) {
    logger.warn(`send_payment: dropped ${rawEffective.length - effective.length} pay-on-location item(s) from the cart before billing (journey under the prepay threshold)`);
  } else if (rawEffective.some(b => b.pay_on_location)) {
    logger.info(`send_payment: journey crossed the prepay threshold — billing all ${effective.length} treatment(s) upfront, including pay-on-location ones`);
  }

  if (effective.length === 0) {
    // Nothing to bill. The journey is RESOLVED: clear the cart and disarm the
    // timer, or the finished journey's items leak into the next one — re-billed
    // on a later link, or falsely tripping the 3-treatment cap (audit #7).
    // Resolution is SUBTRACTIVE — only the snapshot this run examined leaves
    // the cart. A booking recorded while this run was mid-await survives, and
    // keeps its own timer (verify finding: wipe race).
    const remaining = resolveCartItems(from, rawStored);
    if (remaining.length === 0) cancelAutoPaymentLink(from);

    // If the server already auto-sent a link for this journey, "nothing to
    // bill" does NOT mean nothing is owed — the customer may be tapping "Send
    // payment link" minutes after the auto-link went out. But the stored link
    // is only re-shared after asking Stripe what it IS: a paid session means
    // nothing is owed (never dun a customer who paid — verify finding:
    // journey-end path A), and a dead session means the journey was released.
    const link = conversationService.get(from)?.lastBillingLink;
    if (link?.url && Date.now() - link.at < 20 * 60 * 1000) {
      const info = await paymentService.getSessionStatus(link.sessionId);
      // A Stripe API blip (info null) must NOT fall through to "nothing to
      // pay" while a live unpaid link may exist — re-sharing the link the
      // customer already has is harmless in every state (a paid session just
      // shows Stripe's already-paid page), whereas denying the debt while its
      // cancellation fuse burns is not (verify finding: live-status residual).
      if (!info || (info.status === 'open' && info.paymentStatus !== 'paid')) {
        return {
          success: true,
          payment_link_already_sent: true,
          paymentUrl: link.url,
          message: 'A payment link for this journey was ALREADY sent to the customer. Do not say nothing is owed — re-share that exact link via cta_button and ask them to complete it.',
        };
      }
      if (info && (info.status === 'expired')) {
        conversationService.update(from, { lastBillingLink: null });
        return {
          success: true,
          journey_expired: true,
          message: 'The payment window for the previous booking(s) expired and they were released. Do NOT say all is set — tell the customer the reservation lapsed and offer to book again.',
        };
      }
      // paid (or unknown): nothing is owed on that link — fall through.
      if (info?.paymentStatus === 'paid' || info?.status === 'complete') {
        conversationService.update(from, { lastBillingLink: null });
      }
    }
    return { success: true, nothing_to_pay: true, message: 'No online payment needed — these treatments are paid on location (or already paid). Just confirm the booking(s) warmly; do NOT send a payment link.' };
  }
  try {
    const payment = await paymentService.createCombinedPaymentLink({
      items: effective.map(b => ({
        bookingEventId: b.booking_event_id,
        appointmentId:  b.appointment_id,
        serviceName:    b.service_name,
        dateTimeLabel:  b.date_time_label,
        amountCents:    b.amount_cents,
        payOnLocation:  !!b.pay_on_location,
      })),
      customerEmail: customer_email,
      customerName:  customer_name,
      from,
    });

    // Persist the session id with a compare-and-swap: only rows still in a
    // billable status take the write. A row the paid-webhook flipped mid-mint
    // is NOT clobbered back to 'payment_sent' (TOCTOU), and — the lesson of
    // verify finding refire — a write that cannot be CONFIRMED is treated as
    // NOT DONE: the fresh session is expired rather than circulated, because a
    // link the DB doesn't know about is exactly what resurrects the
    // double-session catastrophe. The class flow got this guard first
    // (toolBookClass); this is the same read-back-or-expire for journeys.
    const writes = await Promise.all(effective
      .filter(b => b.booking_event_id)
      .map(async b => ({
        item: b,
        ok: await db.updateBookingEventIfStatus(
          b.booking_event_id,
          ['pending', 'pay_on_location'],
          { stripeSessionId: payment.sessionId, status: 'payment_sent' }
        ),
      }))
    );
    const unconfirmed = writes.filter(w => w.ok !== true);
    if (unconfirmed.length > 0) {
      for (const w of unconfirmed) {
        logger.error(`send_payment: session ${payment.sessionId} not confirmed on booking_event ${w.item.booking_event_id} (${w.ok === false ? 'status changed underneath' : 'DB unreachable'}) — aborting this mint`);
      }

      // ROLL BACK the writes that DID land, or the retry finds their rows
      // 'payment_sent' and silently drops legitimate charges (verify finding:
      // cas-write step 4). Reverting also detaches the rows from the aborted
      // session, so its expiry event — whenever it arrives — finds nothing it
      // owns and destroys nothing (the expired-webhook now checks ownership).
      await Promise.all(writes.filter(w => w.ok === true).map(async w => {
        const revert = await db.updateBookingEventIfStatus(
          w.item.booking_event_id,
          ['payment_sent'],
          { stripeSessionId: null, status: w.item.pay_on_location ? 'pay_on_location' : 'pending' }
        );
        if (revert !== true) {
          db.logError('billing_rollback_failed', `Could not revert booking_event ${w.item.booking_event_id} after aborted session ${payment.sessionId}. MANUAL REVIEW.`, '', JSON.stringify({ from }));
        }
      }));

      // Expire the aborted session — and CONFIRM it died. A failed expiry is
      // survivable now (rows no longer belong to it), but nobody should be
      // able to pay it, so retry once and flag if it stays open.
      let expired = await paymentService.expireSession(payment.sessionId);
      if (!expired) expired = await paymentService.expireSession(payment.sessionId);
      if (!expired) {
        db.logError('billing_zombie_session', `Aborted session ${payment.sessionId} for ${from} could not be expired — it stays payable until Stripe's own expiry. Rows were detached; a payment on it will trigger the dead-booking escalation.`, '', JSON.stringify({ from }));
      }

      // Retry via the same postponement path: the next attempt re-verifies
      // every row, so items that turn out paid/released drop away cleanly.
      return postponeBilling(from, `session ${payment.sessionId} aborted (unconfirmed writes)`, rawStored);
    }

    // Subtractive resolution (see above) + remember the link so a re-fire or a
    // late button tap re-shares it instead of minting a duplicate session.
    resolveCartItems(from, rawStored);
    conversationService.set(from, {
      billingRetries: 0,
      lastBillingLink: { url: payment.paymentUrl, sessionId: payment.sessionId, at: Date.now() },
    });
    // Start the 10-minute payment timeline (reminder, expiry notice, silent
    // removal from Mindbody at 15 min).
    schedulePaymentTimeline(from, payment.sessionId, payment.paymentUrl, effective.map(b => b.appointment_id));
    logger.info(`send_payment: ${effective.length} booking(s)${stored?.length ? ' (server-recorded)' : ''}, session ${payment.sessionId}`);
    return { success: true, paymentUrl: payment.paymentUrl };
  } catch (err) {
    logger.error('toolSendPayment error:', err.message);
    return { error: 'payment_failed', message: err.message };
  }
}

/**
 * Postpone a billing attempt that cannot safely proceed. The cart stays
 * intact; the retry counter only ever resets on a SUCCESSFUL billing (verify
 * finding: postpone path 2 — resetting it pre-mint made the manual-review arm
 * unreachable, so a persistent fault minted and killed a session every 5
 * minutes forever).
 *
 * WhatsApp: the auto-timer retries in 5 minutes, so "the link will follow" is
 * true. Web chat has no push channel — scheduleAutoPaymentLink is a no-op
 * there — so the customer must be asked to request the link again; promising
 * an automatic follow-up there was a lie the server couldn't keep (verify
 * finding: postpone path 1).
 */
function postponeBilling(from, why, cart) {
  const attempts = (conversationService.get(from)?.billingRetries || 0) + 1;
  conversationService.update(from, { billingRetries: attempts });
  const isWeb = String(from).startsWith('web_');
  if (attempts <= 3) {
    if (!isWeb) scheduleAutoPaymentLink(from);
    logger.warn(`send_payment: postponing billing for ${from} (${why}) — attempt ${attempts}/3${isWeb ? ' (web: customer-driven retry)' : ''}`);
  } else {
    db.logError('billing_postponed_repeatedly', `Billing for ${from} postponed ${attempts - 1} times (${why}). MANUAL REVIEW: bill or release manually.`, '', JSON.stringify({ from, cart }));
    logger.error(`send_payment: giving up automatic retries for ${from} — flagged for manual review`);
  }
  return {
    success: false,
    billing_deferred: true,
    message: isWeb
      ? 'The payment link cannot be prepared right now. Tell the customer their booking is reserved and ask them to request the payment link again in a minute or two.'
      : 'The payment link cannot be prepared right now. Tell the customer their booking is reserved and the payment link will follow automatically in a few minutes.',
  };
}

/**
 * Remove exactly `resolvedItems` from the conversation's cart, returning what
 * remains. Never wipes wholesale: a booking recorded while billing was
 * mid-flight is not this run's to resolve.
 */
function resolveCartItems(from, resolvedItems) {
  const keyOf = b => String(b.booking_event_id ?? `apt:${b.appointment_id}`);
  const resolved = new Set((resolvedItems || []).map(keyOf));
  const current = conversationService.get(from)?.pendingBookings || [];
  const remaining = current.filter(b => !resolved.has(keyOf(b)));
  conversationService.update(from, { pendingBookings: remaining });
  return remaining;
}

// ── Automatic payment link ────────────────────────────────────────────────────
// A pay-online booking holds a real Mindbody slot the moment it is made, but
// the Stripe link only went out if the model called send_payment. Customers who
// never tapped "Send payment link" therefore kept a confirmed slot and were
// never asked to pay. The server now bills them itself: 5 minutes after the
// last pay-online booking, anything still sitting in the cart is billed and the
// link is pushed to the customer. The window restarts on every new booking so a
// customer building a 3-treatment journey is not interrupted mid-cart.
const AUTO_BILL_DELAY_MS = 5 * 60 * 1000;
const autoBillTimers = new Map();

function cancelAutoPaymentLink(from) {
  const timer = autoBillTimers.get(from);
  if (timer) {
    clearTimeout(timer);
    autoBillTimers.delete(from);
  }
}

function scheduleAutoPaymentLink(from) {
  // Web chat has no channel to push a link to; the cron still releases the slot.
  if (String(from).startsWith('web_')) return;
  cancelAutoPaymentLink(from);

  const timer = setTimeout(async () => {
    autoBillTimers.delete(from);
    try {
      const conv = conversationService.get(from);
      const pending = conv?.pendingBookings;
      // Already billed (customer tapped the button, or the cart was cleared).
      if (!Array.isArray(pending) || pending.length === 0) return;

      const result = await billPendingBookings(from, {
        customer_email: conv?.customerEmail,
        customer_name:  conv?.customerName,
      });
      if (!result?.paymentUrl) return;

      const lang = conv?.lang || 'en';
      const msg = lang === 'nl'
        ? 'Je boeking is nog niet bevestigd — hij wordt pas definitief na betaling 💳\n\n⏳ Rond je betaling binnen 10 minuten af, anders geven we je plek weer vrij.'
        : 'Your booking isn\'t confirmed yet — it\'s only final once payment is complete 💳\n\n⏳ Please pay within 10 minutes, otherwise we release your spot.';
      await whatsappService.sendCTAButton(from, msg, lang === 'nl' ? 'Betaal Nu' : 'Pay Now', result.paymentUrl);
      db.logMessage(from, 'assistant', msg);
      logger.info(`Auto payment link sent to ${from} — customer never tapped "Send payment link"`);
    } catch (err) {
      logger.warn('Auto payment link failed:', err.message);
    }
  }, AUTO_BILL_DELAY_MS);

  timer.unref?.(); // never hold the process open for a pending nudge
  autoBillTimers.set(from, timer);
}

async function toolSendPayment(from, args = {}) {
  // The model is billing now, so the automatic fallback is no longer needed.
  cancelAutoPaymentLink(from);
  return billPendingBookings(from, args);
}

async function toolGetAppointments(from, { client_phone, client_email, client_name } = {}) {
  let clients = [];

  // Helper: try all lookup strategies in order
  async function tryLookups(primaryPhone) {
    if (primaryPhone && !primaryPhone.startsWith('web_')) {
      clients = await mindbodyService.getAllClientsByPhone(primaryPhone);
    }
    if (clients.length === 0 && client_phone) {
      clients = await mindbodyService.getAllClientsByPhone(client_phone);
    }
    // If the customer explicitly provided their email, ALWAYS search by it —
    // even if the phone lookup found someone. The phone may have matched a
    // different person (e.g. the agent's own number), so email takes priority.
    if (client_email) {
      const c = await mindbodyService.getClientByPhone(null, client_email);
      if (c) clients = [c]; // override phone result with the email match
    }
    if (clients.length === 0 && client_name) {
      const c = await mindbodyService.searchClientByName(client_name);
      if (c) clients = [c];
    }
  }

  const hasExtra = client_phone || client_email || client_name;

  // Always ask for email/name first — never rely on phone number alone.
  // Only proceed with the lookup once the customer has provided their details.
  if (!hasExtra) {
    return {
      status: 'ask_for_details',
      instruction: 'Ask the customer: "To look up your booking, could you share the email address you used when you booked?"',
    };
  }

  await tryLookups(from);

  if (clients.length === 0) {
    return {
      status: 'not_found',
      instruction: 'No account found. Tell the customer you cannot find their booking and direct them to welcome@renessence.com.',
    };
  }

  // Look back 7 days so yesterday's / recent appointments are visible too
  const lookbackDate = formatDateISO(addDays(new Date(), -7));
  const futureDate = formatDateISO(addDays(new Date(), 90));

  let all = [];
  for (const client of clients) {
    const appts = await mindbodyService.getStaffAppointments(lookbackDate, futureDate, client.Id);
    all = all.concat(appts);
  }
  all.sort((a, b) => new Date(a.StartDateTime) - new Date(b.StartDateTime));

  const appointments = await Promise.all(all.slice(0, 10).map(async apt => {
    // Look up payment status from DB.
    // If no record exists the booking was made externally (Mindbody website / front desk)
    // — assume paid so we don't incorrectly tell the customer they haven't paid.
    let isPaid = false;
    try {
      const row = await db.query(
        `SELECT status FROM booking_events WHERE mindbody_appointment_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [String(apt.Id)]
      );
      if (!row.rows?.length) {
        // External booking — treat as paid
        isPaid = true;
      } else {
        isPaid = row.rows[0].status === 'paid';
      }
    } catch (_) {
      // On DB error, default to paid to avoid false "not paid" messages
      isPaid = true;
    }

    const apptTime = new Date(apt.StartDateTime);
    return {
      id: apt.Id,
      serviceName: apt.SessionType?.Name || 'Treatment',
      dateLabel: formatDutchDate(apt.StartDateTime),
      timeLabel: formatDutchTime(apt.StartDateTime),
      dateTime: apt.StartDateTime,
      isPast: apptTime < new Date(),
      isWithin24h: (apptTime - new Date()) < 24 * 60 * 60 * 1000,
      isPaid,
    };
  }));

  return { appointments };
}

async function toolCancelAppointments(from, { appointment_ids, is_reschedule, is_within_24h, service_name, date_time }) {
  // HARD GATE — never cancel without an explicit "Yes, cancel it" tap.
  // The prompt already demanded a confirmation, but nothing enforced it: a
  // customer asking "did anyone cancel? is a later time possible?" (purely an
  // availability question) had her real booking destroyed 7 seconds later.
  // Cancelling is the most destructive thing this bot can do, so it gets the
  // same code-level gate as booking.
  const cancelConf = conversationService.get(from)?.cancelConfirmedAt;
  const cancelConfirmedRecently = cancelConf && (Date.now() - cancelConf) < 10 * 60 * 1000;
  if (!cancelConfirmedRecently) {
    return {
      error: 'confirmation_required',
      message: 'You do NOT have the customer\'s explicit cancellation confirmation, so nothing was cancelled. If — and only if — they actually want to cancel, first show the confirmation with buttons [{"id":"confirm_cancel","title":"Yes, cancel it"},{"id":"keep_appointment","title":"No, keep it"}], naming the exact treatment, date and time (and the 100% charge if within 24h). Only call cancel_appointments after they tap "Yes, cancel it". IMPORTANT: a question about availability, a later time, or whether someone else cancelled is NOT a cancellation request — answer it without cancelling anything.',
    };
  }
  // Consume the confirmation so it covers exactly one cancellation.
  conversationService.update(from, { cancelConfirmedAt: null });

  const cancelled = [];
  const failed = [];
  const conv = conversationService.get(from);
  const customerName = conv?.userName || null;

  for (const id of appointment_ids) {
    try {
      // Look up booking details from DB before cancelling (needed for refund email)
      let bookingRow = null;
      try {
        const res = await db.query(
          `SELECT customer_name, service_name, amount_cents, appointment_date AS start_date_time FROM booking_events WHERE mindbody_appointment_id = $1 AND status = 'paid' ORDER BY created_at DESC LIMIT 1`,
          [String(id)]
        );
        bookingRow = res.rows?.[0] || null;
      } catch (_) {}

      await mindbodyService.cancelAppointment(id);
      // H14: push to cancelled immediately after Mindbody succeeds — side-effect failures below
      // must NOT affect the cancelled/failed reporting
      cancelled.push(id);

      // Side-effects run in their own try/catch so they never flip this ID to failed[]
      try {
        // Cancel any open Stripe session so expiry webhook doesn't fire
        paymentService.cancelPendingPaymentByAppointment(id).catch(err =>
          logger.warn('Stripe session cancel error:', err.message)
        );

        db.query(
          `UPDATE booking_events SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = 'customer' WHERE mindbody_appointment_id = $1`,
          [id]
        ).catch(err => logger.error('DB cancel log:', err.message));

        // Drop the cancelled appointment from the in-progress cart so a later
        // send_payment can't charge for a treatment that was just cancelled
        // (e.g. book → cancel → book something else in the same chat).
        const cartConv = conversationService.get(from);
        if (cartConv?.pendingBookings?.length) {
          conversationService.update(from, {
            pendingBookings: cartConv.pendingBookings.filter(b => String(b.appointment_id) !== String(id)),
          });
        }

        // Always notify the welcome team of any cancellation (external or bot-booked)
        emailService.sendCancellationNotificationEmail({
          customerName: bookingRow?.customer_name || customerName,
          customerPhone: from,
          serviceName: bookingRow?.service_name || service_name,
          dateTime: bookingRow?.start_date_time || date_time,
          isWithin24h: !!is_within_24h,
          isReschedule: !!is_reschedule,
        }).catch(err => logger.error('Cancellation notification email error:', err.message));

        // If paid, not a reschedule, and outside 24h → notify finance team for refund
        // Within 24h: no refund per policy (full amount charged)
        if (bookingRow && !is_reschedule && !is_within_24h) {
          const lang = conversationService.get(from)?.lang || 'en';
          await whatsappService.sendText(
            from,
            lang === 'nl'
              ? 'Bedankt voor je geduld! Ons team verwerkt je terugbetaling binnen 7 werkdagen. Je ziet het bedrag binnenkort terug op je oorspronkelijke betaalmethode.'
              : 'Thanks for your patience! Our team will take care of your refund within 7 business days, you\'ll see it back on your original payment method shortly after.'
          );
          emailService.sendRefundNotificationEmail({
            customerName: bookingRow.customer_name,
            customerPhone: from,
            serviceName: bookingRow.service_name,
            dateTime: bookingRow.start_date_time,
            amountCents: bookingRow.amount_cents,
          }).catch(err => logger.error('Refund email error:', err.message));
        }
      } catch (sideErr) {
        logger.error(`Cancel ${id} side-effect error (appointment was cancelled):`, sideErr.message);
      }
    } catch (err) {
      logger.error(`Cancel ${id} error:`, err.message);
      failed.push(id);
    }
  }

  // Any cancellation that didn't actually take effect leaves a billable slot on
  // the Mindbody calendar (the therapist still gets paid). The bot must NOT tell
  // the customer it's cancelled — instead ask the team to cancel it by hand.
  if (failed.length > 0) {
    logger.warn(`Cancellation FAILED for appointment(s) ${failed.join(', ')} — escalating to team for manual cancellation`);
    db.markConversationEscalated(from);
    emailService.sendEscalationEmail({
      customerName,
      customerPhone: from,
      customerEmail: null,
      message: `⚠️ AUTOMATIC CANCELLATION FAILED — please cancel this in Mindbody by hand so the slot is freed. Appointment ID(s): ${failed.join(', ')}. Treatment: ${service_name || 'unknown'} on ${date_time || 'unknown'}. The bot did NOT tell the customer it was cancelled; it said the team would take care of it.`,
    }).catch(err => logger.error('Failed-cancel escalation email error:', err.message));
  }

  return { cancelled, failed };
}

async function toolCheckClassSchedule(from, { session_type_ids, start_date, end_date }) {
  try {
    const classes = await mindbodyService.getClasses(session_type_ids, start_date, end_date);
    const now = new Date();

    const result = classes
      .filter(c => {
        if (c.IsCanceled) return false;
        if (new Date(c.StartDateTime) <= now) return false;
        const maxCap = c.MaxCapacity || 0;
        const booked = c.TotalBooked || 0;
        if (maxCap > 0 && booked >= maxCap) return false;
        return true;
      })
      .slice(0, 10)
      .map(c => ({
        id: `class_${c.Id}`,
        classId: c.Id,
        name: c.ClassDescription?.Name || 'Studio Class',
        dateLabel: formatDutchDate(c.StartDateTime),
        timeLabel: formatDutchTime(c.StartDateTime),
        dateTime: c.StartDateTime,
        sessionTypeId: c.ClassDescription?.SessionType?.Id || session_type_ids[0],
        spotsLeft: c.MaxCapacity ? c.MaxCapacity - (c.TotalBooked || 0) : null,
      }));

    return { classes: result };
  } catch (err) {
    logger.warn('check_class_schedule error:', err.message);
    return { classes: [], error: err.message };
  }
}

async function toolBookClass(from, { class_id, session_type_id, class_name, class_date_time, client_name, client_email }) {
  // 1. Find or create client
  let client = await mindbodyService.getClientByPhone(from, client_email || null);
  if (!client) {
    if (!client_name || !client_email) {
      return { error: 'client_info_required', message: 'Need full name and email to create account.' };
    }
    const parts = client_name.trim().split(' ');
    const firstName = parts[0];
    const lastName = parts.slice(1).join(' ') || 'WhatsApp';
    try {
      client = await mindbodyService.addClient({ firstName, lastName, email: client_email, mobilePhone: from, city: 'Amsterdam' });
    } catch (addErr) {
      if (addErr.response?.data?.Error?.Code === 'InvalidClientCreation') {
        client = await mindbodyService.getClientByPhone(from, client_email);
        if (!client) throw addErr;
      } else throw addErr;
    }
  }

  // 2. Enrol in class
  const visit = await mindbodyService.addClientToClass(client.Id, class_id);

  const dateLabel = formatDutchDate(class_date_time);
  const timeLabel = formatDutchTime(class_date_time);
  const lang = conversationService.get(from)?.lang || 'en';
  const atWord = lang === 'nl' ? 'om' : 'at';
  const dateTimeLabel = `${dateLabel} ${atWord} ${timeLabel}`;

  // 3. Log to DB
  const priceCents = paymentService.getPriceInCents(session_type_id);
  const bookingEventId = await db.logBookingEvent({
    phone: from,
    customerName: client_name || `${client.FirstName} ${client.LastName}`.trim(),
    sessionTypeId: session_type_id,
    serviceName: class_name,
    status: 'pending',
    amountCents: priceCents,
    appointmentDate: class_date_time,
    mindbodyAppointmentId: class_id,
  });

  // 4. Payment link.
  //
  // The expiry cron treats "status 'pending' with no stripe_session_id" as
  // PROOF a booking was never billed, and releases it without consulting
  // Stripe. That proof holds only if minting a link and persisting its session
  // id are inseparable. So: no audit row → no link at all; and if the session
  // id cannot be CONFIRMED as persisted, the freshly minted session is expired
  // on the spot — a link the DB doesn't know about must never reach a customer,
  // because a payment on it would land on a row the cron considers never-billed
  // (audit finding #6). In both failure modes the class enrolment stands and
  // the model tells the customer the team will arrange payment.
  if (priceCents) {
    if (!bookingEventId) {
      logger.error(`toolBookClass: no audit row for class ${class_id} — refusing to mint an untracked payment link`);
      return { success: true, classId: class_id, className: class_name, dateLabel, timeLabel, requiresPayment: false, paymentError: true };
    }
    try {
      const payment = await paymentService.createPaymentLink({
        appointmentId: class_id,
        clientId: client.Id,
        from,
        serviceName: class_name,
        dateTime: dateTimeLabel,
        amount: priceCents,
        customerEmail: client.Email || client_email,
        customerName: client_name || `${client.FirstName} ${client.LastName}`.trim(),
        bookingEventId,
        isClass: true,
      });
      await db.updateBookingEvent(bookingEventId, { stripeSessionId: payment.sessionId, status: 'payment_sent' });
      // updateBookingEvent swallows DB errors, so read back to be sure. One
      // retry: a transient read error right after a SUCCESSFUL write would
      // otherwise expire a perfectly tracked session (and the expired-webhook
      // would then cancel the class the customer was told is booked).
      let persisted = await db.getBookingEventById(bookingEventId);
      if (!persisted) persisted = await db.getBookingEventById(bookingEventId);
      if (persisted?.stripe_session_id !== payment.sessionId) {
        logger.error(`toolBookClass: could not persist session ${payment.sessionId} on booking_event ${bookingEventId} — expiring it rather than circulating an untracked link`);
        await paymentService.expireSession(payment.sessionId);
        return { success: true, classId: class_id, className: class_name, dateLabel, timeLabel, requiresPayment: false, paymentError: true };
      }
      return { success: true, classId: class_id, className: class_name, dateLabel, timeLabel, dateTimeLabel, requiresPayment: true, paymentUrl: payment.paymentUrl };
    } catch (payErr) {
      logger.error('Class payment link error:', payErr.message);
      return { success: true, classId: class_id, className: class_name, dateLabel, timeLabel, requiresPayment: false, paymentError: true };
    }
  }

  return { success: true, classId: class_id, className: class_name, dateLabel, timeLabel, requiresPayment: false };
}

// How long after notifying the team we suppress a repeat notification for the
// same customer. The team was getting ~12 identical "Customer needs help"
// emails for one person in a morning; once they're notified they're on it, and
// pausing the bot stops the flow entirely anyway.
const TEAM_NOTIFY_COOLDOWN_MIN = parseInt(process.env.TEAM_NOTIFY_COOLDOWN_MIN || '60', 10);

async function toolHumanHandoff(from, name, { reason, customer_email }) {
  if (!customer_email) {
    return { sent: false, error: 'email_required', message: 'Ask the customer for their email address before escalating.' };
  }
  const conv = conversationService.get(from);
  const customerName = conv?.userName || name || 'Unknown';

  // Always flag the conversation (idempotent) so the dashboard shows it.
  db.markConversationEscalated(from);

  // Already told the team about this customer recently? Don't email again.
  const alreadyNotified = await db.hasRecentTeamNotification(from, 'human_handoff', TEAM_NOTIFY_COOLDOWN_MIN);
  if (alreadyNotified) {
    logger.info(`Escalation email suppressed — team already notified within ${TEAM_NOTIFY_COOLDOWN_MIN}m: ${from}`);
    return {
      sent: true,
      already_escalated: true,
      message: 'The team has already been notified about this customer and is looking into it. Do NOT escalate again — simply reassure the customer that the team will come back to them, and answer anything else you can.',
    };
  }

  db.logEscalation(from, customerName, 'human_handoff', reason);
  emailService.sendEscalationEmail({ customerName, customerPhone: from, customerEmail: customer_email, message: reason })
    .catch(err => logger.error('Escalation email error:', err.message));
  return { sent: true };
}

// Reschedules are arranged by the team, not the bot (cancel+rebook here caused
// paid-but-cancelled edge cases). The bot states the policy, collects the new
// date + treatment + email, and forwards it to welcome@.
async function toolForwardReschedule(from, name, { new_date, treatment, customer_email, customer_name, current_appointment }) {
  if (!new_date || !treatment) {
    return {
      sent: false,
      error: 'missing_details',
      message: 'Before forwarding, ask for whatever is still missing: the new date they want and the treatment (appointment type).',
    };
  }
  if (!customer_email) {
    return {
      sent: false,
      error: 'email_required',
      message: 'Ask the customer for their email before forwarding — the team needs it to confirm the new time with them.',
    };
  }
  const conv = conversationService.get(from);
  const customerName = customer_name || conv?.userName || name || 'Unknown';
  const detail = `New: ${new_date} | ${treatment}${current_appointment ? ` | current: ${current_appointment}` : ''}`;

  // Suppress only an IDENTICAL repeat — if the customer corrects the date or
  // treatment, the team still gets the updated request.
  if (await db.hasRecentTeamNotification(from, 'reschedule_request', TEAM_NOTIFY_COOLDOWN_MIN, detail)) {
    logger.info(`Reschedule email suppressed — identical request already sent: ${from}`);
    return { sent: true, already_sent: true, message: 'This exact reschedule request was already sent to the team. Do NOT send it again — just reassure the customer the team will confirm the new time.' };
  }

  db.logEscalation(from, customerName, 'reschedule_request', detail);
  emailService.sendRescheduleRequestEmail({
    customerName,
    customerPhone: from,
    customerEmail: customer_email,
    newDate: new_date,
    treatment,
    currentAppointment: current_appointment,
  }).catch(err => logger.error('Reschedule email error:', err.message));
  return { sent: true };
}

// Detect an OLD (pre-migration) gift-card number. Read-only, no side effects.
// The model calls this the moment a customer gives a gift-card number, so it can
// warn them it won't work online and route them to the team instead.
function toolCheckGiftCard({ gift_card_number }) {
  const isOld = giftCardCheck.isOldGiftCard(gift_card_number);
  return {
    is_old_system: isOld,
    message: isOld
      ? 'This gift card is from the OLD system and will error if used for online payment. Explain that to the customer, then collect their email, appointment date and appointment type and call forward_gift_card_request with old_system: true. Do NOT ask them to pay online.'
      : 'Not an old-system card. Continue the normal gift-card flow (collect treatment + day, then forward_gift_card_request).',
  };
}

// Gift-card bookings are handled by the team, not the bot — redeeming a gift
// card requires Mindbody's point of sale, which we can't drive here. So the bot
// just collects the details and emails welcome@ to arrange it. old_system flags
// a pre-migration card that needs a manual transfer by the team.
async function toolForwardGiftCard(from, name, { gift_card_number, treatment, preferred_day, customer_name, customer_email, old_system }) {
  if (!gift_card_number || !treatment || !preferred_day) {
    return {
      sent: false,
      error: 'missing_details',
      message: old_system
        ? 'Before forwarding this old-system card, ask for whatever is still missing: the gift card number, their email, the appointment date, and the appointment type.'
        : 'Before forwarding, ask the customer for whatever is still missing: the gift card number, the treatment they want, and the day (with a time preference if they have one).',
    };
  }
  if (old_system && !customer_email) {
    return {
      sent: false,
      error: 'email_required',
      message: 'For an old-system gift card the team needs to reach the customer — ask for their email before forwarding.',
    };
  }
  const conv = conversationService.get(from);
  const customerName = customer_name || conv?.userName || name || 'Unknown';
  const kind = old_system ? 'gift_card_old_system' : 'gift_card_request';
  const detail = `Gift card ${gift_card_number} | ${treatment} | ${preferred_day}`;

  // Suppress only an IDENTICAL repeat — a changed card number, treatment or day
  // is a genuinely new request and still goes through.
  if (await db.hasRecentTeamNotification(from, kind, TEAM_NOTIFY_COOLDOWN_MIN, detail)) {
    logger.info(`Gift card email suppressed — identical request already sent: ${from}`);
    return { sent: true, already_sent: true, message: 'This exact gift-card request was already sent to the team. Do NOT send it again — just reassure the customer the team will be in touch.' };
  }

  db.logEscalation(from, customerName, kind, detail);
  emailService.sendGiftCardRequestEmail({
    customerName,
    customerPhone: from,
    customerEmail: customer_email,
    giftCardNumber: gift_card_number,
    treatment,
    preferredDay: preferred_day,
    oldSystem: !!old_system,
  }).catch(err => logger.error('Gift card email error:', err.message));
  return { sent: true };
}

// ---- Respond tool ----

// Web chat callback map: webFrom -> resolve fn
const webCallbacks = new Map();

async function executeRespond(from, args) {
  const { message, ui_type, buttons, list_sections, list_button_label, cta_label, cta_url, detected_language } = args;

  if (detected_language) {
    conversationService.update(from, { lang: detected_language });
  }

  // Web chat mode — resolve callback instead of sending via WhatsApp
  if (from.startsWith('web_') && webCallbacks.has(from)) {
    const resolve = webCallbacks.get(from);
    webCallbacks.delete(from);
    conversationService.addMessage(from, 'assistant', message);
    db.logMessage(from, 'assistant', message);
    resolve({ message, ui_type: ui_type || 'text', buttons, list_sections, list_button_label, cta_label, cta_url });
    return;
  }

  try {
    switch (ui_type) {
      case 'buttons': {
        const validButtons = (buttons || []).filter(b => b.id && b.title).map(b => ({
          id: b.id,
          title: String(b.title).substring(0, 20),
        }));
        if (validButtons.length === 0) {
          await whatsappService.sendText(from, message);
        } else {
          await whatsappService.sendButtons(from, message, validButtons);
        }
        break;
      }
      case 'list': {
        const validSections = (list_sections || [])
          .map(s => ({
            title: String(s.title || 'Options').substring(0, 24),
            rows: (s.rows || []).filter(r => r.id && r.title).map(r => ({
              id: r.id,
              title: String(r.title).substring(0, 24),
              description: String(r.description || '').substring(0, 72),
            })),
          }))
          .filter(s => s.rows.length > 0);

        if (validSections.length === 0) {
          // AI forgot list_sections — send plain text
          logger.warn('respond list called with no valid sections, sending text');
          await whatsappService.sendText(from, message);
        } else {
          try {
            await whatsappService.sendList(from, message, (list_button_label || 'View').substring(0, 20), validSections);
          } catch (listErr) {
            // List failed — build readable text fallback that includes the options
            logger.error('sendList failed, using text fallback:', listErr.response?.data || listErr.message);
            const allRows = validSections.flatMap(s => s.rows);
            const optionLines = allRows.map(r => `• ${r.title}${r.description ? ` — ${r.description}` : ''}`).join('\n');
            const lang = conversationService.get(from)?.lang || 'en';
            const replyHint = lang === 'nl' ? 'Typ de gewenste tijd:' : 'Type the time you want:';
            await whatsappService.sendText(from, `${message}\n\n${optionLines}\n\n${replyHint}`).catch(() => {});
          }
        }
        break;
      }
      case 'cta_button':
        await whatsappService.sendCTAButton(from, message, (cta_label || 'Open').substring(0, 20), cta_url);
        break;
      default:
        await whatsappService.sendText(from, message);
    }
  } catch (sendErr) {
    logger.error('executeRespond fatal error:', sendErr.message);
    await whatsappService.sendText(from, message).catch(() => {});
  }

  conversationService.addMessage(from, 'assistant', message);
  db.logMessage(from, 'assistant', message);
}

module.exports = {
  toolCheckAvailability,
  toolLookupClient,
  toolBookAppointment,
  toolSendPayment,
  billPendingBookings,
  scheduleAutoPaymentLink,
  cancelAutoPaymentLink,
  toolGetAppointments,
  toolCancelAppointments,
  toolCheckClassSchedule,
  toolBookClass,
  toolHumanHandoff,
  toolForwardGiftCard,
  toolCheckGiftCard,
  toolForwardReschedule,
  executeRespond,
  webCallbacks,
};
