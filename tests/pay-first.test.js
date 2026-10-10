// Pay-first: massages, the facial, Nervous System Reset and Let It Go are
// paid BEFORE they are booked in Mindbody. These tests drive the real flow
// (guard → checkout → Stripe events → Mindbody booking → sweep) against an
// in-memory booking_events table, with Stripe, Mindbody and WhatsApp mocked.

jest.mock('stripe', () => jest.fn().mockImplementation(() => ({
  checkout: { sessions: { create: jest.fn(), expire: jest.fn(), retrieve: jest.fn() } },
  webhooks: { constructEvent: jest.fn() },
})));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/services/whatsapp.service', () => ({
  sendText: jest.fn().mockResolvedValue({}),
  sendButtons: jest.fn().mockResolvedValue({}),
  sendList: jest.fn().mockResolvedValue({}),
  sendCTAButton: jest.fn().mockResolvedValue({}),
}));
jest.mock('../src/services/email.service', () => ({
  sendEscalationEmail: jest.fn().mockResolvedValue({}),
  sendBookingConfirmationEmail: jest.fn().mockResolvedValue({}),
  sendRescheduleRequestEmail: jest.fn().mockResolvedValue({}),
  sendGiftCardRequestEmail: jest.fn().mockResolvedValue({}),
}));
jest.mock('../src/services/gift-card-check.service', () => ({}));
jest.mock('../src/services/mindbody.service', () => {
  const actual = jest.requireActual('../src/services/mindbody.service');
  return {
    RESOURCE_MAP: actual.RESOURCE_MAP,
    isStaffRejection: actual.isStaffRejection,
    isRoomRejection: actual.isRoomRejection,
    getClientByPhone: jest.fn(),
    findAvailableStaffForTime: jest.fn(),
    getRoomOccupancy: jest.fn(),
    invalidateRoomOccupancy: jest.fn(),
    getStaff: jest.fn().mockResolvedValue([{ Id: 5, Name: 'Lisa' }, { Id: 6, Name: 'Emma' }]),
    addAppointment: jest.fn(),
    findClientAppointmentAt: jest.fn(),
    getBookableItems: jest.fn(),
  };
});
jest.mock('../src/services/payment.service', () => ({
  ...jest.requireActual('../src/services/payment.service'),
  createPayFirstCheckout: jest.fn(),
  getSessionDetails: jest.fn(),
  expireSession: jest.fn().mockResolvedValue(true),
}));

// ── in-memory booking_events ─────────────────────────────────────────────────
const mockRows = new Map();
let mockNextId = 500;
const camel = (k) => k.replace(/([A-Z])/g, '_$1').toLowerCase();
jest.mock('../src/data/database', () => ({
  insertPayFirstRow: jest.fn(async (r) => {
    const id = ++mockNextId;
    mockRows.set(id, { id, phone: r.phone, customer_name: r.customerName, session_type_id: r.sessionTypeId, service_name: r.serviceName, staff_name: r.staffName, status: 'awaiting_payment', amount_cents: r.amountCents, appointment_date: r.appointmentDate, pay_first: JSON.parse(JSON.stringify(r.payFirst)), stripe_session_id: null, created_at: new Date().toISOString() });
    return id;
  }),
  updateBookingEventIfStatus: jest.fn(async (id, allowed, updates, sid) => {
    const r = mockRows.get(Number(id));
    if (!r) return false;
    if (!allowed.includes(r.status)) return false;
    if (sid && r.stripe_session_id !== sid) return false;
    for (const [k, v] of Object.entries(updates)) r[camel(k)] = v;
    return true;
  }),
  getBookingEventById: jest.fn(async (id) => (mockRows.has(Number(id)) ? { ...mockRows.get(Number(id)) } : null)),
  getPayFirstRowsForPhone: jest.fn(async (phone) => [...mockRows.values()].filter(r => r.phone === phone && r.pay_first && ['awaiting_payment', 'booking', 'paid', 'paid_unbooked'].includes(r.status)).reverse().map(r => ({ ...r }))),
  getActivePayFirstHolds: jest.fn(async (phone) => [...mockRows.values()].filter(r => r.phone !== phone && r.pay_first && ['awaiting_payment', 'booking'].includes(r.status)).map(r => ({ ...r }))),
  getPayFirstRowBySession: jest.fn(async (sid) => { const r = [...mockRows.values()].find(x => x.stripe_session_id === sid); return r ? { ...r } : null; }),
  claimPayFirst: jest.fn(async (id, sid, money) => {
    const r = mockRows.get(Number(id));
    if (!r || r.stripe_session_id !== sid || !['awaiting_payment', 'expired'].includes(r.status)) return false;
    Object.assign(r, { status: 'booking', paid_at: new Date().toISOString(), stripe_payment_intent: money.paymentIntent, amount_cents: money.amountCents ?? r.amount_cents });
    return true;
  }),
  mergePayFirst: jest.fn(async (id, patch) => { const r = mockRows.get(Number(id)); if (r) r.pay_first = { ...r.pay_first, ...patch }; return true; }),
  getPayFirstRowsForSweep: jest.fn(async () => [...mockRows.values()].filter(r => r.pay_first && ['awaiting_payment', 'booking', 'paid_unbooked'].includes(r.status)).map(r => ({ ...r }))),
  getBookingEventByPaymentIntent: jest.fn(async (pi) => { const r = [...mockRows.values()].find(x => x.stripe_payment_intent === pi); return r ? { ...r } : null; }),
  logError: jest.fn().mockResolvedValue(true),
  markConversationEscalated: jest.fn(),
  logMessage: jest.fn(),
  isHumanHandling: jest.fn().mockResolvedValue(false),
  getLastInboundMessageAt: jest.fn().mockResolvedValue(null),
  getOpenJourneyForDay: jest.fn().mockResolvedValue({ count: 0, totalCents: 0 }),
  getRecentBooking: jest.fn().mockResolvedValue(null),
  saveConversationState: jest.fn().mockResolvedValue(),
  setConversationLanguage: jest.fn().mockResolvedValue(),
  hasRecentTeamNotification: jest.fn().mockResolvedValue(false),
  logEscalation: jest.fn(),
  query: jest.fn().mockResolvedValue({ rows: [] }),
}));

