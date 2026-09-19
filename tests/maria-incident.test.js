// Regression suite for the "Maria" conversation (Sept 2026) — a sauna + two
// floats that took five confirmations, promised a float slot that never
// existed, told the customer twice to pay at reception and then demanded
// online payment within 10 minutes, and finally released her bookings while
// she was asking for a human and trying to pay.
//
// Each block pins one failure from that transcript:
//  1. one Confirm must cover the whole multi-treatment summary (not just the
//     first booking), stay bounded, and close at the next agent turn
//  2. an order of 2+ treatments totalling €150+ goes to the TEAM (owner
//     decision) instead of being booked and hit with an upfront payment; the
//     old auto-prepay survives only as an announced backstop
//  3. an invented time (17:30 on a 90-min float grid) is rejected with the real
//     times of that day, so the model can recover honestly in one step
//  4. while a human is handling the customer, the automation neither ambushes
//     them with a threshold link nor releases their bookings at T+15

jest.mock('stripe', () => jest.fn().mockImplementation(() => ({
  checkout: { sessions: { create: jest.fn(), expire: jest.fn() } },
  webhooks: { constructEvent: jest.fn() },
})));
jest.mock('../src/services/whatsapp.service', () => ({
  sendText: jest.fn().mockResolvedValue({}),
  sendButtons: jest.fn().mockResolvedValue({}),
  sendList: jest.fn().mockResolvedValue({}),
  sendCTAButton: jest.fn().mockResolvedValue({}),
  sendImage: jest.fn().mockResolvedValue({}),
}));
jest.mock('../src/services/email.service', () => ({
  sendCancellationNotificationEmail: jest.fn().mockResolvedValue({}),
  sendRefundNotificationEmail: jest.fn().mockResolvedValue({}),
  sendEscalationEmail: jest.fn().mockResolvedValue({}),
}));
jest.mock('../src/services/gift-card-check.service', () => ({}));
jest.mock('../src/services/mindbody.service', () => ({
  getClientByPhone: jest.fn(),
  addAppointment: jest.fn(),
  cancelAppointment: jest.fn().mockResolvedValue({}),
  isBenignCancelError: jest.fn().mockReturnValue(false),
  findAvailableStaffForTime: jest.fn().mockResolvedValue([]),
}));
jest.mock('../src/data/database', () => ({
  logBookingEvent: jest.fn(),
  updateBookingEvent: jest.fn().mockResolvedValue({}),
  updateBookingEventIfStatus: jest.fn().mockResolvedValue(true),
  getRecentBooking: jest.fn().mockResolvedValue(null),
  getBookingEventById: jest.fn(),
  getBookingEventByAppointment: jest.fn().mockResolvedValue(null),
  tombstoneByAppointment: jest.fn().mockResolvedValue(0),
  getPendingStripeSessionByAppointment: jest.fn().mockResolvedValue(null),
  markConversationEscalated: jest.fn(),
  isHumanHandling: jest.fn().mockResolvedValue(false),
  getOpenJourneyForDay: jest.fn().mockResolvedValue({ count: 0, totalCents: 0 }),
  saveConversationState: jest.fn().mockResolvedValue(undefined),
  logMessage: jest.fn().mockResolvedValue({}),
  logError: jest.fn().mockResolvedValue(true),
  query: jest.fn().mockResolvedValue({ rows: [] }),
}));
jest.mock('../src/services/payment.service', () => ({
  ...jest.requireActual('../src/services/payment.service'),
  createCombinedPaymentLink: jest.fn(),
  createPaymentLink: jest.fn(),
  expireSession: jest.fn().mockResolvedValue(true),
  getSessionStatus: jest.fn().mockResolvedValue({ status: 'open', paymentStatus: 'unpaid' }),
}));

const mindbody = require('../src/services/mindbody.service');
const payments = require('../src/services/payment.service');
const db = require('../src/data/database');
const conversations = require('../src/services/conversation.service');
const email = require('../src/services/email.service');
const whatsapp = require('../src/services/whatsapp.service');
const {
  toolBookAppointment,
  scheduleAutoPaymentLink,
  schedulePaymentTimeline,
  cancelAutoPaymentLink,
  closeUsedConfirmation,
} = require('../src/agents/tool-implementations');

const PHONE = '31633333333';
const SAUNA_2P = 69;     // €80, pay-on-location
const FLOAT = 58;        // €80, pay-on-location
const MASSAGE_60 = 31;   // €130, pay-online
const MASSAGE_80 = 32;   // €170, pay-online — over the team threshold on its own
const RED_LIGHT = 64;    // €45, pay-on-location
const HYDROWAVE = 80;    // €30, pay-on-location
const DAY = '2026-09-20';
const CLIENT = { Id: 7, FirstName: 'Maria', LastName: 'T', Email: 'maria@example.com' };

