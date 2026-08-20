// The payment link used to exist only if the model called send_payment. A
// customer who ignored the "Send payment link" button kept a confirmed Mindbody
// slot and was never asked for money. The server now bills the cart itself
// 5 minutes after the last pay-online booking.

jest.mock('../src/services/whatsapp.service', () => ({
  sendText: jest.fn().mockResolvedValue({}),
  sendButtons: jest.fn().mockResolvedValue({}),
  sendList: jest.fn().mockResolvedValue({}),
  sendCTAButton: jest.fn().mockResolvedValue({}),
}));
jest.mock('../src/services/mindbody.service', () => ({
  cancelAppointment: jest.fn().mockResolvedValue({}),
}));
jest.mock('../src/services/email.service', () => ({}));
jest.mock('../src/services/gift-card-check.service', () => ({}));
jest.mock('../src/data/database', () => ({
  logMessage: jest.fn().mockResolvedValue({}),
  updateBookingEvent: jest.fn().mockResolvedValue({}),
  // Billing now verifies every cart item against its booking_events row before
  // taking money; these tests model live, still-billable rows. The pay-online /
  // pay-on-location distinction is carried by the item's session type, so the
  // row status just needs to be a billable one.
  getBookingEventById: jest.fn().mockImplementation(async id => ({ id, status: 'pending' })),
  updateBookingEventIfStatus: jest.fn().mockResolvedValue(true),
  getBookingEventByAppointment: jest.fn().mockResolvedValue(null),
  logError: jest.fn(),
  query: jest.fn().mockResolvedValue({ rows: [] }),
}));
jest.mock('stripe', () => jest.fn().mockImplementation(() => ({
  checkout: { sessions: { create: jest.fn(), expire: jest.fn() } },
  webhooks: { constructEvent: jest.fn() },
})));

// Keep the REAL PRICE_MAP and pay-online allow-list — the catalog is built from
// them at import time — and stub only the calls that would reach Stripe.
jest.mock('../src/services/payment.service', () => ({
  ...jest.requireActual('../src/services/payment.service'),
  createCombinedPaymentLink: jest.fn(),
  getSessionStatus: jest.fn().mockResolvedValue({ status: 'open', paymentStatus: 'unpaid' }),
}));

const whatsapp = require('../src/services/whatsapp.service');
const payments = require('../src/services/payment.service');
const conversations = require('../src/services/conversation.service');
const {
  scheduleAutoPaymentLink,
  cancelAutoPaymentLink,
  toolSendPayment,
  billPendingBookings,
} = require('../src/agents/tool-implementations');

const PHONE = '31611111111';