const db = require('../src/data/database');
const mindbody = require('../src/services/mindbody.service');
const payments = require('../src/services/payment.service');
const whatsapp = require('../src/services/whatsapp.service');
const email = require('../src/services/email.service');
const conversations = require('../src/services/conversation.service');
const payFirst = require('../src/services/pay-first.service');
const tools = require('../src/agents/tool-implementations');

const PHONE = '31611111111';
const OTHER = '31699999999';
const MASSAGE_60 = 31;
const CLIENT = { Id: 7, FirstName: 'Sanne', LastName: 'de Vries', Email: 'sanne@example.com' };

const pad = (n) => String(n).padStart(2, '0');
/** A naive local datetime `minutes` from now, on a 5-minute grid. */
function inMinutes(minutes) {
  const d = new Date(Date.now() + minutes * 60000);
  d.setMinutes(Math.floor(d.getMinutes() / 5) * 5, 0, 0);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}
const START = inMinutes(3 * 24 * 60); // three days ahead

function confirmedAndOffered(start = START, extra = {}) {
  conversations.set(PHONE, { lang: 'en', bookingConfirmedAt: Date.now(), offeredSlots: [{ sessionTypeId: MASSAGE_60, dateTime: start }], ...extra });
}

const flush = async () => { for (let i = 0; i < 25; i++) await new Promise(r => setImmediate(r)); };

beforeEach(() => {
  jest.clearAllMocks();
  mockRows.clear();
  mockNextId = 500;
  conversations.clear(PHONE);
  conversations.clear(OTHER);
  payFirst._roomBlocks.length = 0;
  mindbody.getClientByPhone.mockResolvedValue(CLIENT);
  mindbody.findAvailableStaffForTime.mockResolvedValue([5, 6]);
  mindbody.getRoomOccupancy.mockResolvedValue({ known: true, busy: new Map() });
  mindbody.addAppointment.mockResolvedValue({ Id: 9100, StaffId: 5 });
  mindbody.findClientAppointmentAt.mockResolvedValue(null);
  let n = 0;
  payments.createPayFirstCheckout.mockImplementation(async () => { n++; return { sessionId: `cs_${n}`, paymentUrl: `https://pay.stripe.test/cs_${n}`, expiresAt: Math.floor(Date.now() / 1000) + 1860 }; });
  payments.getSessionDetails.mockImplementation(async (sid) => ({ status: 'open', paymentStatus: 'unpaid', url: `https://pay.stripe.test/${sid}`, expiresAt: Math.floor(Date.now() / 1000) + 1800 }));
  payments.expireSession.mockResolvedValue(true);
  db.isHumanHandling.mockResolvedValue(false);
});

async function bookAndPayLink(start = START, extra = {}) {
  confirmedAndOffered(start, extra);
  return tools.toolBookAppointment(PHONE, { session_type_id: MASSAGE_60, start_date_time: start, staff_id: 5 });
}

function paidSession(sid, extra = {}) {
  return { id: sid, payment_status: 'paid', payment_intent: `pi_${sid}`, amount_total: 13000, payment_method_types: ['card'], metadata: { pay_first: 'true' }, ...extra };
}

// ── book_appointment ─────────────────────────────────────────────────────────

