// The unpaid-booking safety net.
//
// The hole this covers: book_appointment creates the Mindbody appointment
// first and only bills when send_payment runs. If send_payment never ran, the
// row keeps status 'pending' with no stripe_session_id — and the sweeper used
// to refuse to touch those, so the slot sat in Mindbody, confirmed and unpaid,
// forever. That is safe to cancel precisely because send_payment writes the
// session id and status 'payment_sent' in the SAME update: no session id on a
// 'pending' row proves no link was ever minted, so no money can be in flight.

jest.mock('../src/services/mindbody.service', () => ({
  cancelAppointment: jest.fn().mockResolvedValue({}),
}));
jest.mock('../src/services/whatsapp.service', () => ({
  sendText: jest.fn().mockResolvedValue({}),
}));
jest.mock('../src/services/payment.service', () => ({
  getSessionStatus: jest.fn(),
  cancelPendingPaymentByAppointment: jest.fn().mockResolvedValue(true),
}));
jest.mock('../src/services/conversation.service', () => ({
  get: jest.fn().mockReturnValue({ lang: 'en' }),
}));
jest.mock('../src/data/database', () => ({
  getStaleUnpaidBookings: jest.fn(),
  updateBookingEvent: jest.fn().mockResolvedValue({}),
}));

const mindbody = require('../src/services/mindbody.service');
const whatsapp = require('../src/services/whatsapp.service');
const payments = require('../src/services/payment.service');
const db = require('../src/data/database');
const { expireStaleBookings } = require('../src/services/expire-bookings.service');

/** A stale row as getStaleUnpaidBookings returns it. */
function row(overrides = {}) {
  return {
    id: 1,
    mindbody_appointment_id: 5001,
    phone: '31600000000',
    service_name: 'Tailored Massage',
    status: 'pending',
    stripe_session_id: null,
    stripe_payment_intent: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  payments.getSessionStatus.mockResolvedValue(null);
});

describe('bookings that never got a payment link', () => {
  test('a stale pending row with no Stripe session is cancelled and released', async () => {
    db.getStaleUnpaidBookings.mockResolvedValue([row()]);

    await expireStaleBookings();

    expect(mindbody.cancelAppointment).toHaveBeenCalledWith(5001);
    expect(db.updateBookingEvent).toHaveBeenCalledWith(1, expect.objectContaining({
      status: 'expired',
      cancelReason: 'never_billed',
    }));
  });

  test('the customer is told their slot was released', async () => {
    db.getStaleUnpaidBookings.mockResolvedValue([row()]);

    await expireStaleBookings();

    expect(whatsapp.sendText).toHaveBeenCalledWith(
      '31600000000',
      expect.stringContaining('Tailored Massage')
    );
  });

  test('web-chat bookings are released but not messaged', async () => {
    db.getStaleUnpaidBookings.mockResolvedValue([row({ phone: 'web_abc123' })]);

    await expireStaleBookings();

    expect(mindbody.cancelAppointment).toHaveBeenCalledWith(5001);
    expect(whatsapp.sendText).not.toHaveBeenCalled();
  });

  test('Stripe is never consulted — there is no session to consult about', async () => {
    db.getStaleUnpaidBookings.mockResolvedValue([row()]);

    await expireStaleBookings();

    expect(payments.getSessionStatus).not.toHaveBeenCalled();
  });

  // A row that reached 'payment_sent' without a stored session id means the
  // link WAS minted and the id failed to persist. Money may be in flight, so
  // this one still goes to manual review rather than being cancelled.
  test('a payment_sent row with no session id is left alone', async () => {
    db.getStaleUnpaidBookings.mockResolvedValue([row({ status: 'payment_sent' })]);

    await expireStaleBookings();

    expect(mindbody.cancelAppointment).not.toHaveBeenCalled();
    expect(db.updateBookingEvent).not.toHaveBeenCalled();
  });
});

describe('bookings that did get a payment link (unchanged behaviour)', () => {
  test('a paid session repairs the row instead of cancelling it', async () => {
    db.getStaleUnpaidBookings.mockResolvedValue([
      row({ status: 'payment_sent', stripe_session_id: 'cs_paid' }),
    ]);
    payments.getSessionStatus.mockResolvedValue({ status: 'complete', paymentStatus: 'paid' });

    await expireStaleBookings();

    expect(mindbody.cancelAppointment).not.toHaveBeenCalled();
    expect(db.updateBookingEvent).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'paid' }));
  });

  test('a session still open is left for a later run', async () => {
    db.getStaleUnpaidBookings.mockResolvedValue([
      row({ status: 'payment_sent', stripe_session_id: 'cs_open' }),
    ]);
    payments.getSessionStatus.mockResolvedValue({ status: 'open', paymentStatus: 'unpaid' });

    await expireStaleBookings();

    expect(mindbody.cancelAppointment).not.toHaveBeenCalled();
  });

  test('an expired unpaid session releases the slot', async () => {
    db.getStaleUnpaidBookings.mockResolvedValue([
      row({ status: 'payment_sent', stripe_session_id: 'cs_dead' }),
    ]);
    payments.getSessionStatus.mockResolvedValue({ status: 'expired', paymentStatus: 'unpaid' });

    await expireStaleBookings();

    expect(mindbody.cancelAppointment).toHaveBeenCalledWith(5001);
    expect(db.updateBookingEvent).toHaveBeenCalledWith(1, expect.objectContaining({
      status: 'expired',
      cancelReason: 'unpaid_timeout',
    }));
  });
});
