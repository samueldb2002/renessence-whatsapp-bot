/**
 * Pay-first bookings — massages, the facial, Nervous System Reset, Let It Go.
 *
 * The guest pays BEFORE anything is booked in Mindbody:
 *   book_appointment → booking_events row 'awaiting_payment' (+ booking details
 *   in pay_first) → Stripe Checkout link (31 min)
 *   Stripe paid → webhook claims the row ('booking') → Mindbody booking →
 *   'paid' (+ appointment id, confirmation to the guest) or 'paid_unbooked'
 *   (team rebooks or refunds; guest told honestly, never asked to pay again).
 *
 * Rules this module keeps:
 * - No money outcome without a flag: every path where money is taken and no
 *   appointment results writes db.logError, sets "Needs reply" and emails the
 *   team.
 * - The DB row is the truth: the webhook routes on the row, links are
 *   re-shared from Stripe by the row's own session id.
 * - Expire confirmed first, mark second: a link is only marked expired (and the
 *   guest only told so) after Stripe says the session IS expired.
 * - A Mindbody booking with an unclear outcome is settled by reading Mindbody,
 *   never by booking again.
 */
const db = require('../data/database');
const paymentService = require('./payment.service');
const mindbodyService = require('./mindbody.service');
const whatsappService = require('./whatsapp.service');
const emailService = require('./email.service');
const conversationService = require('./conversation.service');
const logger = require('../utils/logger');
const cfg = require('../config/pay-first');

const BOT_TAG = '📱 WhatsApp Bot';
const FEEDBACK_URL = 'https://renessence.com/help-us-improve';
const FINALIZE_DEADLINE_MS = 150 * 1000;  // below the cron's 4-minute re-drive
const STUCK_BOOKING_MS = 4 * 60 * 1000;
const MAX_FINALIZE_ATTEMPTS = 3;

// ── small helpers ────────────────────────────────────────────────────────────

const naiveMs = (dt) => new Date(String(dt)).getTime(); // naive local (Europe/Amsterdam) datetimes
const key16 = (dt) => String(dt || '').slice(0, 16);
const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;
const eur = (cents) => (Number(cents) / 100).toFixed(Number(cents) % 100 === 0 ? 0 : 2);