describe('book_appointment for a pay-first treatment', () => {
  test('creates a payment link — nothing is booked in Mindbody', async () => {
    const r = await bookAndPayLink();
    expect(r).toMatchObject({ success: true, payFirst: true, requiresPayment: true });
    expect(mindbody.addAppointment).not.toHaveBeenCalled();
    const row = [...mockRows.values()][0];
    expect(row).toMatchObject({ status: 'awaiting_payment', stripe_session_id: 'cs_1', amount_cents: 13000, service_name: 'Tailored Massage 60 min' });
    expect(row.pay_first).toMatchObject({ clientId: '7', staffId: 5, roomId: 3, staffRequested: false, startDateTime: START });
    // The reply that follows sends the server's text with the exact link.
    expect(conversations.get(PHONE).payFirstLinkPending).toMatchObject({ url: 'https://pay.stripe.test/cs_1' });
  });

  test('the model\'s reply is replaced by the standard link message with the exact URL', async () => {
    await bookAndPayLink();
    await tools.executeRespond(PHONE, { message: '✅ Reserved for you!', ui_type: 'cta_button', cta_label: 'Pay', cta_url: 'https://pay.stripe.test/cs_1_TRUNCATED' });
    expect(whatsapp.sendCTAButton).toHaveBeenCalledTimes(1);
    const [, text, label, url] = whatsapp.sendCTAButton.mock.calls[0];
    expect(url).toBe('https://pay.stripe.test/cs_1');
    expect(label).toBe('Pay & book');
    expect(text).toMatch(/isn't reserved for you yet/);
    expect(text).not.toMatch(/Reserved for you/);
  });

  test('a time closer than 45 minutes is refused (slot_too_soon)', async () => {
    const soon = inMinutes(30);
    const r = await bookAndPayLink(soon);
    expect(r.error).toBe('slot_too_soon');
    expect(payments.createPayFirstCheckout).not.toHaveBeenCalled();
  });

  test('both massage rooms taken → slot_unavailable, no link', async () => {
    const s = new Date(START).getTime();
    mindbody.getRoomOccupancy.mockResolvedValue({ known: true, busy: new Map([[3, [{ start: s - 30 * 60000, end: s + 30 * 60000 }]], [4, [{ start: s + 60 * 60000, end: s + 120 * 60000 }]]]) });
    const r = await bookAndPayLink();
    expect(r.error).toBe('slot_unavailable');
    expect(payments.createPayFirstCheckout).not.toHaveBeenCalled();
  });

  test('one room taken → the free room is recorded for the booking', async () => {
    const s = new Date(START).getTime();
    mindbody.getRoomOccupancy.mockResolvedValue({ known: true, busy: new Map([[3, [{ start: s - 30 * 60000, end: s + 30 * 60000 }]]]) });
    await bookAndPayLink();
    expect([...mockRows.values()][0].pay_first.roomId).toBe(4);
  });

  test('Mindbody unreachable for the room check → no link (fail closed)', async () => {
    mindbody.getRoomOccupancy.mockRejectedValue(new Error('503'));
    const r = await bookAndPayLink();
    expect(r.error).toBe('booking_temporarily_unavailable');
    expect(payments.createPayFirstCheckout).not.toHaveBeenCalled();
  });

  test('a therapist the guest picked who is no longer free → therapist_unavailable (never swapped silently)', async () => {
    mindbody.findAvailableStaffForTime.mockResolvedValue([6]);
    const r = await bookAndPayLink(START, { therapistChoice: 5 });
    expect(r.error).toBe('therapist_unavailable');
  });

  test('another guest paying for the same therapist and time holds it', async () => {
    mockRows.set(1, { id: 1, phone: OTHER, session_type_id: MASSAGE_60, status: 'awaiting_payment', pay_first: { startDateTime: START, staffId: 5, roomId: 3 }, stripe_session_id: 'cs_other' });
    mindbody.findAvailableStaffForTime.mockResolvedValue([5]);
    const r = await bookAndPayLink();
    expect(r.error).toBe('slot_unavailable');
  });

  test('Mindbody not answering the therapist check → "try again", not "taken"', async () => {
    mindbody.findAvailableStaffForTime.mockRejectedValue(new Error('503'));
    const r = await bookAndPayLink();
    expect(r.error).toBe('booking_temporarily_unavailable');
    expect(conversations.get(PHONE).failedSlots || []).toEqual([]);
  });

  test('a therapist on hold for another paying guest → another free therapist is used', async () => {
    mockRows.set(1, { id: 1, phone: OTHER, session_type_id: MASSAGE_60, status: 'awaiting_payment', pay_first: { startDateTime: START, staffId: 5, roomId: 3 }, stripe_session_id: 'cs_other' });
    const r = await bookAndPayLink();
    expect(r.payFirst).toBe(true);
    expect([...mockRows.values()].find(x => x.phone === PHONE).pay_first).toMatchObject({ staffId: 6, roomId: 4 });
  });

  test('web chat cannot take these bookings', async () => {
    const r = await tools.toolBookAppointment('web_abc', { session_type_id: MASSAGE_60, start_date_time: START, staff_id: 5 });
    expect(r.error).toBe('whatsapp_only');
  });

  test('if the link cannot be recorded, it never reaches the guest', async () => {
    db.updateBookingEventIfStatus.mockResolvedValueOnce(null); // attaching the session id fails
    const r = await bookAndPayLink();
    expect(r.error).toBe('booking_temporarily_unavailable');
    expect(payments.expireSession).toHaveBeenCalledWith('cs_1');
    expect(conversations.get(PHONE).payFirstLinkPending).toBeFalsy();
  });
});

describe('review round: link delivery, replace, deadlines', () => {
  test('a re-shared link states its real deadline, not "30 minutes"', async () => {
    await bookAndPayLink();
    conversations.update(PHONE, { payFirstLinkPending: null });
    const soon = Math.floor(Date.now() / 1000) + 5 * 60;
    payments.getSessionDetails.mockResolvedValueOnce({ status: 'open', paymentStatus: 'unpaid', url: 'https://pay.stripe.test/cs_1', expiresAt: soon });
    await tools.toolBookAppointment(PHONE, { session_type_id: MASSAGE_60, start_date_time: START, staff_id: 5 });
    const until = new Date(soon * 1000).toLocaleTimeString('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' });
    expect(conversations.get(PHONE).payFirstLinkPending.text).toMatch(new RegExp(`valid until ${until}`));
  });

  test('replace: the old link stays open when the new time fails a check', async () => {
    await bookAndPayLink();
    const later = inMinutes(3 * 24 * 60 + 120);
    const s2 = new Date(later).getTime();
    mindbody.getRoomOccupancy.mockResolvedValue({ known: true, busy: new Map([[3, [{ start: s2, end: s2 + 3600000 }]], [4, [{ start: s2, end: s2 + 3600000 }]]]) });
    confirmedAndOffered(later);
    const r = await tools.toolBookAppointment(PHONE, { session_type_id: MASSAGE_60, start_date_time: later, staff_id: 5, replace_pending_payment: true });
    expect(r.error).toBe('slot_unavailable');
    expect(mockRows.get(501).status).toBe('awaiting_payment');
    expect(payments.expireSession).not.toHaveBeenCalled();
  });

  test('replace: the new link message tells the guest the earlier link no longer works', async () => {
    await bookAndPayLink();
    const later = inMinutes(3 * 24 * 60 + 120);
    payments.getSessionDetails.mockResolvedValueOnce({ status: 'expired', paymentStatus: 'unpaid' });
    confirmedAndOffered(later);
    const r = await tools.toolBookAppointment(PHONE, { session_type_id: MASSAGE_60, start_date_time: later, staff_id: 5, replace_pending_payment: true });
    expect(r.previous_link_cancelled).toMatch(/Tailored Massage 60 min/);
    expect(conversations.get(PHONE).payFirstLinkPending.text).toMatch(/earlier payment link for Tailored Massage 60 min .* no longer works/);
  });

  test('a link closed later in the same turn (handoff) never goes out; the model\'s reply does', async () => {
    await bookAndPayLink();
    payments.getSessionDetails.mockResolvedValueOnce({ status: 'expired', paymentStatus: 'unpaid' });
    await tools.toolHumanHandoff(PHONE, 'Sanne', { reason: 'Order of €150+', customer_email: 'sanne@example.com' });
    await tools.executeRespond(PHONE, { message: 'Our team will arrange it for you.', ui_type: 'none' });
    expect(whatsapp.sendCTAButton).not.toHaveBeenCalled();
    expect(whatsapp.sendText).toHaveBeenCalledWith(PHONE, 'Our team will arrange it for you.');
  });

  test('another booking refused in the same turn: both the link and the model\'s explanation go out', async () => {
    await bookAndPayLink();
    conversations.update(PHONE, { payFirstLinkPending: { ...conversations.get(PHONE).payFirstLinkPending, alsoSendModelText: true } });
    await tools.executeRespond(PHONE, { message: 'The float is arranged by our team.', ui_type: 'none' });
    expect(whatsapp.sendCTAButton).toHaveBeenCalledTimes(1);
    expect(whatsapp.sendText).toHaveBeenCalledWith(PHONE, 'The float is arranged by our team.');
  });

  test('our own close (handoff) is silent even if Stripe\'s expiry event wins the race', async () => {
    await bookAndPayLink();
    payments.expireSession.mockImplementationOnce(async () => {
      await payFirst.handleExpired({ id: 'cs_1', metadata: { pay_first: 'true' } }); // webhook lands first
      return true;
    });
    payments.getSessionDetails.mockResolvedValueOnce({ status: 'expired', paymentStatus: 'unpaid' });
    const closed = await payFirst.closeOpenCheckoutsForHandoff(PHONE);
    expect(closed).toEqual(['Tailored Massage 60 min']);
    expect(whatsapp.sendCTAButton).not.toHaveBeenCalled();
  });

  test('Mindbody unreachable while paid: team alerted once, then "paid, not booked" at the start', async () => {
    await bookAndPayLink();
    Object.assign(mockRows.get(501), { status: 'booking', paid_at: new Date(Date.now() - 10 * 60000).toISOString() });
    mindbody.findClientAppointmentAt.mockRejectedValue(new Error('503'));
    await payFirst.sweep();
    await payFirst.sweep();
    expect(email.sendEscalationEmail).toHaveBeenCalledTimes(1);
    expect(mockRows.get(501).status).toBe('booking');
    mockRows.get(501).pay_first.startDateTime = inMinutes(2);
    mockRows.get(501).pay_first.lastAttemptAt = new Date(Date.now() - 10 * 60000).toISOString();
    await payFirst.sweep();
    expect(mockRows.get(501)).toMatchObject({ status: 'paid_unbooked', cancel_reason: 'mindbody_unreachable' });
  });

  test('"paid, not booked" keeps blocking new links long after the original time', async () => {
    await bookAndPayLink();
    Object.assign(mockRows.get(501), { status: 'paid_unbooked' });
    mockRows.get(501).pay_first.startDateTime = inMinutes(-48 * 60);
    const r = await bookAndPayLink(inMinutes(5 * 24 * 60));
    expect(r.error).toBe('paid_booking_pending_team');
  });

  test('a paid massage does not make a facial at the same time read as "already paid"', async () => {
    await bookAndPayLink();
    mockRows.get(501).status = 'paid';
    conversations.set(PHONE, { lang: 'en', bookingConfirmedAt: Date.now(), offeredSlots: [{ sessionTypeId: 41, dateTime: START }] });
    const r = await tools.toolBookAppointment(PHONE, { session_type_id: 41, start_date_time: START, staff_id: 5 });
    expect(r.already_paid).toBeUndefined();
  });

  test('after the team marks "Rebooked", the bot does not claim the old time is booked', async () => {
    await bookAndPayLink();
    mockRows.get(501).status = 'paid_unbooked';
    await payFirst.resolvePaidUnbooked(501, { resolution: 'rebooked', appointmentId: '9600' });
    expect(await payFirst.statusLine(PHONE)).toMatch(/rebooked by the team \(Mindbody appointment #9600\)/);
  });
});

describe('fix check: second links, close races, delivery', () => {
  test('a time already PAID for another treatment never gets a second link (e.g. "make it 80 minutes")', async () => {
    await bookAndPayLink();
    mockRows.get(501).status = 'paid';
    conversations.set(PHONE, { lang: 'en', bookingConfirmedAt: Date.now(), offeredSlots: [{ sessionTypeId: 32, dateTime: START }] });
    const r = await tools.toolBookAppointment(PHONE, { session_type_id: 32, start_date_time: START, staff_id: 6 });
    expect(r.error).toBe('time_already_paid_other_treatment');
    expect(payments.createPayFirstCheckout).toHaveBeenCalledTimes(1);
  });

  test('a close that Stripe did not confirm leaves no "closing" mark — the real lapse later is announced', async () => {
    await bookAndPayLink();
    payments.expireSession.mockResolvedValueOnce(false);
    payments.getSessionDetails.mockResolvedValueOnce({ status: 'open', paymentStatus: 'unpaid' });
    expect(await payFirst.closeCheckout(mockRows.get(501), 'handoff')).toBe('unknown');
    expect(mockRows.get(501).pay_first.closing).toBeNull();
    await payFirst.handleExpired({ id: 'cs_1', metadata: { pay_first: 'true' } });
    expect(whatsapp.sendCTAButton).toHaveBeenCalledWith(PHONE, expect.stringMatching(/expired/), 'Give feedback', expect.any(String));
  });

  test('renewing a link about to expire stays silent even if Stripe\'s expiry event wins', async () => {
    await bookAndPayLink();
    conversations.update(PHONE, { payFirstLinkPending: null, bookingConfirmedAt: null }); // a later turn
    payments.getSessionDetails
      .mockResolvedValueOnce({ status: 'open', paymentStatus: 'unpaid', url: 'x', expiresAt: Math.floor(Date.now() / 1000) + 20 })
      .mockResolvedValueOnce({ status: 'expired', paymentStatus: 'unpaid' });
    payments.expireSession.mockImplementationOnce(async () => { await payFirst.handleExpired({ id: 'cs_1', metadata: { pay_first: 'true' } }); return true; });
    const r = await tools.toolBookAppointment(PHONE, { session_type_id: MASSAGE_60, start_date_time: START, staff_id: 5 });
    expect(whatsapp.sendCTAButton).not.toHaveBeenCalledWith(PHONE, expect.stringMatching(/expired/), expect.anything(), expect.anything());
    expect(mockRows.get(501).status).toBe('expired');
    expect(r.error).toBe('confirmation_required'); // a fresh link needs a fresh Confirm
  });

  test('the sweep never announces an expiry twice when Stripe\'s event got there first', async () => {
    await bookAndPayLink();
    mockRows.get(501).created_at = new Date(Date.now() - 40 * 60000).toISOString();
    payments.getSessionDetails
      .mockResolvedValueOnce({ status: 'open', paymentStatus: 'unpaid', expiresAt: Math.floor(Date.now() / 1000) - 60 })
      .mockResolvedValueOnce({ status: 'expired', paymentStatus: 'unpaid' });
    payments.expireSession.mockImplementationOnce(async () => { await payFirst.handleExpired({ id: 'cs_1', metadata: { pay_first: 'true' } }); return true; });
    await payFirst.sweep();
    const expiredMsgs = whatsapp.sendCTAButton.mock.calls.filter(c => /expired/.test(c[1]));
    expect(expiredMsgs).toHaveLength(1);
  });

  test('link + explanation: a cta reply is sent as plain text next to the exact link', async () => {
    await bookAndPayLink();
    conversations.update(PHONE, { payFirstLinkPending: { ...conversations.get(PHONE).payFirstLinkPending, alsoSendModelText: true } });
    await tools.executeRespond(PHONE, { message: 'Your other request goes to our team.', ui_type: 'cta_button', cta_url: 'https://made.up/link' });
    expect(whatsapp.sendCTAButton).toHaveBeenCalledTimes(1);
    expect(whatsapp.sendCTAButton.mock.calls[0][3]).toBe('https://pay.stripe.test/cs_1');
    expect(whatsapp.sendText).toHaveBeenCalledWith(PHONE, 'Your other request goes to our team.');
  });

  test('a DB hiccup while delivering still sends the link', async () => {
    await bookAndPayLink();
    db.getBookingEventById.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await tools.executeRespond(PHONE, { message: 'x', ui_type: 'cta_button' });
    expect(whatsapp.sendCTAButton).toHaveBeenCalledWith(PHONE, expect.any(String), 'Pay & book', 'https://pay.stripe.test/cs_1');
  });
});

describe('guard: what the guest already has (runs before the Confirm gate)', () => {
  test('asking again for the same time re-shares the open link — no new Confirm, no second link', async () => {
    await bookAndPayLink();
    conversations.update(PHONE, { bookingConfirmedAt: null, payFirstLinkPending: null }); // a later turn
    const r = await tools.toolBookAppointment(PHONE, { session_type_id: MASSAGE_60, start_date_time: START, staff_id: 5 });
    expect(r).toMatchObject({ payment_link_already_sent: true, paymentUrl: 'https://pay.stripe.test/cs_1' });
    expect(payments.createPayFirstCheckout).toHaveBeenCalledTimes(1);
  });

  test('paid and being booked → "booking in progress", never a new link', async () => {
    await bookAndPayLink();
    mockRows.get(501).status = 'booking';
    conversations.update(PHONE, { bookingConfirmedAt: Date.now() });
    const r = await tools.toolBookAppointment(PHONE, { session_type_id: MASSAGE_60, start_date_time: START, staff_id: 5 });
    expect(r).toMatchObject({ booking_in_progress: true });
    expect(payments.createPayFirstCheckout).toHaveBeenCalledTimes(1);
  });

  test('paid but not booked → the guest is never asked to pay again', async () => {
    await bookAndPayLink();
    mockRows.get(501).status = 'paid_unbooked';
    const other = inMinutes(4 * 24 * 60);
    confirmedAndOffered(other);
    const r = await tools.toolBookAppointment(PHONE, { session_type_id: MASSAGE_60, start_date_time: other, staff_id: 5 });
    expect(r.error).toBe('paid_booking_pending_team');
    expect(payments.createPayFirstCheckout).toHaveBeenCalledTimes(1);
  });

  test('an unpaid link for another time → ask first; replacing closes it only once Stripe confirms', async () => {
    await bookAndPayLink();
    const later = inMinutes(3 * 24 * 60 + 120);
    confirmedAndOffered(later);
    const ask = await tools.toolBookAppointment(PHONE, { session_type_id: MASSAGE_60, start_date_time: later, staff_id: 5 });
    expect(ask.error).toBe('open_checkout_exists');

    payments.getSessionDetails.mockResolvedValueOnce({ status: 'expired', paymentStatus: 'unpaid' });
    confirmedAndOffered(later);
    const r = await tools.toolBookAppointment(PHONE, { session_type_id: MASSAGE_60, start_date_time: later, staff_id: 5, replace_pending_payment: true });
    expect(r.payFirst).toBe(true);
    expect(mockRows.get(501).status).toBe('expired');
    expect(mockRows.get(501).cancel_reason).toBe('superseded');
  });

  test('replacing a link the guest just paid is refused', async () => {
    await bookAndPayLink();
    const later = inMinutes(3 * 24 * 60 + 120);
    payments.getSessionDetails.mockResolvedValueOnce({ status: 'complete', paymentStatus: 'paid' });
    confirmedAndOffered(later);
    const r = await tools.toolBookAppointment(PHONE, { session_type_id: MASSAGE_60, start_date_time: later, staff_id: 5, replace_pending_payment: true });
    expect(r.error).toBe('previous_link_paid');
    expect(mockRows.get(501).status).toBe('awaiting_payment');
  });

  test('a handoff to the team cancels an unpaid link', async () => {
    await bookAndPayLink();
    payments.getSessionDetails.mockResolvedValueOnce({ status: 'expired', paymentStatus: 'unpaid' });
    const r = await tools.toolHumanHandoff(PHONE, 'Sanne', { reason: 'wants to pay at reception', customer_email: 'sanne@example.com' });
    expect(r.payment_link_cancelled).toEqual(['Tailored Massage 60 min']);
    expect(mockRows.get(501).status).toBe('expired');
  });
});

// ── Stripe → Mindbody ────────────────────────────────────────────────────────

describe('after payment', () => {
  test('paid → booked in Mindbody with the PAID note, the row settles as paid, the guest is told', async () => {
    await bookAndPayLink(START);
    mockRows.get(501).pay_first.notes = 'Add-on requested: LED Light Face Therapy (+€30)';
    const res = await payFirst.handlePaid(paidSession('cs_1'));
    expect(res).toEqual({ httpStatus: 200, handled: true });
    await flush();
    const call = mindbody.addAppointment.mock.calls[0][0];
    expect(call).toMatchObject({ clientId: '7', sessionTypeId: 31, staffId: 5, startDateTime: START, strictRooms: true, preferredResourceId: 3 });
    expect(call.notes).toMatch(/✅ PAID online €130/);
    expect(call.notes).toMatch(/LED .*NOT paid online/);
    expect(call.notes).toMatch(/\[bot#501\]/);
    expect(mockRows.get(501)).toMatchObject({ status: 'paid', mindbody_appointment_id: 9100, stripe_payment_intent: 'pi_cs_1' });
    expect(whatsapp.sendText).toHaveBeenCalledWith(PHONE, expect.stringMatching(/Payment received ✅[\s\S]*is booked/));
    expect(db.logMessage).toHaveBeenCalledWith(PHONE, 'assistant', expect.stringMatching(/is booked/));
  });

  test('a duplicate delivery does nothing', async () => {
    await bookAndPayLink();
    await payFirst.handlePaid(paidSession('cs_1'));
    await flush();
    const again = await payFirst.handlePaid(paidSession('cs_1'));
    await flush();
    expect(again.httpStatus).toBe(200);
    expect(mindbody.addAppointment).toHaveBeenCalledTimes(1);
    expect(db.logError).not.toHaveBeenCalledWith('pay_first_payment_unclaimed', expect.anything(), expect.anything(), expect.anything());
  });

  test('a DB error while claiming → 500 so Stripe retries (nothing done yet)', async () => {
    await bookAndPayLink();
    db.claimPayFirst.mockResolvedValueOnce(null);
    const res = await payFirst.handlePaid(paidSession('cs_1'));
    expect(res.httpStatus).toBe(500);
    expect(mindbody.addAppointment).not.toHaveBeenCalled();
  });

  test('money landing on a row that is no longer open is flagged, never silently dropped', async () => {
    await bookAndPayLink();
    mockRows.get(501).status = 'cancelled';
    const res = await payFirst.handlePaid(paidSession('cs_1'));
    expect(res.httpStatus).toBe(200);
    expect(db.logError).toHaveBeenCalledWith('pay_first_payment_unclaimed', expect.any(String), '', expect.any(String));
    expect(db.markConversationEscalated).toHaveBeenCalledWith(PHONE, expect.stringMatching(/paid — nothing booked/));
    expect(email.sendEscalationEmail).toHaveBeenCalled();
  });

  test('an unclear Mindbody answer is settled by looking — found → adopted, never booked twice', async () => {
    await bookAndPayLink();
    mindbody.addAppointment.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'BOOKING_OUTCOME_UNKNOWN' }));
    mindbody.findClientAppointmentAt.mockResolvedValueOnce({ Id: 9200, StaffId: 5 });
    await payFirst.handlePaid(paidSession('cs_1'));
    await flush();
    expect(mindbody.addAppointment).toHaveBeenCalledTimes(1);
    expect(mockRows.get(501)).toMatchObject({ status: 'paid', mindbody_appointment_id: 9200 });
  });

  test('unclear answer and nothing found → stays "booking" with a flag for the sweep (no false "taken")', async () => {
    await bookAndPayLink();
    mindbody.addAppointment.mockRejectedValueOnce(Object.assign(new Error('502'), { code: 'BOOKING_OUTCOME_UNKNOWN' }));
    await payFirst.handlePaid(paidSession('cs_1'));
    await flush();
    expect(mockRows.get(501).status).toBe('booking');
    expect(db.logError).toHaveBeenCalledWith('pay_first_booking_state_unknown', expect.any(String), '', expect.any(String));
    expect(whatsapp.sendText).not.toHaveBeenCalled();
  });

  test('the therapist got booked meanwhile → another free therapist (guest chose "any")', async () => {
    await bookAndPayLink();
    const staffErr = Object.assign(new Error('400'), { response: { status: 400, data: { Error: { Message: 'Staff member is not available' } } } });
    mindbody.addAppointment.mockRejectedValueOnce(staffErr).mockResolvedValueOnce({ Id: 9300, StaffId: 6 });
    mindbody.findAvailableStaffForTime.mockResolvedValue([6]);
    await payFirst.handlePaid(paidSession('cs_1'));
    await flush();
    expect(mindbody.addAppointment.mock.calls[1][0].staffId).toBe(6);
    expect(mockRows.get(501).status).toBe('paid');
  });

  test('after a switch, the guest is told the therapist who was ACTUALLY booked', async () => {
    await bookAndPayLink();
    const staffErr = Object.assign(new Error('400'), { response: { status: 400, data: { Error: { Message: 'Staff member is not available' } } } });
    mindbody.addAppointment.mockRejectedValueOnce(staffErr).mockResolvedValueOnce({ Id: 9301, StaffId: 6 });
    mindbody.findAvailableStaffForTime.mockResolvedValue([6]);
    await payFirst.handlePaid(paidSession('cs_1'));
    await flush();
    expect(whatsapp.sendText).toHaveBeenCalledWith(PHONE, expect.stringMatching(/with Emma/));
    expect(whatsapp.sendText).not.toHaveBeenCalledWith(PHONE, expect.stringMatching(/with Lisa/));
  });

  test('a therapist the guest CHOSE got booked meanwhile → paid, not booked (team), never swapped', async () => {
    await bookAndPayLink(START, { therapistChoice: 5 });
    const staffErr = Object.assign(new Error('400'), { response: { status: 400, data: { Error: { Message: 'Staff member is not available' } } } });
    mindbody.addAppointment.mockRejectedValueOnce(staffErr);
    await payFirst.handlePaid(paidSession('cs_1'));
    await flush();
    expect(mindbody.addAppointment).toHaveBeenCalledTimes(1);
    expect(mockRows.get(501)).toMatchObject({ status: 'paid_unbooked', cancel_reason: 'therapist_taken' });
  });

  test('rooms taken → paid, not booked: team alerted, guest told honestly, no new payment asked', async () => {
    await bookAndPayLink();
    mindbody.addAppointment.mockRejectedValueOnce(Object.assign(new Error('No room free'), { code: 'ROOM_UNAVAILABLE' }));
    await payFirst.handlePaid(paidSession('cs_1'));
    await flush();
    expect(mockRows.get(501)).toMatchObject({ status: 'paid_unbooked', cancel_reason: 'room_taken' });
    expect(db.markConversationEscalated).toHaveBeenCalledWith(PHONE, expect.stringMatching(/PAID, NOT BOOKED/));
    expect(email.sendEscalationEmail).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/dashboard.stripe.com\/payments\/pi_cs_1/) }));
    expect(whatsapp.sendText).toHaveBeenCalledWith(PHONE, expect.stringMatching(/No need to pay again/));
    expect(payFirst._roomBlocks.length).toBe(1);
  });

  test('a payment arriving minutes before the start is not booked automatically', async () => {
    const soonish = inMinutes(50);
    await bookAndPayLink(soonish);
    mockRows.get(501).pay_first.startDateTime = inMinutes(3); // time passed while paying
    await payFirst.handlePaid(paidSession('cs_1'));
    await flush();
    expect(mindbody.addAppointment).not.toHaveBeenCalled();
    expect(mockRows.get(501)).toMatchObject({ status: 'paid_unbooked', cancel_reason: 'too_late' });
  });

  test('a session that completed unpaid is flagged, not booked', async () => {
    await bookAndPayLink();
    await payFirst.handlePaid(paidSession('cs_1', { payment_status: 'unpaid' }));
    expect(mindbody.addAppointment).not.toHaveBeenCalled();
    expect(db.logError).toHaveBeenCalledWith('pay_first_completed_unpaid', expect.any(String), '', expect.any(String));
  });

  test('a session that is not pay-first is left to the normal handler', async () => {
    const res = await payFirst.handlePaid({ id: 'cs_legacy', payment_status: 'paid', metadata: {} });
    expect(res.handled).toBe(false);
  });
});