const TEAM_THRESHOLD = payments.JOURNEY_TEAM_THRESHOLD_CENTS; // €150

const offer = (sessionTypeId, time) => ({ sessionTypeId, dateTime: `${DAY}T${time}:00` });

/** The handler's Confirm-tap effect, plus the slots she was genuinely offered. */
function tapConfirm(offeredSlots) {
  conversations.set(PHONE, {
    lang: 'en',
    bookingConfirmedAt: Date.now(),
    bookingConfirmUsed: false,
    bookingsUnderConfirm: 0,
    ...(offeredSlots ? { offeredSlots } : {}),
  });
}

const book = (session_type_id, time) => toolBookAppointment(PHONE, {
  session_type_id, start_date_time: `${DAY}T${time}:00`,
  client_name: 'Maria T', client_email: 'maria@example.com',
});

async function flush(n = 8) { for (let i = 0; i < n; i++) await Promise.resolve(); }

let nextAptId;
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  conversations.clear(PHONE);
  cancelAutoPaymentLink(PHONE);
  nextAptId = 9000;
  mindbody.getClientByPhone.mockResolvedValue(CLIENT);
  mindbody.addAppointment.mockImplementation(async () => ({ Id: ++nextAptId }));
  db.logBookingEvent.mockImplementation(async () => 500 + nextAptId);
  db.isHumanHandling.mockResolvedValue(false);
  db.logError.mockResolvedValue(true);
  db.getOpenJourneyForDay.mockResolvedValue({ count: 0, totalCents: 0 });
  payments.JOURNEY_TEAM_THRESHOLD_CENTS = TEAM_THRESHOLD;
  db.getBookingEventById.mockImplementation(async (id) => ({ id, status: 'pending' }));
  db.getBookingEventByAppointment.mockResolvedValue(null);
  db.updateBookingEventIfStatus.mockResolvedValue(true);
  payments.createCombinedPaymentLink.mockResolvedValue({ sessionId: 'cs_new', paymentUrl: 'https://pay.stripe.test/cs_new' });
  payments.getSessionStatus.mockResolvedValue({ status: 'open', paymentStatus: 'unpaid' });
});
afterEach(() => {
  cancelAutoPaymentLink(PHONE);
  jest.useRealTimers();
});

describe('1. one Confirm covers the whole confirmed summary', () => {
  // Combos here stay under €150 so the team threshold (section 2) is not in play.
  test('float + red light book under a single Confirm in the same turn — no re-confirmation', async () => {
    tapConfirm([offer(FLOAT, '15:00'), offer(RED_LIGHT, '16:30')]);

    const float1 = await book(FLOAT, '15:00');
    const redLight = await book(RED_LIGHT, '16:30');

    expect(float1.success).toBe(true);
    expect(redLight.success).toBe(true);
    expect(redLight.error).toBeUndefined();
    expect(mindbody.addAppointment).toHaveBeenCalledTimes(2);
  });

  test('the used gate closes at the next agent turn — a later booking needs a new Confirm', async () => {
    tapConfirm([offer(FLOAT, '15:00'), offer(RED_LIGHT, '16:30')]);
    await book(FLOAT, '15:00');

    closeUsedConfirmation(PHONE); // what agent.run does when the next message arrives

    const later = await book(RED_LIGHT, '16:30');
    expect(later.error).toBe('confirmation_required');
    expect(mindbody.addAppointment).toHaveBeenCalledTimes(1);
  });

  test('an UNUSED confirmation survives the turn sweep (customer still answering a question)', async () => {
    tapConfirm([offer(FLOAT, '16:30')]);
    closeUsedConfirmation(PHONE); // nothing was booked yet → gate must stay open
    const result = await book(FLOAT, '16:30');
    expect(result.success).toBe(true);
  });

  test('a single Confirm is bounded: the 4th booking under it is refused (journey cap fires first)', async () => {
    const times = ['09:00', '10:30', '12:00', '13:30'];
    tapConfirm(times.map(t => offer(HYDROWAVE, t)));
    const results = [];
    for (const t of times) results.push(await book(HYDROWAVE, t));

    expect(results.slice(0, 3).every(r => r.success)).toBe(true);
    // The journey cap (4+ treatments → team arranges it) is checked before the
    // confirmation gate, so it answers first; the gate's own cap is the backstop.
    expect(results[3].error).toBe('too_many_treatments');
    expect(mindbody.addAppointment).toHaveBeenCalledTimes(3);
  });
});