/** Put one unpaid massage in the conversation's cart. */
function cartWithMassage(phone = PHONE) {
  conversations.set(phone, {
    lang: 'en',
    customerEmail: 'guest@example.com',
    customerName: 'Test Guest',
    pendingBookings: [{
      booking_event_id: 77,
      appointment_id: 5001,
      session_type_id: 31,
      service_name: 'Tailored Massage',
      date_time_label: 'maandag 25 augustus at 14:00',
      amount_cents: 13000,
    }],
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  conversations.clear(PHONE);
  payments.createCombinedPaymentLink.mockResolvedValue({
    sessionId: 'cs_auto', paymentUrl: 'https://pay.stripe.test/cs_auto',
  });
});

afterEach(() => {
  cancelAutoPaymentLink(PHONE);
  jest.useRealTimers();
});

/** Run the pending timers and let the async callback settle. */
async function advanceToAutoBill() {
  jest.advanceTimersByTime(5 * 60 * 1000);
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe('automatic payment link', () => {
  test('an unbilled cart is charged 5 minutes after booking', async () => {
    cartWithMassage();
    scheduleAutoPaymentLink(PHONE);

    expect(payments.createCombinedPaymentLink).not.toHaveBeenCalled();
    await advanceToAutoBill();

    expect(payments.createCombinedPaymentLink).toHaveBeenCalledTimes(1);
    const billed = payments.createCombinedPaymentLink.mock.calls[0][0];
    expect(billed.items).toHaveLength(1);
    expect(billed.items[0].amountCents).toBe(13000);
  });

  test('the link is pushed to the customer', async () => {
    cartWithMassage();
    scheduleAutoPaymentLink(PHONE);
    await advanceToAutoBill();

    expect(whatsapp.sendCTAButton).toHaveBeenCalledWith(
      PHONE,
      expect.stringContaining('isn\'t confirmed yet'),
      'Pay Now',
      'https://pay.stripe.test/cs_auto'
    );
  });

  test('it uses the customer\'s email so checkout is pre-filled', async () => {
    cartWithMassage();
    scheduleAutoPaymentLink(PHONE);
    await advanceToAutoBill();

    expect(payments.createCombinedPaymentLink.mock.calls[0][0].customerEmail)
      .toBe('guest@example.com');
  });

  test('a cart already billed by the model is left alone', async () => {
    cartWithMassage();
    scheduleAutoPaymentLink(PHONE);
    conversations.set(PHONE, { pendingBookings: [] }); // send_payment cleared it

    await advanceToAutoBill();

    expect(payments.createCombinedPaymentLink).not.toHaveBeenCalled();
    expect(whatsapp.sendCTAButton).not.toHaveBeenCalled();
  });

  test('send_payment cancels the fallback, so nobody is billed twice', async () => {
    cartWithMassage();
    scheduleAutoPaymentLink(PHONE);

    await toolSendPayment(PHONE, { customer_email: 'guest@example.com' });
    expect(payments.createCombinedPaymentLink).toHaveBeenCalledTimes(1);

    await advanceToAutoBill();
    expect(payments.createCombinedPaymentLink).toHaveBeenCalledTimes(1);
  });

  test('booking again restarts the window instead of billing mid-cart', async () => {
    cartWithMassage();
    scheduleAutoPaymentLink(PHONE);

    jest.advanceTimersByTime(4 * 60 * 1000);
    scheduleAutoPaymentLink(PHONE); // customer added a second treatment
    jest.advanceTimersByTime(4 * 60 * 1000);
    await Promise.resolve();

    expect(payments.createCombinedPaymentLink).not.toHaveBeenCalled();

    await advanceToAutoBill();
    expect(payments.createCombinedPaymentLink).toHaveBeenCalledTimes(1);
  });

  test('web-chat conversations schedule nothing — there is no channel to push to', async () => {
    const web = 'web_abc123';
    cartWithMassage(web);
    scheduleAutoPaymentLink(web);

    await advanceToAutoBill();

    expect(payments.createCombinedPaymentLink).not.toHaveBeenCalled();
  });

  test('a Stripe failure is swallowed — the cron still releases the slot', async () => {
    cartWithMassage();
    payments.createCombinedPaymentLink.mockRejectedValue(new Error('stripe down'));
    scheduleAutoPaymentLink(PHONE);

    await expect(advanceToAutoBill()).resolves.not.toThrow();
    expect(whatsapp.sendCTAButton).not.toHaveBeenCalled();
  });
});

// End-to-end through the real cart: the threshold rule is unit-tested in
// journey-threshold.test.js; here it has to survive the actual billing path.
describe('prepay threshold through the cart', () => {
  function setCart(items) {
    conversations.set(PHONE, { lang: 'en', customerEmail: 'guest@example.com', pendingBookings: items });
  }
  const cartItem = (sessionTypeId, name, cents, payOnLocation = false) => ({
    booking_event_id: sessionTypeId,
    appointment_id: 5000 + sessionTypeId,
    session_type_id: sessionTypeId,
    service_name: name,
    date_time_label: 'maandag 25 augustus at 14:00',
    amount_cents: cents,
    ...(payOnLocation ? { pay_on_location: true } : {}),
  });

  test('the team\'s €240 example is billed in full', async () => {
    setCart([
      cartItem(31, 'Tailored Massage', 13000),
      cartItem(30, 'LED Light Therapy', 3000),
      cartItem(58, 'Float Journey', 8000, true),
    ]);

    const result = await billPendingBookings(PHONE, {});

    expect(result.paymentUrl).toBeTruthy();
    const billed = payments.createCombinedPaymentLink.mock.calls[0][0].items;
    expect(billed).toHaveLength(3);
    expect(billed.reduce((s, i) => s + i.amountCents, 0)).toBe(24000);
  });

  test('the prepaid float is flagged so its UNPAID note can be cleared', async () => {
    setCart([
      cartItem(31, 'Tailored Massage', 13000),
      cartItem(58, 'Float Journey', 8000, true),
    ]);

    await billPendingBookings(PHONE, {});

    const billed = payments.createCombinedPaymentLink.mock.calls[0][0].items;
    const float = billed.find(i => i.serviceName === 'Float Journey');
    expect(float.payOnLocation).toBe(true);
    expect(billed.find(i => i.serviceName === 'Tailored Massage').payOnLocation).toBe(false);
  });

  test('a lone float stays payable at reception', async () => {
    setCart([cartItem(58, 'Float Journey', 8000, true)]);

    const result = await billPendingBookings(PHONE, {});

    expect(result.nothing_to_pay).toBe(true);
    expect(payments.createCombinedPaymentLink).not.toHaveBeenCalled();
  });

  test('a sub-threshold mixed journey bills only the massage', async () => {
    setCart([
      cartItem(30, 'LED Light Therapy', 3000),
      cartItem(64, 'Red Light Therapy', 4500, true),
    ]);

    await billPendingBookings(PHONE, {});

    const billed = payments.createCombinedPaymentLink.mock.calls[0][0].items;
    expect(billed.map(i => i.serviceName)).toEqual(['LED Light Therapy']);
  });
});