describe('expiry, refunds and the safety sweep', () => {
  test('an expired link is marked and the guest told once (with the feedback offer)', async () => {
    await bookAndPayLink();
    await payFirst.handleExpired({ id: 'cs_1', metadata: { pay_first: 'true' } });
    expect(mockRows.get(501).status).toBe('expired');
    expect(whatsapp.sendCTAButton).toHaveBeenCalledWith(PHONE, expect.stringMatching(/expired, so nothing was booked/), 'Give feedback', expect.any(String));
    whatsapp.sendCTAButton.mockClear();
    await payFirst.handleExpired({ id: 'cs_1', metadata: { pay_first: 'true' } });
    expect(whatsapp.sendCTAButton).not.toHaveBeenCalled();
  });

  test('no expiry message while the team is talking to the guest', async () => {
    await bookAndPayLink();
    db.isHumanHandling.mockResolvedValue(true);
    await payFirst.handleExpired({ id: 'cs_1', metadata: { pay_first: 'true' } });
    expect(mockRows.get(501).status).toBe('expired');
    expect(whatsapp.sendCTAButton).not.toHaveBeenCalled();
  });

  test('a refund in Stripe closes a paid-not-booked row', async () => {
    await bookAndPayLink();
    Object.assign(mockRows.get(501), { status: 'paid_unbooked', stripe_payment_intent: 'pi_x' });
    await payFirst.handleRefund({ payment_intent: 'pi_x', refunded: true, amount: 13000, amount_refunded: 13000 });
    expect(mockRows.get(501).status).toBe('refunded');
  });

  test('sweep: a paid session whose webhook never came is booked', async () => {
    await bookAndPayLink();
    mockRows.get(501).created_at = new Date(Date.now() - 10 * 60000).toISOString();
    payments.getSessionDetails.mockResolvedValue({ status: 'complete', paymentStatus: 'paid', paymentIntent: 'pi_late', amountTotal: 13000 });
    await payFirst.sweep();
    expect(mockRows.get(501)).toMatchObject({ status: 'paid', mindbody_appointment_id: 9100 });
    expect(db.logError).toHaveBeenCalledWith('pay_first_webhook_missed', expect.any(String), '', expect.any(String));
  });

  test('sweep: a booking left half-way (restart) is found in Mindbody and confirmed', async () => {
    await bookAndPayLink();
    Object.assign(mockRows.get(501), { status: 'booking', paid_at: new Date(Date.now() - 10 * 60000).toISOString() });
    mockRows.get(501).pay_first.attempts = 1;
    mindbody.findClientAppointmentAt.mockResolvedValueOnce({ Id: 9400, StaffId: 5 });
    await payFirst.sweep();
    expect(mockRows.get(501)).toMatchObject({ status: 'paid', mindbody_appointment_id: 9400 });
    expect(mindbody.addAppointment).not.toHaveBeenCalled();
  });

  test('sweep: an expired session is closed and the guest told', async () => {
    await bookAndPayLink();
    mockRows.get(501).created_at = new Date(Date.now() - 40 * 60000).toISOString();
    payments.getSessionDetails.mockResolvedValue({ status: 'expired', paymentStatus: 'unpaid' });
    await payFirst.sweep();
    expect(mockRows.get(501).status).toBe('expired');
    expect(whatsapp.sendCTAButton).toHaveBeenCalledWith(PHONE, expect.stringMatching(/expired/), 'Give feedback', expect.any(String));
  });

  test('the team can mark a paid-not-booked row as rebooked', async () => {
    await bookAndPayLink();
    mockRows.get(501).status = 'paid_unbooked';
    expect(await payFirst.resolvePaidUnbooked(501, { resolution: 'rebooked', appointmentId: '9500' })).toEqual({ ok: true });
    expect(mockRows.get(501)).toMatchObject({ status: 'paid', mindbody_appointment_id: 9500 });
  });

  test('the model sees the live state in its Session line', async () => {
    await bookAndPayLink();
    expect(await payFirst.statusLine(PHONE)).toMatch(/Tailored Massage 60 min, .* AWAITING PAYMENT/);
  });
});

describe('offered times', () => {
  test('no pay-first time within the hour is offered; other treatments are untouched', async () => {
    const soon = inMinutes(40);
    const later = inMinutes(180);
    const res = await payFirst.filterOfferedSlots(PHONE, [
      { dateTime: soon, sessionTypeId: 31, staffId: 5 },
      { dateTime: later, sessionTypeId: 31, staffId: 5 },
      { dateTime: soon, sessionTypeId: 58, staffId: 0 },
    ]);
    expect(res.slots.map(s => `${s.sessionTypeId}@${s.dateTime}`)).toEqual([`31@${later}`, `58@${soon}`]);
    expect(res.hiddenByLead).toBe(1);
  });

  test('a time whose rooms are all taken is not offered', async () => {
    const t = inMinutes(24 * 60);
    const s = new Date(t).getTime();
    mindbody.getRoomOccupancy.mockResolvedValue({ known: true, busy: new Map([[1, [{ start: s, end: s + 70 * 60000 }]]]) });
    const res = await payFirst.filterOfferedSlots(PHONE, [{ dateTime: t, sessionTypeId: 41, staffId: 9 }]);
    expect(res.slots).toEqual([]);
  });
});
