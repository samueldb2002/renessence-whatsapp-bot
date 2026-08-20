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
jest.mock('../src/services/email.service', () => ({}));
jest.mock('../src/services/gift-card-check.service', () => ({}));
jest.mock('../src/services/mindbody.service', () => ({
  getClientByPhone: jest.fn(),
  addAppointment: jest.fn(),
  addClientToClass: jest.fn().mockResolvedValue({}),
  cancelAppointment: jest.fn().mockResolvedValue({}),
}));
jest.mock('../src/data/database', () => ({
  logBookingEvent: jest.fn(),
  updateBookingEvent: jest.fn().mockResolvedValue({}),
  getRecentBooking: jest.fn().mockResolvedValue(null),
  getBookingEventById: jest.fn(),
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
const {
  toolBookAppointment,
  toolBookClass,
  toolSendPayment,
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
  function existingRow(status) {
    db.getRecentBooking.mockResolvedValue({
      id: 501, mindbody_appointment_id: 9001, status,
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
    existingRow('payment_sent');
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

  test('an unverifiable item (DB error) is dropped, never risked', async () => {
    seedCart([item(1, MASSAGE_60, 13000)]);
    db.getBookingEventById.mockResolvedValue(null);

    await billPendingBookings(PHONE, {});
    expect(payments.createCombinedPaymentLink).not.toHaveBeenCalled();
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

  test('no audit row -> no payment link is minted for a class at all', async () => {
    db.logBookingEvent.mockResolvedValue(undefined); // DB write failed entirely

    const result = await toolBookClass(PHONE, {
      class_id: 4001, session_type_id: 83, class_name: 'Vinyasa Flow',
      class_date_time: START, client_name: 'Test Guest', client_email: 'guest@example.com',
    });

    expect(payments.createPaymentLink).not.toHaveBeenCalled();
    expect(result.paymentError).toBe(true);
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