/** "Friday 16 October at 14:00" / "vrijdag 16 oktober om 14:00" from a naive datetime. */
function whenLabel(startDateTime, lang = 'en') {
  const s = String(startDateTime);
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  const time = s.slice(11, 16);
  const date = new Date(Date.UTC(y, (m || 1) - 1, d || 1, 12));
  const locale = lang === 'nl' ? 'nl-NL' : 'en-GB';
  const dayText = date.toLocaleDateString(locale, { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
  return `${dayText} ${lang === 'nl' ? 'om' : 'at'} ${time}`;
}

function langOf(row, fallbackFrom) {
  return row?.pay_first?.lang || conversationService.get(fallbackFrom || row?.phone)?.lang || 'en';
}

/**
 * Send a server-side message to the guest AND make it part of what the model
 * sees (in-memory history) and what the team sees (DB log). Without the
 * history entry the model answered "is it booked?" from its own stale
 * "please pay" message.
 */
async function sendGuestMessage(from, text, { ctaLabel = null, ctaUrl = null } = {}) {
  if (!from || String(from).startsWith('web_')) return false;
  let sent = false;
  try {
    if (ctaUrl) await whatsappService.sendCTAButton(from, text, String(ctaLabel || 'Open').slice(0, 20), ctaUrl);
    else await whatsappService.sendText(from, text);
    sent = true;
  } catch (err) {
    logger.warn('Pay-first guest message failed, retrying as plain text:', err.message);
    try {
      await whatsappService.sendText(from, ctaUrl ? `${text}\n\n${ctaUrl}` : text);
      sent = true;
    } catch (err2) {
      logger.error('Pay-first guest message could not be sent:', err2.message);
    }
  }
  if (sent) {
    db.logMessage(from, 'assistant', ctaUrl ? `${text}\n${ctaUrl}` : text);
    conversationService.addMessage(from, 'assistant', text);
  }
  return sent;
}

// ── guest texts ──────────────────────────────────────────────────────────────

const T = {
  link: (lang, p) => lang === 'nl'
    ? `${p.replaced ? `Je eerdere betaallink voor ${p.replaced} werkt niet meer — deze vervangt hem.\n\n` : ''}Om *${p.service}* op ${p.when}${p.therapist ? ` bij ${p.therapist}` : ''} te boeken, betaal je €${p.amount} via de link hieronder. Je afspraak wordt geboekt zodra de betaling rond is, en je krijgt hier binnen een minuut een bevestiging.\n\n⏳ De link is geldig tot ${p.until} — tot je betaald hebt, is deze tijd nog niet voor je vastgezet.`
    : `${p.replaced ? `Your earlier payment link for ${p.replaced} no longer works — this one replaces it.\n\n` : ''}To book *${p.service}* on ${p.when}${p.therapist ? ` with ${p.therapist}` : ''}, please pay €${p.amount} via the link below. Your appointment is booked as soon as the payment is complete, and you'll get a confirmation here within a minute.\n\n⏳ The link is valid until ${p.until} — until you've paid, this time isn't reserved for you yet.`,
  linkCta: (lang) => (lang === 'nl' ? 'Betaal & boek' : 'Pay & book'),
  reminder: (lang, p) => lang === 'nl'
    ? `⏳ Herinnering: je *${p.service}* op ${p.when} is nog niet geboekt — de tijd staat pas voor je vast zodra de betaling rond is. Hier is je link 👇`
    : `⏳ Reminder: your *${p.service}* on ${p.when} isn't booked yet — the time is only reserved for you once the payment is complete. Here's your link 👇`,
  booked: (lang, p) => lang === 'nl'
    ? `Betaling ontvangen ✅\n\nJe *${p.service}* op ${p.when}${p.therapist ? ` bij ${p.therapist}` : ''} is geboekt. Tot ziens bij Renessence! 🙏\n\nKan ik je nog ergens anders mee helpen?`
    : `Payment received ✅\n\nYour *${p.service}* on ${p.when}${p.therapist ? ` with ${p.therapist}` : ''} is booked. See you at Renessence! 🙏\n\nIs there anything else I can help you with?`,
  paidUnbooked: (lang, p) => lang === 'nl'
    ? `Betaling ontvangen ✅ — maar het is ons niet gelukt om ${p.when} automatisch voor je te boeken. Je hoeft niets opnieuw te betalen: ons team neemt zo snel mogelijk contact met je op om een nieuwe tijd te vinden of je het volledige bedrag terug te betalen. 🙏`
    : `Payment received ✅ — but we couldn't complete the booking for ${p.when} automatically. No need to pay again: our team will contact you as soon as possible to find a new time or refund you in full. 🙏`,
  expired: (lang, p) => lang === 'nl'
    ? `De betaallink voor *${p.service}* op ${p.when} is verlopen, dus er is niets geboekt. Wil je een andere tijd? Stuur me gewoon een bericht.\n\nWe horen graag hoe het boeken met onze assistent ging 🌿 Als dank voor je feedback krijg je een GRATIS Red Light Therapy of Hydrowave massage 💚`
    : `The payment link for *${p.service}* on ${p.when} has expired, so nothing was booked. Would you like another time? Just send me a message.\n\nWe'd love to hear how booking with our assistant went 🌿 As a thank-you for your feedback you'll get a FREE Red Light Therapy or Hydrowave massage 💚`,
  feedbackCta: (lang) => (lang === 'nl' ? 'Geef feedback' : 'Give feedback'),
};

function textParams(row, lang) {
  const pf = row.pay_first || {};
  return {
    service: row.service_name || pf.serviceName || 'your treatment',
    when: whenLabel(pf.startDateTime, lang),
    therapist: pf.bookedStaffName || pf.staffName || null,
    amount: eur(row.amount_cents ?? pf.amountCents ?? 0),
  };
}

// ── room / therapist availability for pay-first slots ───────────────────────

// Process-wide, short-lived "this room was just refused at this time" list,
// shared by all guests (the old per-conversation list let one bad 15:35 fail
// for five guests in a row). Advisory only.
const roomBlocks = []; // { rooms:[ids], start, end, until }
const BLOCK_TTL_MS = 20 * 60 * 1000;

function blockRooms(rooms, startDateTime, sessionTypeId) {
  const start = naiveMs(startDateTime);
  if (!Number.isFinite(start) || !rooms?.length) return;
  roomBlocks.push({ rooms: rooms.map(Number), start, end: start + cfg.roomBlockMinutes(sessionTypeId) * 60000, until: Date.now() + BLOCK_TTL_MS });
}

function activeRoomBlocks() {
  const now = Date.now();
  for (let i = roomBlocks.length - 1; i >= 0; i--) if (roomBlocks[i].until < now) roomBlocks.splice(i, 1);
  return roomBlocks;
}

function holdInterval(h) {
  const pf = h.pay_first || {};
  const start = naiveMs(pf.startDateTime);
  return { start, end: start + cfg.roomBlockMinutes(h.session_type_id || pf.sessionTypeId) * 60000 };
}

/**
 * Which room could this pay-first slot use right now? Considers Mindbody's room
 * occupancy (when known), other guests' open checkouts (soft hold on their
 * therapist and room) and the shared refusal list.
 * @returns {{ok:boolean, roomId:number|null, verified:boolean, reason?:string}}
 */
function pickRoom({ sessionTypeId, startDateTime, staffId, occupancy, holds }) {
  const rooms = (mindbodyService.RESOURCE_MAP?.[Number(sessionTypeId)] || []).map(Number);
  const start = naiveMs(startDateTime);
  const end = start + cfg.roomBlockMinutes(sessionTypeId) * 60000;
  for (const h of holds || []) {
    const iv = holdInterval(h);
    if (!overlaps(start, end, iv.start, iv.end)) continue;
    if (staffId && Number(h.pay_first?.staffId) === Number(staffId)) return { ok: false, roomId: null, verified: false, reason: 'therapist_on_hold' };
  }
  if (rooms.length === 0) return { ok: true, roomId: null, verified: false };
  const heldRooms = new Set();
  for (const h of holds || []) {
    const iv = holdInterval(h);
    if (!overlaps(start, end, iv.start, iv.end)) continue;
    if (h.pay_first?.roomId) heldRooms.add(Number(h.pay_first.roomId));
  }
  const blocked = new Set();
  for (const b of activeRoomBlocks()) {
    if (overlaps(start, end, b.start, b.end)) b.rooms.forEach(r => blocked.add(r));
  }
  const known = !!occupancy?.known;
  const free = rooms.filter(r => {
    if (heldRooms.has(r) || blocked.has(r)) return false;
    if (!known) return true;
    return !(occupancy.busy.get(r) || []).some(iv => overlaps(start, end, iv.start, iv.end));
  });
  if (free.length === 0) return { ok: false, roomId: null, verified: known, reason: 'room_busy' };
  return { ok: true, roomId: free[0], verified: known };
}

async function occupancyFor(date) {
  try {
    return await mindbodyService.getRoomOccupancy(date);
  } catch (err) {
    logger.warn(`Room occupancy for ${date} unavailable:`, err.message);
    return null;
  }
}

/**
 * Filter offered slots for pay-first treatments: enough notice, a free room,
 * and not on hold for another guest who is paying. Other treatments pass
 * through untouched. Must run BEFORE the one-row-per-time dedupe so another
 * therapist's slot at the same time can still show.
 */
async function filterOfferedSlots(from, slots) {
  const pf = slots.filter(s => cfg.isPayFirst(s.sessionTypeId));
  if (pf.length === 0) return { slots, hiddenByLead: 0, earliestHidden: null };
  const minStart = Date.now() + cfg.PAY_FIRST_OFFER_LEAD_MINUTES * 60000;
  const holds = await db.getActivePayFirstHolds(from);
  const dates = [...new Set(pf.map(s => String(s.dateTime).slice(0, 10)))];
  const occ = new Map();
  await Promise.all(dates.map(async d => { occ.set(d, await occupancyFor(d)); }));
  let hiddenByLead = 0;
  let earliestHidden = null;
  const kept = slots.filter(s => {
    if (!cfg.isPayFirst(s.sessionTypeId)) return true;
    if (naiveMs(s.dateTime) < minStart) {
      hiddenByLead++;
      if (!earliestHidden || s.dateTime < earliestHidden) earliestHidden = s.dateTime;
      return false;
    }
    const pick = pickRoom({ sessionTypeId: s.sessionTypeId, startDateTime: s.dateTime, staffId: s.staffId, occupancy: occ.get(String(s.dateTime).slice(0, 10)), holds });
    return pick.ok;
  });
  return { slots: kept, hiddenByLead, earliestHidden };
}

// ── closing a checkout (expire confirmed first, mark second) ────────────────

/**
 * Close an open pay-first checkout. Returns 'expired' (Stripe confirmed, row
 * marked), 'paid' (it was paid meanwhile — the webhook/cron books it) or
 * 'unknown' (couldn't confirm; nothing changed — try again later).
 */
/** A link that is closed must never still go out with this turn's reply. */
function dropPendingLink(row) {
  const pending = row?.phone ? conversationService.get(row.phone)?.payFirstLinkPending : null;
  if (pending && Number(pending.rowId) === Number(row.id)) conversationService.update(row.phone, { payFirstLinkPending: null });
}

async function closeCheckout(row, reason = 'closed') {
  if (!row) return 'unknown';
  if (!row.stripe_session_id) {
    const ok = await db.updateBookingEventIfStatus(row.id, ['awaiting_payment'], { status: 'expired', cancelledAt: new Date().toISOString(), cancelReason: reason });
    if (ok === true) dropPendingLink(row);
    return ok === true ? 'expired' : 'unknown';
  }
  // Mark WHY before expiring: Stripe's expiry webhook for this very close may
  // arrive before our own write — it must stay silent (no "link expired").
  if (reason !== 'timeout') await db.mergePayFirst(row.id, { closing: reason });
  await paymentService.expireSession(row.stripe_session_id);
  const details = await paymentService.getSessionDetails(row.stripe_session_id);
  if (!details) return 'unknown';
  if (details.status === 'complete') return 'paid';
  if (details.status !== 'expired') return 'unknown';
  const ok = await db.updateBookingEventIfStatus(row.id, ['awaiting_payment'], { status: 'expired', cancelledAt: new Date().toISOString(), cancelReason: reason }, row.stripe_session_id);
  if (ok === false) {
    // Our own expiry webhook may have marked it first — still closed.
    const now = await db.getBookingEventById(row.id);
    if (now?.status === 'expired' && now.stripe_session_id === row.stripe_session_id) { dropPendingLink(row); return 'expired'; }
    return 'changed';
  }
  if (ok === true) dropPendingLink(row);
  return ok === true ? 'expired' : 'unknown';
}

/**
 * The guest went to the team (handoff, gift card, reschedule): their open
 * payment link must not stay payable behind the team's back. Silent.
 * @returns {Promise<string[]>} services whose link was cancelled
 */
async function closeOpenCheckoutsForHandoff(from) {
  const rows = await db.getPayFirstRowsForPhone(from);
  if (!rows) return [];
  const closed = [];
  for (const row of rows.filter(r => r.status === 'awaiting_payment')) {
    const r = await closeCheckout(row, 'handoff');
    if (r === 'expired') closed.push(row.service_name || 'treatment');
  }
  return closed;
}

// ── the guard: what does this guest already have? ───────────────────────────

/**
 * Called by book_appointment for a pay-first type BEFORE the journey gates and
 * the Confirm gate — re-sharing a link or answering "did my payment work?"
 * must never need a new confirmation or route to the team.
 * Returns null to proceed with a new checkout, or a result for the model.
 */
async function guardExisting(from, sessionTypeId, startDateTime, { replacePending = false, keepPending = false } = {}) {
  const rows = await db.getPayFirstRowsForPhone(from);
  if (rows === null) {
    return { error: 'booking_temporarily_unavailable', message: 'Our booking system could not be checked just now. Apologise and ask the customer to try again in a few minutes. Do NOT create or promise a payment link.' };
  }
  const nowMs = Date.now();
  const upcoming = rows.filter(r => naiveMs(r.pay_first?.startDateTime) > nowMs - 3 * 3600 * 1000);

  // Money the team still has to settle blocks new links however old it is.
  const unbooked = rows.find(r => r.status === 'paid_unbooked');
  if (unbooked) {
    return {
      error: 'paid_booking_pending_team',
      paid_service: unbooked.service_name,
      message: `This customer already PAID for ${unbooked.service_name} (${whenLabel(unbooked.pay_first?.startDateTime, langOf(unbooked, from))}) but it could not be booked automatically; our team is rebooking or refunding it. NEVER ask them to pay again and do not create a new booking. If they want another time, collect the preferred date/time and their email and call forward_reschedule_request so the team books it against the money already paid.`,
    };
  }

  // Same treatment at the same time (a facial at the time of a paid massage is
  // a different question, not a repeat).
  const same = upcoming.filter(r => key16(r.pay_first?.startDateTime) === key16(startDateTime) && Number(r.session_type_id) === Number(sessionTypeId) && !r.pay_first?.rebookedByTeam);
  const paid = same.find(r => r.status === 'paid');
  if (paid) {
    return { success: true, already_paid: true, requiresPayment: false, service_name: paid.service_name, message: 'This treatment at this time is already PAID and BOOKED. Confirm it warmly; do NOT mention payment or send any link.' };
  }
  if (same.some(r => r.status === 'booking')) {
    return { success: true, payment_received: true, booking_in_progress: true, requiresPayment: false, message: 'The customer has PAID for this time and the booking is being made in Mindbody right now — a confirmation message follows automatically within a minute. Tell them that; do NOT send a new payment link.' };
  }
  const open = same.find(r => r.status === 'awaiting_payment' && Number(r.session_type_id) === Number(sessionTypeId));
  if (open) {
    const details = await paymentService.getSessionDetails(open.stripe_session_id);
    if (!details) return { error: 'booking_temporarily_unavailable', message: 'The payment link could not be checked just now. Ask the customer to try again in a minute; do NOT create a new link.' };
    if (details.status === 'complete') {
      return { success: true, payment_received: true, booking_in_progress: true, requiresPayment: false, message: 'The customer has just PAID — the booking is being made right now and a confirmation follows automatically. Do NOT send a new link.' };
    }
    if (details.status === 'open' && details.url && !(details.expiresAt && details.expiresAt * 1000 <= Date.now() + 60000)) {
      return { reshare: true, row: open, paymentUrl: details.url, expiresAt: details.expiresAt };
    }
    // Expired (or about to): close it properly before a fresh link.
    const closed = await closeCheckout(open, 'timeout');
    if (closed === 'paid') {
      return { success: true, payment_received: true, booking_in_progress: true, requiresPayment: false, message: 'The customer has just PAID — the booking is being made right now and a confirmation follows automatically. Do NOT send a new link.' };
    }
    if (closed !== 'expired' && closed !== 'changed') {
      return { error: 'booking_temporarily_unavailable', message: 'The payment link could not be checked just now. Ask the customer to try again in a minute; do NOT create a new link.' };
    }
  }

  const otherOpen = upcoming.filter(r => r.status === 'awaiting_payment' && !(Number(r.session_type_id) === Number(sessionTypeId) && key16(r.pay_first?.startDateTime) === key16(startDateTime)));
  if (otherOpen.length > 0 && !keepPending) {
    if (!replacePending) {
      const o = otherOpen[0];
      return {
        error: 'open_checkout_exists',
        existing: { service: o.service_name, when: whenLabel(o.pay_first?.startDateTime, langOf(o, from)) },
        message: `The customer still has an UNPAID payment link for ${o.service_name} (${whenLabel(o.pay_first?.startDateTime, langOf(o, from))}). Ask them one short question: should the new time REPLACE that one, or do they want BOTH? Then call book_appointment again with replace_pending_payment: true (replace) or keep_pending_payment: true (both). Do not book before they answer.`,
      };
    }
    // Replace: the old link is closed only once the new time has passed every
    // check (bookPayFirst does it right before creating the new link).
    return { proceed: true, replaceRows: otherOpen };
  }
  return null;
}

/**
 * Close the links a new one replaces. Returns null when all are closed, or a
 * result for the model (paid meanwhile / couldn't be confirmed).
 */
async function closeReplacedCheckouts(rows) {
  for (const o of rows || []) {
    const r = await closeCheckout(o, 'superseded');
    if (r === 'paid') {
      return { error: 'previous_link_paid', message: `The customer has just PAID the earlier link for ${o.service_name} — that booking is being made now. Do NOT replace it; tell them it is being booked and ask whether they still want the new treatment as well.` };
    }
    if (r !== 'expired' && r !== 'changed') {
      return { error: 'booking_temporarily_unavailable', message: 'The earlier payment link could not be cancelled just now. Ask the customer to try again in a minute; do NOT create a new link yet.' };
    }
  }
  return null;
}

// ── creating the checkout ────────────────────────────────────────────────────

const reminderTimers = new Map(); // rowId -> timeout

function scheduleReminder(from, rowId, sessionId, mintedAtMs) {
  if (String(from).startsWith('web_')) return;
  const t = setTimeout(async () => {
    reminderTimers.delete(rowId);
    try {
      const row = await db.getBookingEventById(rowId);
      if (!row || row.status !== 'awaiting_payment' || row.stripe_session_id !== sessionId) return;
      if (await db.isHumanHandling(from)) return;
      const lastIn = await db.getLastInboundMessageAt(from);
      if (lastIn && new Date(lastIn).getTime() > mintedAtMs) return; // they wrote since — no automated push
      const details = await paymentService.getSessionDetails(sessionId);
      if (!details || details.status !== 'open' || !details.url) return;
      const lang = langOf(row, from);
      await sendGuestMessage(from, T.reminder(lang, textParams(row, lang)), { ctaLabel: T.linkCta(lang), ctaUrl: details.url });
    } catch (err) {
      logger.warn('Pay-first reminder failed:', err.message);
    }
  }, cfg.PAY_FIRST_REMINDER_MINUTES * 60 * 1000);
  if (typeof t.unref === 'function') t.unref();
  reminderTimers.set(rowId, t);
}

/**
 * Create the awaiting-payment row and its Stripe link. The link only leaves
 * this function once the row carries its session id (a link the DB doesn't
 * know must never reach a guest).
 */
async function startCheckout({ from, clientId, customerName, customerEmail, sessionTypeId, serviceName, startDateTime, staffId, staffName, staffRequested, roomId, notes, amountCents, lang }) {
  const payFirst = {
    clientId: String(clientId),
    sessionTypeId: Number(sessionTypeId),
    startDateTime,
    staffId: staffId ? Number(staffId) : null,
    staffName: staffName || null,
    staffRequested: !!staffRequested,
    roomId: roomId ? Number(roomId) : null,
    notes: notes || null,
    lang: lang || 'en',
    customerEmail: customerEmail || null,
    customerName: customerName || null,
    serviceName,
    amountCents,
    attempts: 0,
  };
  const rowId = await db.insertPayFirstRow({ phone: from, customerName, sessionTypeId, serviceName, staffName, amountCents, appointmentDate: startDateTime, payFirst });
  if (!rowId) return { error: 'booking_temporarily_unavailable', message: 'The booking could not be prepared just now. Apologise and ask the customer to try again in a minute.' };

  let checkout;
  try {
    checkout = await paymentService.createPayFirstCheckout({
      bookingEventId: rowId,
      amountCents,
      serviceName,
      description: `Renessence – ${whenLabel(startDateTime, lang)}${staffName ? ` – ${staffName}` : ''}`,
      from,
      customerEmail,
    });
  } catch (err) {
    logger.error('Pay-first checkout creation failed:', err.message);
    await db.updateBookingEventIfStatus(rowId, ['awaiting_payment'], { status: 'expired', cancelledAt: new Date().toISOString(), cancelReason: 'link_failed' });
    return { error: 'booking_temporarily_unavailable', message: 'The payment link could not be created just now. Apologise and ask the customer to try again in a minute.' };
  }

  const attached = await db.updateBookingEventIfStatus(rowId, ['awaiting_payment'], { stripeSessionId: checkout.sessionId });
  if (attached !== true) {
    // The DB doesn't know this link — it must never reach the guest.
    let gone = await paymentService.expireSession(checkout.sessionId);
    if (!gone) gone = await paymentService.expireSession(checkout.sessionId);
    if (!gone) {
      db.logError('pay_first_unrecorded_session', `Pay-first session ${checkout.sessionId} (row ${rowId}, ${from}) could not be recorded or expired. If it gets paid the webhook flags it as unclaimed.`, '', JSON.stringify({ rowId, sessionId: checkout.sessionId }));
    }
    await db.updateBookingEventIfStatus(rowId, ['awaiting_payment'], { status: 'expired', cancelledAt: new Date().toISOString(), cancelReason: 'link_failed' });
    return { error: 'booking_temporarily_unavailable', message: 'The payment link could not be prepared just now. Apologise and ask the customer to try again in a minute.' };
  }

  scheduleReminder(from, rowId, checkout.sessionId, Date.now());
  return { rowId, sessionId: checkout.sessionId, paymentUrl: checkout.paymentUrl, expiresAt: checkout.expiresAt };
}

/** The standard link message (server-sent, exact URL), with the link's real deadline. */
function linkMessage(row, lang, expiresAt = null, { replaced = null } = {}) {
  const p = textParams(row, lang);
  const until = expiresAt ? expiresAt * 1000 : Date.now() + 30 * 60000;
  p.until = new Date(until).toLocaleTimeString(lang === 'nl' ? 'nl-NL' : 'en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' });
  p.replaced = replaced;
  return T.link(lang, p);
}

// ── after payment: book in Mindbody ─────────────────────────────────────────

const inFlight = new Set();

/** Wait (bounded) for running finalizes — used on shutdown. */
async function waitForInFlight(maxMs = 20000) {
  const until = Date.now() + maxMs;
  while (inFlight.size > 0 && Date.now() < until) await new Promise(r => setTimeout(r, 250));
  return inFlight.size;
}

function paidNote(row, extraNotes) {
  const parts = [BOT_TAG, `✅ PAID online €${eur(row.amount_cents)} (Stripe, ${new Date().toISOString().slice(0, 10)})`];
  if (extraNotes) {
    // The LED add-on is requested in the notes but not part of the online price.
    parts.push(/LED/i.test(extraNotes) ? `${extraNotes} — NOT paid online, collect at reception` : extraNotes);
  }
  parts.push(`[bot#${row.id}]`);
  return parts.join(' | ');
}

async function teamAlert(row, subjectLine, details) {
  const pf = row.pay_first || {};
  const pi = row.stripe_payment_intent;
  db.markConversationEscalated(row.phone, subjectLine.slice(0, 120));
  emailService.sendEscalationEmail({
    customerName: row.customer_name || pf.customerName || 'Unknown',
    customerPhone: row.phone,
    customerEmail: pf.customerEmail || null,
    message: `${subjectLine}\n\nTreatment: ${row.service_name} — ${whenLabel(pf.startDateTime, 'en')}${pf.staffName ? ` (therapist chosen: ${pf.staffName}${pf.staffRequested ? ', requested by the guest' : ''})` : ''}\nAmount paid: €${eur(row.amount_cents)}${pi ? `\nStripe payment: https://dashboard.stripe.com/payments/${pi}` : ''}\nGuest language: ${pf.lang || 'en'}\n${details || ''}`,
  }).catch(err => logger.error('Pay-first team email failed:', err.message));
}

async function settlePaidUnbooked(row, reason, detail) {
  const ok = await db.updateBookingEventIfStatus(row.id, ['booking'], { status: 'paid_unbooked', cancelReason: String(reason).slice(0, 50) });
  if (ok !== true) {
    db.logError('pay_first_unbooked_state_unknown', `Row ${row.id} (${row.phone}) is paid but could not be booked (${reason}), and the row could not be marked (${ok}). MANUAL REVIEW: rebook or refund.`, '', JSON.stringify({ rowId: row.id, reason, detail }));
  }
  db.logError('pay_first_paid_unbooked', `€${eur(row.amount_cents)} paid for ${row.service_name} (${row.pay_first?.startDateTime}, ${row.phone}) but it could not be booked: ${reason}${detail ? ` — ${detail}` : ''}. Rebook in Mindbody or refund in Stripe.`, '', JSON.stringify({ rowId: row.id, reason, paymentIntent: row.stripe_payment_intent }));
  await teamAlert(row, `ACTION — €${eur(row.amount_cents)} PAID, NOT BOOKED (${reason}): rebook or refund`,
    `Why: ${reason}${detail ? ` — ${detail}` : ''}\nWhat to do: book the guest in Mindbody (note: "✅ PAID online €${eur(row.amount_cents)}") and tell them the time, or refund the payment in Stripe. Then mark it resolved in the dashboard chat.`);
  const lang = langOf(row);
  await sendGuestMessage(row.phone, T.paidUnbooked(lang, textParams(row, lang)));
}

async function confirmBooked(row, appointment, { adopted = false } = {}) {
  const pf = row.pay_first || {};
  // Name the therapist who was ACTUALLY booked (finalize may have switched).
  const bookedId = Number(appointment?.StaffId) || null;
  const swapped = !!bookedId && bookedId !== Number(pf.staffId);
  let staffName = appointment?.Staff?.DisplayName || appointment?.Staff?.Name || null;
  if (!staffName && swapped) {
    try {
      const s = ((await mindbodyService.getStaff()) || []).find(m => Number(m.Id) === bookedId);
      staffName = s ? (s.DisplayName || s.Name || [s.FirstName, s.LastName].filter(Boolean).join(' ') || null) : null;
    } catch (_) { /* the name is cosmetic */ }
  }
  if (!staffName && !swapped) staffName = pf.staffName || null;
  const updates = { status: 'paid', mindbodyAppointmentId: appointment.Id, ...(staffName || swapped ? { staffName } : {}) };
  const ok = await db.updateBookingEventIfStatus(row.id, ['booking'], updates);
  if (ok !== true) {
    // The appointment exists either way — the guest must still hear it.
    db.logError('pay_first_booked_row_not_updated', `Row ${row.id} (${row.phone}) was booked as apt ${appointment.Id} but the row could not be set to paid (${ok}). Fix the row by hand.`, '', JSON.stringify({ rowId: row.id, appointmentId: appointment.Id }));
  }
  await db.mergePayFirst(row.id, { bookedStaffName: staffName || null, ...(swapped ? { staffName: null, bookedStaffId: bookedId } : {}), ...(adopted ? { adopted: true } : {}) });
  mindbodyService.invalidateRoomOccupancy(pf.startDateTime);
  const fresh = { ...row, pay_first: { ...pf, staffName: swapped ? null : pf.staffName, bookedStaffName: staffName || null } };
  const lang = langOf(fresh);
  await sendGuestMessage(row.phone, T.booked(lang, textParams(fresh, lang)));
  if (pf.customerEmail) {
    emailService.sendBookingConfirmationEmail({
      customerEmail: pf.customerEmail,
      customerName: pf.customerName || row.customer_name,
      serviceName: row.service_name,
      date: whenLabel(pf.startDateTime, 'en').replace(/ at \d\d:\d\d$/, ''),
      time: String(pf.startDateTime).slice(11, 16),
    }).catch(err => logger.error('Pay-first confirmation email failed:', err.message));
  }
  if (await db.isHumanHandling(row.phone)) {
    // The team is talking to this guest — make sure they know it got booked.
    db.markConversationEscalated(row.phone, `Guest paid the bot link — ${row.service_name} booked ${whenLabel(pf.startDateTime, 'en')}`);
  }
}

/** Mindbody's answer was unclear: is the appointment there? 'found' | 'absent' | 'unknown'. */
async function lookUpBooking(row) {
  const pf = row.pay_first || {};
  try {
    const apt = await mindbodyService.findClientAppointmentAt(pf.clientId, pf.startDateTime, pf.sessionTypeId);
    return apt ? { state: 'found', apt } : { state: 'absent' };
  } catch (err) {
    logger.warn(`Pay-first lookup for row ${row.id} failed:`, err.message);
    return { state: 'unknown' };
  }
}

/**
 * Book a claimed ('booking') row in Mindbody. Every branch ends in either a
 * confirmed booking, paid_unbooked (team + guest told), or — when Mindbody's
 * state is unknown — the row left in 'booking' with a flag for the cron.
 */
async function finalize(rowId) {
  if (inFlight.has(rowId)) return 'in_progress';
  inFlight.add(rowId);
  const deadline = Date.now() + FINALIZE_DEADLINE_MS;
  try {
    let row = await db.getBookingEventById(rowId);
    if (!row || row.status !== 'booking' || !row.pay_first) return 'not_claimed';
    const pf = row.pay_first;
    await db.mergePayFirst(rowId, { attempts: (Number(pf.attempts) || 0) + 1, lastAttemptAt: new Date().toISOString() });

    const startMs = naiveMs(pf.startDateTime);
    if (!(startMs > Date.now() + cfg.PAY_FIRST_FINALIZE_MIN_LEAD_MINUTES * 60000)) {
      await settlePaidUnbooked(row, 'too_late', 'payment arrived too close to (or after) the start time');
      return 'paid_unbooked';
    }

    // Already there (a previous attempt whose answer got lost)?
    if ((Number(pf.attempts) || 0) > 0) {
      const look = await lookUpBooking(row);
      if (look.state === 'found') { await confirmBooked(row, look.apt, { adopted: true }); return 'paid'; }
      if (look.state === 'unknown') {
        db.logError('pay_first_booking_state_unknown', `Row ${rowId} (${row.phone}) is paid; Mindbody could not be checked before retrying. The cron retries.`, '', JSON.stringify({ rowId }));
        return 'unknown';
      }
    }

    const notes = paidNote(row, pf.notes);
    const attemptBook = async (staffId) => mindbodyService.addAppointment({
      clientId: pf.clientId,
      sessionTypeId: pf.sessionTypeId,
      staffId,
      startDateTime: pf.startDateTime,
      notes,
      strictRooms: true,
      preferredResourceId: pf.roomId || null,
      staffRequested: !!pf.staffRequested,
    });

    const handleUnknown = async (err) => {
      const look = await lookUpBooking(row);
      if (look.state === 'found') { await confirmBooked(row, look.apt, { adopted: true }); return 'paid'; }
      db.logError('pay_first_booking_state_unknown', `Row ${rowId} (${row.phone}): Mindbody's answer was unclear (${err.message}) and the lookup said ${look.state}. The cron re-checks.`, '', JSON.stringify({ rowId }));
      return 'unknown';
    };

    // Mindbody said yes but without an appointment id: look it up instead.
    const settle = async (apt) => {
      if (apt?.Id) { await confirmBooked(row, apt); return 'paid'; }
      return handleUnknown(new Error('booking returned no appointment id'));
    };

    let lastErr = null;
    try {
      return await settle(await attemptBook(pf.staffId || 0));
    } catch (err) {
      if (err.code === 'BOOKING_OUTCOME_UNKNOWN') return await handleUnknown(err);
      lastErr = err;
    }

    // The chosen therapist can't anymore: another therapist only if the guest
    // didn't pick this one on purpose.
    if (mindbodyService.isStaffRejection(lastErr) && !pf.staffRequested && Date.now() < deadline) {
      let candidates = [];
      try { candidates = await mindbodyService.findAvailableStaffForTime(pf.sessionTypeId, pf.startDateTime, pf.staffId); } catch (_) { /* none */ }
      for (const staffId of candidates.slice(0, 3)) {
        if (Date.now() > deadline) break;
        try {
          return await settle(await attemptBook(staffId));
        } catch (err) {
          if (err.code === 'BOOKING_OUTCOME_UNKNOWN') return await handleUnknown(err);
          lastErr = err;
        }
      }
    }

    if (lastErr?.code === 'ROOM_UNAVAILABLE') blockRooms(mindbodyService.RESOURCE_MAP?.[pf.sessionTypeId], pf.startDateTime, pf.sessionTypeId);
    const reason = lastErr?.code === 'ROOM_UNAVAILABLE' ? 'room_taken'
      : mindbodyService.isStaffRejection(lastErr) ? (pf.staffRequested ? 'therapist_taken' : 'no_therapist_free')
        : 'mindbody_refused';
    row = (await db.getBookingEventById(rowId)) || row;
    await settlePaidUnbooked(row, reason, lastErr?.response?.data?.Error?.Message || lastErr?.message || '');
    return 'paid_unbooked';
  } catch (err) {
    logger.error(`Pay-first finalize ${rowId} crashed:`, err.message);
    db.logError('pay_first_finalize_error', `Finalize of row ${rowId} failed unexpectedly: ${err.message}. The cron retries.`, err.stack || '', JSON.stringify({ rowId }));
    return 'error';
  } finally {
    inFlight.delete(rowId);
  }
}

// ── Stripe events ────────────────────────────────────────────────────────────

/**
 * checkout.session.completed / async_payment_succeeded for a pay-first row.
 * @returns {Promise<{httpStatus:number, handled:boolean}>} handled=false → not a pay-first session
 */
async function handlePaid(session) {
  let row;
  try {
    row = await db.getPayFirstRowBySession(session.id);
  } catch (_) {
    return { httpStatus: 500, handled: true }; // DB down — let Stripe retry
  }
  if (!row && session.metadata?.pay_first_booking_event_id) {
    row = await db.getBookingEventById(session.metadata.pay_first_booking_event_id);
  }
  const isPayFirstSession = (row && row.pay_first) || session.metadata?.pay_first === 'true';
  if (!isPayFirstSession) return { httpStatus: 200, handled: false };

  if (session.payment_status && session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
    db.logError('pay_first_completed_unpaid', `Pay-first session ${session.id} completed with payment_status '${session.payment_status}' — not booked yet. Check it in Stripe.`, '', JSON.stringify({ sessionId: session.id, rowId: row?.id }));
    return { httpStatus: 200, handled: true };
  }

  const claim = row ? await db.claimPayFirst(row.id, session.id, {
    paymentIntent: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id,
    amountCents: session.amount_total ?? null,
    paymentMethod: session.payment_method_types?.[0] || null,
  }) : false;
  if (claim === null) return { httpStatus: 500, handled: true }; // nothing done yet — Stripe retries

  if (claim === true) {
    finalize(row.id).catch(err => logger.error('Pay-first finalize error:', err.message));
    return { httpStatus: 200, handled: true };
  }

  // Not claimable: a true duplicate, or money that landed somewhere it shouldn't.
  const now = row ? (await db.getBookingEventById(row.id)) : null;
  if (now && now.stripe_session_id === session.id && ['booking', 'paid', 'paid_unbooked', 'refunded'].includes(now.status)) {
    logger.info(`Pay-first webhook duplicate for ${session.id} (row ${now.id} is ${now.status})`);
    return { httpStatus: 200, handled: true };
  }
  const amount = session.amount_total != null ? `€${eur(session.amount_total)}` : 'an amount';
  const pi = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
  db.logError('pay_first_payment_unclaimed', `${amount} paid on session ${session.id} (${session.metadata?.from || now?.phone || '?'}) but its booking row is ${now ? `'${now.status}'${now.stripe_session_id !== session.id ? ' on another session' : ''}` : 'missing'}. Nothing was booked: rebook or refund.`, '', JSON.stringify({ sessionId: session.id, rowId: now?.id || null, paymentIntent: pi }));
  const phone = now?.phone || session.metadata?.from;
  if (phone) {
    db.markConversationEscalated(phone, `${amount} paid — nothing booked: rebook or refund`);
    emailService.sendEscalationEmail({
      customerName: now?.customer_name || 'Unknown',
      customerPhone: phone,
      customerEmail: session.customer_details?.email || null,
      message: `ACTION — ${amount} PAID, NOTHING BOOKED: the guest paid a payment link (session ${session.id}) whose booking was no longer open (${now ? now.status : 'no row'}). Book the treatment in Mindbody or refund it.${pi ? `\nStripe payment: https://dashboard.stripe.com/payments/${pi}` : ''}`,
    }).catch(err => logger.error('Unclaimed payment email failed:', err.message));
  }
  return { httpStatus: 200, handled: true };
}

/** checkout.session.expired for a pay-first row: mark it (Stripe has confirmed) and tell the guest once. */
async function handleExpired(session) {
  let row;
  try { row = await db.getPayFirstRowBySession(session.id); } catch (_) { return { httpStatus: 500, handled: true }; }
  const isPayFirstSession = (row && row.pay_first) || session.metadata?.pay_first === 'true';
  if (!isPayFirstSession) return { httpStatus: 200, handled: false };
  if (!row) return { httpStatus: 200, handled: true };
  const closing = row.pay_first?.closing || null; // we closed it on purpose (handoff, replace)
  const ok = await db.updateBookingEventIfStatus(row.id, ['awaiting_payment'], { status: 'expired', cancelledAt: new Date().toISOString(), cancelReason: closing || 'timeout' }, session.id);
  if (ok === null) return { httpStatus: 500, handled: true };
  if (ok === true) { dropPendingLink(row); if (!closing) await notifyExpired(row); }
  return { httpStatus: 200, handled: true };
}

async function notifyExpired(row) {
  if (row.pay_first?.closing) return; // a deliberate close is not "your link expired"
  const t = reminderTimers.get(row.id);
  if (t) { clearTimeout(t); reminderTimers.delete(row.id); }
  if (String(row.phone).startsWith('web_')) return;
  if (await db.isHumanHandling(row.phone)) return; // the team is talking to them
  const lang = langOf(row);
  await sendGuestMessage(row.phone, T.expired(lang, textParams(row, lang)), { ctaLabel: T.feedbackCta(lang), ctaUrl: FEEDBACK_URL });
}

/** charge.refunded: a refund made in Stripe closes a paid_unbooked row. */
async function handleRefund(charge) {
  const pi = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
  if (!pi) return { httpStatus: 200 };
  let row;
  try { row = await db.getBookingEventByPaymentIntent(pi); } catch (_) { return { httpStatus: 500 }; }
  if (!row || !row.pay_first) return { httpStatus: 200 };
  const full = charge.refunded === true || (charge.amount_refunded != null && charge.amount != null && charge.amount_refunded >= charge.amount);
  if (!full) {
    db.logError('pay_first_partial_refund', `Partial refund on ${pi} (row ${row.id}, ${row.service_name}). Status left '${row.status}'.`, '', JSON.stringify({ rowId: row.id }));
    return { httpStatus: 200 };
  }
  if (row.status === 'paid_unbooked' || row.status === 'booking') {
    await db.updateBookingEventIfStatus(row.id, [row.status], { status: 'refunded' });
    logger.info(`Pay-first row ${row.id} refunded`);
  } else if (row.status === 'paid' && row.mindbody_appointment_id) {
    db.logError('pay_first_refunded_but_booked', `Payment ${pi} for apt ${row.mindbody_appointment_id} (${row.service_name}, ${row.phone}) was refunded, but the appointment is still booked. Cancel it in Mindbody if the guest isn't coming.`, '', JSON.stringify({ rowId: row.id }));
    db.markConversationEscalated(row.phone, 'Refunded, but the appointment is still booked — cancel it in Mindbody?');
  }
  return { httpStatus: 200 };
}

// ── safety sweep (cron, every 5 minutes) ────────────────────────────────────

async function sweep() {
  const rows = await db.getPayFirstRowsForSweep();
  const now = Date.now();
  for (const row of rows) {
    try {
      const age = now - new Date(row.created_at).getTime();
      if (row.status === 'awaiting_payment') {
        if (age < 5 * 60 * 1000) continue;
        if (!row.stripe_session_id) {
          if (age > 10 * 60 * 1000) await db.updateBookingEventIfStatus(row.id, ['awaiting_payment'], { status: 'expired', cancelledAt: new Date().toISOString(), cancelReason: 'no_link' });
          continue;
        }
        const d = await paymentService.getSessionDetails(row.stripe_session_id);
        if (!d) continue; // unknown — next run
        if (d.status === 'complete' && (d.paymentStatus === 'paid' || d.paymentStatus === 'no_payment_required')) {
          // A missed webhook: claim and book exactly as the webhook would.
          const claim = await db.claimPayFirst(row.id, row.stripe_session_id, { paymentIntent: d.paymentIntent, amountCents: d.amountTotal, paymentMethod: d.paymentMethod });
          if (claim === true) {
            db.logError('pay_first_webhook_missed', `Row ${row.id} (${row.phone}) was paid but no webhook arrived — booked by the sweep.`, '', JSON.stringify({ rowId: row.id }));
            await finalize(row.id);
          }
        } else if (d.status === 'complete') {
          if (age > 60 * 60 * 1000 && !row.pay_first?.flaggedUnpaidComplete) {
            db.logError('pay_first_completed_unpaid', `Row ${row.id}: session ${row.stripe_session_id} is complete but payment_status '${d.paymentStatus}'. Check it in Stripe.`, '', JSON.stringify({ rowId: row.id }));
            await db.mergePayFirst(row.id, { flaggedUnpaidComplete: true });
          }
        } else if (d.status === 'expired') {
          const ok = await db.updateBookingEventIfStatus(row.id, ['awaiting_payment'], { status: 'expired', cancelledAt: new Date().toISOString(), cancelReason: 'timeout' }, row.stripe_session_id);
          if (ok === true) await notifyExpired(row);
        } else if (d.status === 'open' && d.expiresAt && d.expiresAt * 1000 < now) {
          const r = await closeCheckout(row, 'timeout');
          if (r === 'expired') await notifyExpired(row);
        }
      } else if (row.status === 'booking') {
        const lastAttempt = row.pay_first?.lastAttemptAt ? new Date(row.pay_first.lastAttemptAt).getTime() : new Date(row.paid_at || row.created_at).getTime();
        if (now - lastAttempt < STUCK_BOOKING_MS || inFlight.has(row.id)) continue;
        if (!row.pay_first?.stuckFlagged) {
          db.logError('pay_first_booking_stuck', `Row ${row.id} (${row.phone}) is paid and has been 'booking' for a while (restart or Mindbody trouble) — the sweep is finishing it.`, '', JSON.stringify({ rowId: row.id }));
          await db.mergePayFirst(row.id, { stuckFlagged: true });
        }
        const look = await lookUpBooking(row);
        if (look.state === 'found') { await confirmBooked(row, look.apt, { adopted: true }); continue; }
        if (look.state === 'unknown') {
          const startMs = naiveMs(row.pay_first?.startDateTime);
          if (!(startMs > Date.now() + cfg.PAY_FIRST_FINALIZE_MIN_LEAD_MINUTES * 60000)) {
            // The start has come while Mindbody still can't be checked: stop
            // waiting — the team settles it, the guest is told honestly.
            await settlePaidUnbooked(row, 'mindbody_unreachable', 'Mindbody could not be reached to book or check this appointment before its start. CHECK Mindbody for an appointment at this time before rebooking or refunding.');
          } else if (!row.pay_first?.unknownAlerted) {
            await teamAlert(row, `CHECK — €${eur(row.amount_cents)} PAID, Mindbody unreachable: booking not confirmed yet`,
              'The bot keeps retrying every 5 minutes. If Mindbody stays unreachable until the start, this becomes "paid, not booked" automatically.');
            await db.mergePayFirst(row.id, { unknownAlerted: true });
          }
          continue;
        }
        if ((Number(row.pay_first?.attempts) || 0) >= MAX_FINALIZE_ATTEMPTS) {
          await settlePaidUnbooked(row, 'booking_failed_repeatedly', 'several booking attempts did not go through');
          continue;
        }
        await finalize(row.id);
      } else if (row.status === 'paid_unbooked') {
        if (age > 48 * 3600 * 1000 && !row.pay_first?.agingFlagged) {
          const ok = await db.logError('pay_first_unresolved', `Row ${row.id} (${row.phone}, €${eur(row.amount_cents)}) is still 'paid, not booked' after 48 hours. Rebook or refund, then mark it resolved.`, '', JSON.stringify({ rowId: row.id }));
          if (ok) await db.mergePayFirst(row.id, { agingFlagged: true });
        }
      }
    } catch (err) {
      logger.warn(`Pay-first sweep failed for row ${row.id}:`, err.message);
    }
  }
}

// ── for the model and the team ───────────────────────────────────────────────

/** One line for the prompt's Session section: this guest's latest pay-first state. */
async function statusLine(from) {
  if (String(from).startsWith('web_')) return null;
  const rows = await db.getPayFirstRowsForPhone(from);
  if (!rows || rows.length === 0) return null;
  const now = Date.now();
  const relevant = rows.filter(r => naiveMs(r.pay_first?.startDateTime) > now - 6 * 3600 * 1000).slice(0, 3);
  if (relevant.length === 0 && !rows.some(r => r.status === 'paid_unbooked')) return null;
  const label = { awaiting_payment: 'AWAITING PAYMENT (link sent; nothing booked yet)', booking: 'PAID — BOOKING IN PROGRESS (confirmation follows automatically)', paid: 'PAID & BOOKED', paid_unbooked: 'PAID, NOT BOOKED — the team will rebook or refund; never send a new link' };
  const describe = (r) => {
    if (r.status === 'paid' && r.pay_first?.rebookedByTeam) return `${r.service_name}: PAID — rebooked by the team (Mindbody appointment #${r.mindbody_appointment_id}); the time may differ from the original ${whenLabel(r.pay_first?.startDateTime, 'en')} — check with get_appointments`;
    const delayed = r.status === 'booking' && (r.pay_first?.stuckFlagged || r.pay_first?.unknownAlerted);
    return `${r.service_name}, ${whenLabel(r.pay_first?.startDateTime, 'en')}${r.pay_first?.bookedStaffName ? ` with ${r.pay_first.bookedStaffName}` : ''}: ${delayed ? 'PAID — booking delayed (our system is slow); the team has been alerted and will confirm; never send a new link' : (label[r.status] || r.status)}`;
  };
  return [...rows.filter(r => r.status === 'paid_unbooked' && !relevant.includes(r)), ...relevant].slice(0, 4).map(describe).join(' | ');
}

/**
 * Team resolution from the dashboard: a paid_unbooked row was rebooked by hand
 * (Mindbody appointment id) or refunded.
 */
async function resolvePaidUnbooked(rowId, { resolution, appointmentId = null }) {
  const row = await db.getBookingEventById(rowId);
  if (!row || !row.pay_first) return { ok: false, error: 'Not a pay-first booking.' };
  if (row.status !== 'paid_unbooked') return { ok: false, error: `This booking is '${row.status}', not 'paid, not booked'.` };
  if (resolution === 'rebooked') {
    const id = parseInt(appointmentId, 10);
    if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'Enter the Mindbody appointment number.' };
    const ok = await db.updateBookingEventIfStatus(row.id, ['paid_unbooked'], { status: 'paid', mindbodyAppointmentId: id, cancelReason: null });
    if (ok === true) await db.mergePayFirst(row.id, { rebookedByTeam: true, staffName: null, bookedStaffName: null });
    return ok === true ? { ok: true } : { ok: false, error: 'Could not update the booking — please try again.' };
  }
  if (resolution === 'refunded') {
    const ok = await db.updateBookingEventIfStatus(row.id, ['paid_unbooked'], { status: 'refunded' });
    return ok === true ? { ok: true } : { ok: false, error: 'Could not update the booking — please try again.' };
  }
  return { ok: false, error: 'Unknown resolution.' };
}

module.exports = {
  whenLabel,
  sendGuestMessage,
  T,
  pickRoom,
  occupancyFor,
  filterOfferedSlots,
  blockRooms,
  closeCheckout,
  closeReplacedCheckouts,
  closeOpenCheckoutsForHandoff,
  guardExisting,
  startCheckout,
  linkMessage,
  textParams,
  finalize,
  handlePaid,
  handleExpired,
  handleRefund,
  sweep,
  statusLine,
  resolvePaidUnbooked,
  waitForInFlight,
  _roomBlocks: roomBlocks,
};
