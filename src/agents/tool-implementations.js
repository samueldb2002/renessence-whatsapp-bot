/**
 * Tool implementations for the Renessence AI Agent.
 */

const conversationService = require('../services/conversation.service');
const mindbodyService = require('../services/mindbody.service');
const paymentService = require('../services/payment.service');
const whatsappService = require('../services/whatsapp.service');
const emailService = require('../services/email.service');
const db = require('../data/database');
const logger = require('../utils/logger');
const { formatDutchDate, formatDutchTime, formatDateISO, addDays } = require('../utils/date');
const { SERVICE_SLOT_TIMES, SERVICE_DURATIONS } = require('../config/slot-times');
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
};

async function toolCheckAvailability(from, { session_type_ids, start_date, end_date }) {
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

      if (isNarrowWindow) {
        // Only the exact windowStart is a valid slot for this pre-scheduled appointment
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

  if (unique.length === 0) {
    return {
      slots: [],
      staff: [],
      no_availability: true,
      message: 'No availability found for the requested date(s). Respond to the customer with a friendly message and suggest they try a different date.',
    };
  }

  return { slots: unique.slice(0, 10), staff };
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

  // 2. Book appointment — extract Mindbody error message on failure
  // Always tag bookings made via the WhatsApp bot so staff can identify them in Mindbody
  const botTag = '📱 WhatsApp Bot';
  const finalNotes = notes ? `${botTag} | ${notes}` : botTag;

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
        return { error: 'booking_failed', mindbody_message: retryMsg };
      }
    } else {
      logger.error('toolBookAppointment Mindbody error:', mbMsg);
      db.logError('booking_failed', mbMsg, mbCode, JSON.stringify({
        phone: from, session_type_id, start_date_time, staff_id,
      }));
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
  const bookingEventId = await db.logBookingEvent({
    phone: from,
    customerName: client_name || `${client.FirstName} ${client.LastName}`.trim(),
    sessionTypeId: session_type_id,
    serviceName,
    status: 'confirmed',
    amountCents: paymentService.getPriceInCents(session_type_id),
  });
  if (bookingEventId) {
    await db.updateBookingEvent(bookingEventId, {
      appointmentDate: start_date_time,
      mindbodyAppointmentId: appointment.Id,
    });
  }

  // 4. Payment
  const priceCents = paymentService.getPriceInCents(session_type_id);

  // skip_payment: reschedule of same paid treatment — no payment needed at all
  if (skip_payment || !priceCents) {
    return { success: true, appointmentId: appointment.Id, serviceName, dateLabel, timeLabel, dateTimeLabel, requiresPayment: false };
  }

  // Always defer payment — the ONLY way to send a payment link is via send_payment tool.
  // This ensures the bot always shows the "Add another treatment / Send payment link" buttons.
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

async function toolSendPayment(from, { bookings, customer_email, customer_name }) {
  if (!bookings || bookings.length === 0) {
    return { error: 'no_bookings', message: 'No bookings provided.' };
  }
  try {
    const payment = await paymentService.createCombinedPaymentLink({
      items: bookings.map(b => ({
        bookingEventId: b.booking_event_id,
        appointmentId:  b.appointment_id,
        serviceName:    b.service_name,
        dateTimeLabel:  b.date_time_label,
        amountCents:    b.amount_cents,
      })),
      customerEmail: customer_email,
      customerName:  customer_name,
      from,
    });
    // Update all booking_events with the Stripe session ID (H10: awaited)
    await Promise.all(bookings
      .filter(b => b.booking_event_id)
      .map(b => db.updateBookingEvent(b.booking_event_id, { stripeSessionId: payment.sessionId, status: 'payment_sent' })
        .catch(err => logger.error(`Failed to update booking_event ${b.booking_event_id} with stripe session:`, err.message))
      )
    );
    logger.info(`send_payment: ${bookings.length} booking(s), session ${payment.sessionId}`);
    return { success: true, paymentUrl: payment.paymentUrl };
  } catch (err) {
    logger.error('toolSendPayment error:', err.message);
    return { error: 'payment_failed', message: err.message };
  }
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
          `SELECT customer_name, service_name, amount_cents, start_date_time FROM booking_events WHERE mindbody_appointment_id = $1 AND status = 'paid' ORDER BY created_at DESC LIMIT 1`,
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
    status: 'confirmed',
    amountCents: priceCents,
  });
  if (bookingEventId) {
    await db.updateBookingEvent(bookingEventId, {
      appointmentDate: class_date_time,
      mindbodyAppointmentId: class_id,
    });
  }

  // 4. Payment link
  if (priceCents) {
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
      });
      if (bookingEventId) {
        db.updateBookingEvent(bookingEventId, { stripeSessionId: payment.sessionId, status: 'payment_sent' });
      }
      return { success: true, classId: class_id, className: class_name, dateLabel, timeLabel, dateTimeLabel, requiresPayment: true, paymentUrl: payment.paymentUrl };
    } catch (payErr) {
      logger.error('Class payment link error:', payErr.message);
      return { success: true, classId: class_id, className: class_name, dateLabel, timeLabel, requiresPayment: false, paymentError: true };
    }
  }

  return { success: true, classId: class_id, className: class_name, dateLabel, timeLabel, requiresPayment: false };
}

async function toolHumanHandoff(from, name, { reason, customer_email }) {
  if (!customer_email) {
    return { sent: false, error: 'email_required', message: 'Ask the customer for their email address before escalating.' };
  }
  const conv = conversationService.get(from);
  const customerName = conv?.userName || name || 'Unknown';
  db.logEscalation(from, customerName, 'human_handoff', reason);
  db.markConversationEscalated(from);
  emailService.sendEscalationEmail({ customerName, customerPhone: from, customerEmail: customer_email, message: reason })
    .catch(err => logger.error('Escalation email error:', err.message));
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
  toolGetAppointments,
  toolCancelAppointments,
  toolCheckClassSchedule,
  toolBookClass,
  toolHumanHandoff,
  executeRespond,
  webCallbacks,
};