describe('2. an order of 2+ treatments totalling €150+ goes to the team', () => {
  test("Maria's order: sauna €80 books, the float that makes it €160 is routed to the team — not booked", async () => {
    tapConfirm([offer(SAUNA_2P, '15:45'), offer(FLOAT, '16:30')]);

    const sauna = await book(SAUNA_2P, '15:45');
    expect(sauna.success).toBe(true);
    expect(sauna.payOnLocation).toBe(true);

    const float1 = await book(FLOAT, '16:30');
    expect(float1.error).toBe('journey_needs_team');
    expect(float1.journey_total).toBe('€160');
    expect(float1.team_threshold).toBe('€150');
    expect(float1.message).toMatch(/request_human_handoff/);
    expect(mindbody.addAppointment).toHaveBeenCalledTimes(1); // only the sauna
  });

  test('a SINGLE treatment is always bookable, even above €150 (80-min massage €170)', async () => {
    tapConfirm([offer(MASSAGE_80, '14:00')]);
    const massage = await book(MASSAGE_80, '14:00');
    expect(massage.success).toBe(true);
    expect(massage.error).toBeUndefined();
  });

  test('a small combo stays with the bot (float €80 + red light €45 = €125)', async () => {
    tapConfirm([offer(FLOAT, '15:00'), offer(RED_LIGHT, '16:30')]);
    expect((await book(FLOAT, '15:00')).success).toBe(true);
    expect((await book(RED_LIGHT, '16:30')).success).toBe(true);
  });

  test('the gate fires on the treatment that takes the order over the line (€125 → €155 on the third)', async () => {
    // sauna €80 + red light €45 = €125 (under), then hydrowave €30 → €155 (over).
    tapConfirm([offer(SAUNA_2P, '10:00'), offer(RED_LIGHT, '11:30'), offer(HYDROWAVE, '12:00')]);
    expect((await book(SAUNA_2P, '10:00')).success).toBe(true);
    expect((await book(RED_LIGHT, '11:30')).success).toBe(true);
    const third = await book(HYDROWAVE, '12:00');
    expect(third.error).toBe('journey_needs_team');
    expect(third.journey_total).toBe('€155');
  });

  test('the order is still recognised after the 30-min memory TTL — via the same-day open bookings', async () => {
    // Cart is gone (fresh conversation), but the DB knows she already holds an €80 sauna that day.
    db.getOpenJourneyForDay.mockResolvedValue({ count: 1, totalCents: 8000 });
    tapConfirm([offer(FLOAT, '16:30')]);

    const float1 = await book(FLOAT, '16:30');

    expect(db.getOpenJourneyForDay).toHaveBeenCalledWith(PHONE, `${DAY}T16:30:00`);
    expect(float1.error).toBe('journey_needs_team');
    expect(mindbody.addAppointment).not.toHaveBeenCalled();
  });

  test('a failing same-day lookup fails OPEN — the cart alone decides, a first booking still works', async () => {
    db.getOpenJourneyForDay.mockRejectedValue(new Error('db down'));
    tapConfirm([offer(FLOAT, '16:30')]);
    const float1 = await book(FLOAT, '16:30');
    expect(float1.success).toBe(true);
  });

  test('backstop: if the team gate is lifted, the old auto-prepay is ANNOUNCED, never sprung', async () => {
    payments.JOURNEY_TEAM_THRESHOLD_CENTS = Number.MAX_SAFE_INTEGER; // e.g. tuned via env
    tapConfirm([offer(SAUNA_2P, '15:45'), offer(FLOAT, '16:30')]);

    const sauna = await book(SAUNA_2P, '15:45');
    expect(sauna.payOnLocation).toBe(true);
    expect(sauna.prepayRequired).toBeUndefined();

    const float1 = await book(FLOAT, '16:30');
    expect(float1.prepayRequired).toBe(true);
    expect(float1.deferred).toBe(true);
    expect(float1.payOnLocation).toBeUndefined(); // must NOT trigger the "no online payment needed" reply
    expect(float1.journey_total).toBe('€160');
  });
});

describe('3. an invented time is rejected with the real times of that day', () => {
  test('17:30 float (never offered) → slot_not_offered listing the real slots; nothing booked', async () => {
    tapConfirm([offer(FLOAT, '09:00'), offer(FLOAT, '12:00'), offer(FLOAT, '13:30')]);

    const result = await book(FLOAT, '17:30');

    expect(result.error).toBe('slot_not_offered');
    expect(result.real_times_that_day).toEqual(['09:00', '12:00', '13:30']);
    expect(result.message).toMatch(/17:30/);
    expect(result.message).toMatch(/09:00, 12:00, 13:30/);
    expect(mindbody.addAppointment).not.toHaveBeenCalled();
  });
});

