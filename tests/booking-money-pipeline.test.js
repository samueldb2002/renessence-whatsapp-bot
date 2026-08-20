// The money pipeline's PRODUCERS, tested through the real toolBookAppointment
// and billPendingBookings — not hand-seeded carts.
//
// These tests encode the confirmed findings of the adversarial audit:
//  #1/#5  a model re-fire of book_appointment for a paid/billed booking used to
//         re-arm auto-billing → double charge, or the duplicate link's timeline
//         cancelling an appointment the customer paid for
//  #3     the auto-bill timer racing send_payment could mint two Stripe sessions
//  #7     nothing_to_pay left the cart populated → re-billed later journeys and
//         falsely tripped the 3-treatment cap
//  #8     a late "Send payment link" tap after the auto-link went out denied
//         that money was owed
//  #9     none of the cart-recording branches had tests at all

jest.mock('stripe', () => jest.fn().mockImplementation(() => ({
  checkout: { sessions: { create: jest.fn(), expire: jest.fn() } },
  webhooks: { constructEvent: jest.fn() },
})));

jest.mock('../src/services/whatsapp.service', () => ({
  sendText: jest.fn().mockResolvedValue({}),
  sendButtons: jest.fn().mockResolvedValue({}),
  sendList: jest.fn().mockResolvedValue({}),
  sendCTAButton: jest.fn().mockResolvedValue({}),
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
  addClientToClass: jest.fn().mockResolvedValue({}),
  removeClientFromClass: jest.fn().mockResolvedValue({}),
  cancelAppointment: jest.fn().mockResolvedValue({}),
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
  logMessage: jest.fn().mockResolvedValue({}),
  logError: jest.fn(),
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
  toolBookClass,
  toolSendPayment,
  toolCancelAppointments,
  billPendingBookings,
  cancelAutoPaymentLink,
} = require('../src/agents/tool-implementations');

const PHONE = '31622222222';
const MASSAGE_60 = 31;   // €130, pay-online
const FLOAT = 58;        // €80, pay-on-location
const START = '2026-08-25T14:00:00';

const CLIENT = { Id: 7, FirstName: 'Test', LastName: 'Guest', Email: 'guest@example.com' };

function cart() { return conversations.get(PHONE)?.pendingBookings || []; }

/** The customer tapped Confirm — required before any fresh booking. */
function confirmed() { conversations.set(PHONE, { lang: 'en', bookingConfirmedAt: Date.now() }); }

async function advanceToAutoBill() {
  jest.advanceTimersByTime(5 * 60 * 1000);
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  conversations.clear(PHONE);
  mindbody.getClientByPhone.mockResolvedValue(CLIENT);
  mindbody.addAppointment.mockResolvedValue({ Id: 9001 });
  db.logBookingEvent.mockResolvedValue(501);
  db.getRecentBooking.mockResolvedValue(null);
  db.getBookingEventById.mockResolvedValue({ id: 501, status: 'pending' });
  db.updateBookingEventIfStatus.mockResolvedValue(true);
  db.tombstoneByAppointment.mockResolvedValue(0);
  mindbody.removeClientFromClass.mockResolvedValue({});
  mindbody.cancelAppointment.mockResolvedValue({});
  payments.createPaymentLink.mockResolvedValue({ sessionId: 'cs_class', paymentUrl: 'https://pay.stripe.test/cs_class' });
  payments.expireSession.mockClear();
  payments.createCombinedPaymentLink.mockResolvedValue({
    sessionId: 'cs_new', paymentUrl: 'https://pay.stripe.test/cs_new',
  });
});

afterEach(() => {
  cancelAutoPaymentLink(PHONE);
  jest.useRealTimers();
});

// ── #9: the cart-recording branches themselves ────────────────────────────────

describe('toolBookAppointment records the cart (audit #9)', () => {
  test('a fresh pay-online booking lands in the cart and arms the auto-bill timer', async () => {
    confirmed();
    const result = await toolBookAppointment(PHONE, {
      session_type_id: MASSAGE_60, start_date_time: START,
      client_name: 'Test Guest', client_email: 'guest@example.com',
    });

    expect(result.deferred).toBe(true);
    expect(cart()).toEqual([expect.objectContaining({
      booking_event_id: 501, appointment_id: 9001,
      session_type_id: MASSAGE_60, amount_cents: 13000,
    })]);

    // Round-5: the appointment id and date ride the INSERT itself — a second
    // write could silently fail and leave the row invisible to every sweep.
    expect(db.logBookingEvent).toHaveBeenCalledWith(expect.objectContaining({
      appointmentDate: START,
      mindbodyAppointmentId: 9001,
    }));

    await advanceToAutoBill();
    expect(payments.createCombinedPaymentLink).toHaveBeenCalledTimes(1);
  });

  test('a fresh pay-on-location booking joins the cart flagged, with its real price', async () => {
    confirmed();
    const result = await toolBookAppointment(PHONE, {
      session_type_id: FLOAT, start_date_time: START,
      client_name: 'Test Guest', client_email: 'guest@example.com',
    });

    expect(result.payOnLocation).toBe(true);
    expect(cart()).toEqual([expect.objectContaining({
      session_type_id: FLOAT, amount_cents: 8000, pay_on_location: true,
    })]);
  });

  test('a reschedule (skip_payment) records nothing and never auto-bills', async () => {
    confirmed();
    await toolBookAppointment(PHONE, {
      session_type_id: FLOAT, start_date_time: START, skip_payment: true,
      client_name: 'Test Guest', client_email: 'guest@example.com',
    });

    expect(cart()).toEqual([]);
    await advanceToAutoBill();
    expect(payments.createCombinedPaymentLink).not.toHaveBeenCalled();
  });
});

// ── #1/#5: the re-fire branch must respect what already happened ──────────────

describe('re-fired book_appointment (audit #1/#5 — critical)', () => {
  function existingRow(status, extra = {}) {
    db.getRecentBooking.mockResolvedValue({
      id: 501, mindbody_appointment_id: 9001, status, ...extra,
    });
  }

  test('a re-fire for a PAID booking reports already_paid and never re-bills', async () => {
    existingRow('paid');
    const result = await toolBookAppointment(PHONE, {
      session_type_id: MASSAGE_60, start_date_time: START,
    });

    expect(result.already_booked).toBe(true);
    expect(result.already_paid).toBe(true);
    expect(result.requiresPayment).toBe(false);
    expect(result.deferred).toBeUndefined();
    expect(cart()).toEqual([]);

    await advanceToAutoBill();
    expect(payments.createCombinedPaymentLink).not.toHaveBeenCalled();
  });

  test('a re-fire while a payment link is out reports the link, mints nothing new', async () => {
    existingRow('payment_sent', { stripe_session_id: 'cs_live' });
    conversations.set(PHONE, { lastBillingLink: { url: 'https://pay.stripe.test/cs_live', sessionId: 'cs_live', at: Date.now() } });

    const result = await toolBookAppointment(PHONE, {
      session_type_id: MASSAGE_60, start_date_time: START,
    });

    expect(result.already_booked).toBe(true);
    expect(result.payment_link_already_sent).toBe(true);
    expect(result.paymentUrl).toBe('https://pay.stripe.test/cs_live');
    expect(result.deferred).toBeUndefined();
    expect(cart()).toEqual([]);

    await advanceToAutoBill();
    expect(payments.createCombinedPaymentLink).not.toHaveBeenCalled();
  });

  test('a mismatched conversation link is NOT attached to a re-fire (two-journey chat)', async () => {
    // lastBillingLink is conversation-global; booking 1's re-fire must not
    // point the customer at journey 2's link (verify finding: refire residual).
    existingRow('payment_sent', { stripe_session_id: 'cs_journey1' });
    conversations.set(PHONE, { lastBillingLink: { url: 'https://pay.stripe.test/cs_journey2', sessionId: 'cs_journey2', at: Date.now() } });

    const result = await toolBookAppointment(PHONE, {
      session_type_id: MASSAGE_60, start_date_time: START,
    });

    expect(result.payment_link_already_sent).toBe(true);
    expect(result.paymentUrl).toBeUndefined();
  });

  test('a prepaid pay-on-location re-fire is not answered with "pay at reception"', async () => {
    // A float billed as part of an over-threshold journey has a payment_sent
    // row; re-firing it must follow the payment state, not the treatment kind.
    existingRow('payment_sent', { stripe_session_id: 'cs_live' });

    const result = await toolBookAppointment(PHONE, {
      session_type_id: FLOAT, start_date_time: START,
    });

    expect(result.payment_link_already_sent).toBe(true);
    expect(result.payOnLocation).toBeUndefined();
  });

  test('a re-fire for a still-unbilled booking keeps working as before', async () => {
    existingRow('pending');
    const result = await toolBookAppointment(PHONE, {
      session_type_id: MASSAGE_60, start_date_time: START,
    });

    expect(result.deferred).toBe(true);
    expect(cart()).toHaveLength(1);
  });
});

// ── Billing verifies the DB before taking money ───────────────────────────────

describe('billPendingBookings verifies row status (audit #1/#2)', () => {
  function seedCart(items) {
    conversations.set(PHONE, { lang: 'en', pendingBookings: items });
  }
  const item = (id, sessionType, cents) => ({
    booking_event_id: id, appointment_id: 9000 + id,
    session_type_id: sessionType, service_name: `svc-${id}`,
    date_time_label: 'x', amount_cents: cents,
  });

  test('an item whose row is already paid is dropped before billing', async () => {
    seedCart([item(1, MASSAGE_60, 13000), item(2, MASSAGE_60, 13000)]);
    db.getBookingEventById.mockImplementation(async id =>
      id === 1 ? { id, status: 'paid' } : { id, status: 'pending' });

    await billPendingBookings(PHONE, {});

    const billed = payments.createCombinedPaymentLink.mock.calls[0][0].items;
    expect(billed.map(b => b.bookingEventId)).toEqual([2]);
  });

  test('an item whose row was expired/cancelled (e.g. by the cron) is dropped', async () => {
    seedCart([item(1, MASSAGE_60, 13000)]);
    db.getBookingEventById.mockResolvedValue({ id: 1, status: 'expired' });

    const result = await billPendingBookings(PHONE, {});

    expect(payments.createCombinedPaymentLink).not.toHaveBeenCalled();
    expect(result.nothing_to_pay).toBe(true);
  });

  test('an unverifiable item (DB error) POSTPONES billing — cart intact, retry armed', async () => {
    // Dropping it would resolve the journey and skip a legitimate charge
    // forever (verify finding: db-verify). Postpone and retry instead.
    seedCart([item(1, MASSAGE_60, 13000)]);
    db.getBookingEventById.mockResolvedValue(null);

    const result = await billPendingBookings(PHONE, {});

    expect(payments.createCombinedPaymentLink).not.toHaveBeenCalled();
    expect(result.billing_deferred).toBe(true);
    expect(result.nothing_to_pay).toBeUndefined();
    expect(cart()).toHaveLength(1); // journey NOT resolved

    // The retry succeeds once the DB is reachable again.
    db.getBookingEventById.mockResolvedValue({ id: 1, status: 'pending' });
    await advanceToAutoBill();
    expect(payments.createCombinedPaymentLink).toHaveBeenCalledTimes(1);
  });

  test('a session write that cannot be confirmed expires the fresh session instead of circulating it', async () => {
    // The refire catastrophe resurrects through exactly one swallowed UPDATE:
    // link out, row still 'pending' with no session id. Never let that state
    // exist (verify finding: refire).
    seedCart([item(1, MASSAGE_60, 13000)]);
    db.updateBookingEventIfStatus.mockResolvedValue(null); // DB write unconfirmable

    const result = await billPendingBookings(PHONE, {});

    expect(payments.expireSession).toHaveBeenCalledWith('cs_new');
    expect(result.billing_deferred).toBe(true);
    expect(cart()).toHaveLength(1); // journey NOT resolved; retry re-verifies
  });

  test('a row the paid-webhook flipped mid-mint is not clobbered — session expired, nothing sent', async () => {
    seedCart([item(1, MASSAGE_60, 13000)]);
    db.updateBookingEventIfStatus.mockResolvedValue(false); // status changed underneath

    const result = await billPendingBookings(PHONE, {});

    expect(payments.expireSession).toHaveBeenCalledWith('cs_new');
    expect(result.paymentUrl).toBeUndefined();
  });

  test('a partial CAS failure rolls back the writes that DID land (round 3: cas-write)', async () => {
    // Without the rollback, item 1's row stays 'payment_sent' pointing at the
    // aborted session: the retry silently drops its legitimate charge, and
    // the aborted session's expiry event cancels its appointment.
    seedCart([item(1, MASSAGE_60, 13000), item(2, MASSAGE_60, 13000)]);
    db.updateBookingEventIfStatus.mockImplementation(async (id, allowed) => {
      if (allowed.includes('payment_sent')) return true; // the rollback write
      return id === 1; // mint CAS: item 1 lands, item 2 fails
    });

    await billPendingBookings(PHONE, {});

    expect(db.updateBookingEventIfStatus).toHaveBeenCalledWith(
      1, ['payment_sent'], { stripeSessionId: null, status: 'pending' }
    );
    expect(payments.expireSession).toHaveBeenCalledWith('cs_new');
  });

  test('postponement attempts accumulate to the manual-review flag (round 3: postpone)', async () => {
    // Resetting the counter pre-mint made the manual-review arm unreachable —
    // a persistent fault minted and killed a session every 5 min forever.
    seedCart([item(1, MASSAGE_60, 13000)]);
    db.updateBookingEventIfStatus.mockResolvedValue(null); // persistent write fault

    for (let i = 0; i < 4; i++) {
      await billPendingBookings(PHONE, {});
      cancelAutoPaymentLink(PHONE);
    }

    expect(db.logError).toHaveBeenCalledWith(
      'billing_postponed_repeatedly', expect.stringContaining('MANUAL REVIEW'), '', expect.any(String)
    );
  });

  test('a rowless cart item is never billed and never tips the threshold (round 3: paid-guards)', async () => {
    // No audit row = outside every guard: it stays desk-payable, and its
    // amount must not push OTHER items into prepay.
    seedCart([
      { appointment_id: 333, session_type_id: FLOAT, service_name: 'Rowless Float', date_time_label: 'x', amount_cents: 8000, pay_on_location: true }, // no booking_event_id
      item(2, 30, 3000), // LED €30, pay-online, has a row
    ]);
    db.getBookingEventById.mockResolvedValue({ id: 2, status: 'pending' });

    await billPendingBookings(PHONE, {});

    const billed = payments.createCombinedPaymentLink.mock.calls[0][0].items;
    expect(billed.map(b => b.serviceName)).toEqual(['svc-2']); // LED only, float excluded
  });

  test('a web-chat postponement asks the customer to retry — no false auto-follow promise', async () => {
    const web = 'web_round3';
    conversations.set(web, {
      lang: 'en',
      pendingBookings: [{ booking_event_id: 1, appointment_id: 9001, session_type_id: MASSAGE_60, service_name: 'M', date_time_label: 'x', amount_cents: 13000 }],
    });
    db.getBookingEventById.mockResolvedValue(null); // unverifiable

    const result = await billPendingBookings(web, {});

    expect(result.billing_deferred).toBe(true);
    expect(result.message).toContain('request the payment link again');
    expect(result.message).not.toContain('automatically');
    conversations.clear(web);
  });
});

// ── #3: only one Stripe session per cart, ever ────────────────────────────────

describe('billing lock (audit #3)', () => {
  test('concurrent billing calls share one Stripe session', async () => {
    conversations.set(PHONE, {
      lang: 'en',
      pendingBookings: [{
        booking_event_id: 501, appointment_id: 9001, session_type_id: MASSAGE_60,
        service_name: 'Tailored Massage', date_time_label: 'x', amount_cents: 13000,
      }],
    });

    const [a, b] = await Promise.all([
      billPendingBookings(PHONE, {}),
      toolSendPayment(PHONE, {}),
    ]);

    expect(payments.createCombinedPaymentLink).toHaveBeenCalledTimes(1);
    expect(a.paymentUrl).toBe(b.paymentUrl);
  });
});

// ── #7/#8: a resolved journey ends cleanly ────────────────────────────────────

describe('journey resolution (audit #7/#8)', () => {
  test('nothing_to_pay clears the cart so the journey truly ends', async () => {
    conversations.set(PHONE, {
      lang: 'en',
      pendingBookings: [{
        booking_event_id: 501, appointment_id: 9001, session_type_id: FLOAT,
        service_name: 'Float Journey', date_time_label: 'x', amount_cents: 8000,
        pay_on_location: true,
      }],
    });
    db.getBookingEventById.mockResolvedValue({ id: 501, status: 'pay_on_location' });

    const result = await billPendingBookings(PHONE, {});

    expect(result.nothing_to_pay).toBe(true);
    expect(cart()).toEqual([]);
  });

  test('a late "Send payment link" tap after the auto-link re-shares it instead of denying money is owed', async () => {
    conversations.set(PHONE, {
      lang: 'en',
      pendingBookings: [],
      lastBillingLink: { url: 'https://pay.stripe.test/cs_auto', sessionId: 'cs_auto', at: Date.now() - 2 * 60 * 1000 },
    });

    const result = await toolSendPayment(PHONE, {});

    expect(result.payment_link_already_sent).toBe(true);
    expect(result.paymentUrl).toBe('https://pay.stripe.test/cs_auto');
    expect(payments.createCombinedPaymentLink).not.toHaveBeenCalled();
  });

  test('a PAID auto-link is never re-shared — the customer is not dunned after paying', async () => {
    // Verify finding journey-end path A: customer pays, then books a
    // sub-threshold float; the old code re-shared the paid link with a
    // "pay or we release your spot" threat.
    conversations.set(PHONE, {
      lang: 'en',
      pendingBookings: [{
        booking_event_id: 501, appointment_id: 9001, session_type_id: FLOAT,
        service_name: 'Float Journey', date_time_label: 'x', amount_cents: 8000,
        pay_on_location: true,
      }],
      lastBillingLink: { url: 'https://pay.stripe.test/cs_paid', sessionId: 'cs_paid', at: Date.now() - 3 * 60 * 1000 },
    });
    db.getBookingEventById.mockResolvedValue({ id: 501, status: 'pay_on_location' });
    payments.getSessionStatus.mockResolvedValue({ status: 'complete', paymentStatus: 'paid' });

    const result = await billPendingBookings(PHONE, {});

    expect(result.nothing_to_pay).toBe(true);
    expect(result.payment_link_already_sent).toBeUndefined();
    expect(result.paymentUrl).toBeUndefined();
    expect(conversations.get(PHONE).lastBillingLink).toBeNull(); // cleared
  });

  test('an EXPIRED link reports journey_expired, never "all set" or a dead link', async () => {
    // Verify finding journey-end path B: minutes 15-20, session expired and
    // bookings released — the bot must not re-share the dead link.
    conversations.set(PHONE, {
      lang: 'en',
      pendingBookings: [],
      lastBillingLink: { url: 'https://pay.stripe.test/cs_dead', sessionId: 'cs_dead', at: Date.now() - 17 * 60 * 1000 },
    });
    payments.getSessionStatus.mockResolvedValue({ status: 'expired', paymentStatus: 'unpaid' });

    const result = await toolSendPayment(PHONE, {});

    expect(result.journey_expired).toBe(true);
    expect(result.paymentUrl).toBeUndefined();
    expect(result.nothing_to_pay).toBeUndefined();
  });

  test('the T+15 fuse refuses to cancel an appointment whose row reads PAID', async () => {
    // Verify finding refire: an orphaned duplicate session's timeout must not
    // cancel the appointment the customer paid for via another session.
    conversations.set(PHONE, {
      lang: 'en',
      pendingBookings: [{
        booking_event_id: 501, appointment_id: 9001, session_type_id: MASSAGE_60,
        service_name: 'Tailored Massage', date_time_label: 'x', amount_cents: 13000,
      }],
    });

    await billPendingBookings(PHONE, {}); // arms the 15-min timeline for apt 9001

    payments.getSessionStatus.mockResolvedValue({ status: 'open', paymentStatus: 'unpaid' }); // this session unpaid...
    db.getBookingEventByAppointment.mockResolvedValue({ id: 501, status: 'paid' });          // ...but the ROW is paid

    jest.advanceTimersByTime(15 * 60 * 1000);
    for (let i = 0; i < 12; i++) await Promise.resolve();

    expect(mindbody.cancelAppointment).not.toHaveBeenCalled();
  });

  test('the class flow never leaves a minted link the DB does not know about (audit #6)', async () => {
    // The cron's never_billed proof: "status pending + no session id = no link
    // was ever minted". A class booking whose session-id write silently failed
    // used to break that proof — the cron would release a class the customer
    // may have paid for. Now the unpersisted link is expired on the spot.
    payments.createPaymentLink.mockResolvedValue({ sessionId: 'cs_class', paymentUrl: 'https://pay.stripe.test/cs_class' });
    db.getBookingEventById.mockResolvedValue({ id: 501, status: 'pending', stripe_session_id: null }); // write silently failed

    const result = await toolBookClass(PHONE, {
      class_id: 4001, session_type_id: 83, class_name: 'Vinyasa Flow',
      class_date_time: START, client_name: 'Test Guest', client_email: 'guest@example.com',
    });

    expect(payments.expireSession).toHaveBeenCalledWith('cs_class');
    expect(result.paymentError).toBe(true);
    expect(result.paymentUrl).toBeUndefined();
  });

  test('a class link whose session id persisted goes out normally', async () => {
    payments.createPaymentLink.mockResolvedValue({ sessionId: 'cs_class', paymentUrl: 'https://pay.stripe.test/cs_class' });
    db.getBookingEventById.mockResolvedValue({ id: 501, status: 'payment_sent', stripe_session_id: 'cs_class' });

    const result = await toolBookClass(PHONE, {
      class_id: 4001, session_type_id: 83, class_name: 'Vinyasa Flow',
      class_date_time: START, client_name: 'Test Guest', client_email: 'guest@example.com',
    });

    expect(result.paymentUrl).toBe('https://pay.stripe.test/cs_class');
    expect(payments.expireSession).not.toHaveBeenCalled();
  });

  test('no audit row -> the class enrolment is ROLLED BACK, not left as a free class (final gate)', async () => {
    // A live enrolment with no row is invisible to every safety net and
    // carries no unpaid marker — walked identically by two final-gate
    // attackers. Mirror the appointment path: roll back, tombstone, retry.
    db.logBookingEvent.mockResolvedValue(undefined); // DB write failed entirely
    db.tombstoneByAppointment.mockResolvedValue(0);

    const result = await toolBookClass(PHONE, {
      class_id: 4001, session_type_id: 83, class_name: 'Vinyasa Flow',
      class_date_time: START, client_name: 'Test Guest', client_email: 'guest@example.com',
    });

    expect(payments.createPaymentLink).not.toHaveBeenCalled();
    expect(mindbody.removeClientFromClass).toHaveBeenCalledWith(7, 4001);
    expect(db.tombstoneByAppointment).toHaveBeenCalledWith(4001, PHONE); // phone-scoped: class rows share the class id across customers
    expect(result.error).toBe('booking_failed');
  });

  test('a failed class rollback writes an orphan review flag (final gate)', async () => {
    db.logBookingEvent.mockResolvedValue(undefined);
    db.tombstoneByAppointment.mockResolvedValue(0);
    mindbody.removeClientFromClass.mockRejectedValue(new Error('Mindbody down'));

    await toolBookClass(PHONE, {
      class_id: 4001, session_type_id: 83, class_name: 'Vinyasa Flow',
      class_date_time: START, client_name: 'Test Guest', client_email: 'guest@example.com',
    });

    expect(db.logError).toHaveBeenCalledWith(
      'orphan_unbilled_class', expect.stringContaining('MANUAL REVIEW'), '', expect.any(String)
    );
  });

  test('a class paymentError flags needs_review so "team will arrange" is true (final gate)', async () => {
    payments.createPaymentLink.mockRejectedValue(new Error('stripe down'));
    db.logBookingEvent.mockResolvedValue(501);

    const result = await toolBookClass(PHONE, {
      class_id: 4001, session_type_id: 83, class_name: 'Vinyasa Flow',
      class_date_time: START, client_name: 'Test Guest', client_email: 'guest@example.com',
    });

    expect(result.paymentError).toBe(true);
    expect(db.logError).toHaveBeenCalledWith(
      'class_payment_link_failed', expect.stringContaining('team will arrange'), '', expect.any(String)
    );
    expect(db.updateBookingEvent).toHaveBeenCalledWith(501, { status: 'needs_review' });
  });

  test('the ghost row is tombstoned when an appointment insert cannot be confirmed (final gate)', async () => {
    // The INSERT may have COMMITTED while reporting failure; the retry's
    // idempotency lookup must never find a live 'pending' row for the
    // appointment the rollback just cancelled.
    confirmed();
    db.logBookingEvent.mockResolvedValue(undefined);
    db.tombstoneByAppointment.mockResolvedValue(1);

    const result = await toolBookAppointment(PHONE, {
      session_type_id: MASSAGE_60, start_date_time: START,
      client_name: 'Test Guest', client_email: 'guest@example.com',
    });

    expect(result.error).toBe('booking_failed');
    expect(mindbody.cancelAppointment).toHaveBeenCalledWith(9001);
    expect(db.tombstoneByAppointment).toHaveBeenCalledWith(9001, PHONE);
  });

  test('an untombstonable ghost is flagged for manual review (final gate)', async () => {
    confirmed();
    db.logBookingEvent.mockResolvedValue(undefined);
    db.tombstoneByAppointment.mockResolvedValue(null); // DB still down

    await toolBookAppointment(PHONE, {
      session_type_id: MASSAGE_60, start_date_time: START,
      client_name: 'Test Guest', client_email: 'guest@example.com',
    });

    expect(db.logError).toHaveBeenCalledWith(
      'ghost_row_untombstoned', expect.stringContaining('MANUAL REVIEW'), '', expect.any(String)
    );
  });

  test('a successful billing records the link for later re-shares', async () => {
    conversations.set(PHONE, {
      lang: 'en',
      pendingBookings: [{
        booking_event_id: 501, appointment_id: 9001, session_type_id: MASSAGE_60,
        service_name: 'Tailored Massage', date_time_label: 'x', amount_cents: 13000,
      }],
    });

    await billPendingBookings(PHONE, {});

    expect(conversations.get(PHONE).lastBillingLink).toEqual(
      expect.objectContaining({ url: 'https://pay.stripe.test/cs_new', sessionId: 'cs_new' })
    );
  });
});

// The re-gate's last confirmed finding, walked independently by both final
// attackers: a transient DB error in the paid-row lookup used to read as
// "not paid", silently skipping the refund machinery while the row flip
// erased the paid state. Failed lookup now means paid-state UNKNOWN → flag.
describe('cancellation refund safety (re-gate)', () => {
  const CANCEL_ARGS = {
    appointment_ids: [9001],
    service_name: 'Tailored Massage',
    date_time: 'maandag 25 augustus 14:00',
  };

  beforeEach(() => {
    // The customer tapped "Yes, cancel it" — the hard cancellation gate.
    conversations.set(PHONE, { lang: 'en', cancelConfirmedAt: Date.now() });
  });

  test('a failed paid-row lookup flags paid-state-unknown instead of skipping the refund silently', async () => {
    db.query.mockImplementation(async (sql) => {
      if (String(sql).includes("status = 'paid'")) throw new Error('transient DB error');
      return { rows: [] };
    });

    const result = await toolCancelAppointments(PHONE, CANCEL_ARGS);

    expect(result.cancelled).toEqual([9001]);
    expect(db.logError).toHaveBeenCalledWith(
      'cancelled_paid_state_unknown', expect.stringContaining('MANUAL REVIEW'), '', expect.any(String)
    );
    expect(email.sendRefundNotificationEmail).not.toHaveBeenCalled(); // nothing false-promised
  });

  test('a PAID cancellation notifies finance BEFORE promising the refund', async () => {
    const calls = [];
    email.sendRefundNotificationEmail.mockImplementation(async () => { calls.push('email'); });
    whatsapp.sendText.mockImplementation(async () => { calls.push('text'); });
    db.query.mockImplementation(async (sql) => {
      if (String(sql).includes("status = 'paid'")) {
        return { rows: [{ id: 501, customer_name: 'Test Guest', service_name: 'Tailored Massage', amount_cents: 13000, start_date_time: '2026-08-25T14:00:00' }] };
      }
      return { rows: [] };
    });

    const result = await toolCancelAppointments(PHONE, CANCEL_ARGS);

    expect(result.cancelled).toEqual([9001]);
    expect(calls.indexOf('email')).toBeLessThan(calls.indexOf('text'));
    expect(db.logError).not.toHaveBeenCalledWith('cancelled_paid_state_unknown', expect.anything(), expect.anything(), expect.anything());
  });

  test('a failed refund email writes the refund flag with the appointment id', async () => {
    email.sendRefundNotificationEmail.mockRejectedValue(new Error('smtp down'));
    db.query.mockImplementation(async (sql) => {
      if (String(sql).includes("status = 'paid'")) {
        return { rows: [{ id: 501, customer_name: 'Test Guest', service_name: 'Tailored Massage', amount_cents: 13000, start_date_time: '2026-08-25T14:00:00' }] };
      }
      return { rows: [] };
    });

    await toolCancelAppointments(PHONE, CANCEL_ARGS);

    expect(db.logError).toHaveBeenCalledWith(
      'refund_notification_failed', expect.stringContaining('€130'), '', expect.stringContaining('9001')
    );
  });
});