describe('4. human takeover pauses the payment automation', () => {
  const seedCart = (items) => conversations.set(PHONE, { lang: 'en', pendingBookings: items });
  const floatItem = { booking_event_id: 1, appointment_id: 9001, session_type_id: FLOAT, service_name: 'Float', amount_cents: 8000, pay_on_location: true };
  const saunaItem = { booking_event_id: 2, appointment_id: 9002, session_type_id: SAUNA_2P, service_name: 'Finnish Sauna', amount_cents: 8000, pay_on_location: true };
  const massageItem = { booking_event_id: 3, appointment_id: 9003, session_type_id: MASSAGE_60, service_name: 'Tailored Massage', amount_cents: 13000 };

  test('threshold-only journey + human handling → NO auto link, flagged for the team', async () => {
    db.isHumanHandling.mockResolvedValue(true);
    seedCart([floatItem, saunaItem]); // €160, all pay-on-location

    scheduleAutoPaymentLink(PHONE);
    jest.advanceTimersByTime(5 * 60 * 1000);
    await flush();

    expect(payments.createCombinedPaymentLink).not.toHaveBeenCalled();
    expect(whatsapp.sendCTAButton).not.toHaveBeenCalled();
    expect(db.logError).toHaveBeenCalledWith('autobill_skipped_human_takeover', expect.any(String), '', expect.any(String));
  });

  test('a cart with a true pay-online item still gets its link under human handling', async () => {
    db.isHumanHandling.mockResolvedValue(true);
    payments.createCombinedPaymentLink.mockResolvedValue({ paymentUrl: 'https://pay.example/x', sessionId: 'cs_1' });
    seedCart([massageItem]);

    scheduleAutoPaymentLink(PHONE);
    jest.advanceTimersByTime(5 * 60 * 1000);
    await flush(12);

    expect(payments.createCombinedPaymentLink).toHaveBeenCalledTimes(1);
  });

  test('T+15 under human handling: bookings are HELD (needs_review + team email), never released', async () => {
    db.isHumanHandling.mockResolvedValue(true);
    db.getBookingEventByAppointment.mockImplementation(async (aptId) => ({ id: 700 + aptId, status: 'payment_sent' }));
    conversations.set(PHONE, { lang: 'en', userName: 'Maria' });

    schedulePaymentTimeline(PHONE, 'cs_hold', 'https://pay.example/hold', [9001, 9002]);
    jest.advanceTimersByTime(15 * 60 * 1000);
    await flush(20);

    expect(mindbody.cancelAppointment).not.toHaveBeenCalled();
    expect(db.updateBookingEvent).toHaveBeenCalledWith(700 + 9001, { status: 'needs_review' });
    expect(db.updateBookingEvent).toHaveBeenCalledWith(700 + 9002, { status: 'needs_review' });
    expect(email.sendEscalationEmail).toHaveBeenCalledTimes(1);
    expect(email.sendEscalationEmail.mock.calls[0][0].message).toMatch(/PAYMENT ON HOLD/);
    // no deadline pressure and no "booking wasn't completed" feedback invite
    expect(whatsapp.sendCTAButton).not.toHaveBeenCalled();
    expect(payments.expireSession).not.toHaveBeenCalled();
  });

  test('T+15 hold never parks a row it could not flag — falls back to the normal release', async () => {
    db.isHumanHandling.mockResolvedValue(true);
    db.logError.mockResolvedValue(false); // flag write lost
    db.getBookingEventByAppointment.mockResolvedValue({ id: 701, status: 'payment_sent' });
    conversations.set(PHONE, { lang: 'en' });

    schedulePaymentTimeline(PHONE, 'cs_noflag', 'https://pay.example/n', [9001]);
    jest.advanceTimersByTime(15 * 60 * 1000);
    await flush(20);

    expect(db.updateBookingEvent).not.toHaveBeenCalledWith(701, { status: 'needs_review' });
    expect(mindbody.cancelAppointment).toHaveBeenCalledWith(9001);
  });

  test('without human handling the timeline behaves exactly as before (release at T+15)', async () => {
    db.getBookingEventByAppointment.mockResolvedValue({ id: 702, status: 'payment_sent' });
    conversations.set(PHONE, { lang: 'en' });

    schedulePaymentTimeline(PHONE, 'cs_normal', 'https://pay.example/ok', [9001]);
    jest.advanceTimersByTime(15 * 60 * 1000);
    await flush(20);

    expect(mindbody.cancelAppointment).toHaveBeenCalledWith(9001);
    expect(email.sendEscalationEmail).not.toHaveBeenCalled();
  });
});
