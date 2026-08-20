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
  removeClientFromClass: jest.fn().mockResolvedValue({}),
  getClientByPhone: jest.fn().mockResolvedValue({ Id: 7 }),
  isBenignCancelError: jest.requireActual('../src/services/mindbody.service').isBenignCancelError,
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
  update: jest.fn(),
}));
jest.mock('../src/data/database', () => ({
  getStaleUnpaidBookings: jest.fn(),
  getUnpaidStartedBookings: jest.fn().mockResolvedValue([]),
  getAttendedUnresolvedBookings: jest.fn().mockResolvedValue([]),
  getAgingUnresolvedBookings: jest.fn().mockResolvedValue([]),
  updateBookingEvent: jest.fn().mockResolvedValue({}),
  logError: jest.fn(),
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
  db.getUnpaidStartedBookings.mockResolvedValue([]);
  db.getAttendedUnresolvedBookings.mockResolvedValue([]);
  db.getAgingUnresolvedBookings.mockResolvedValue([]);
  mindbody.cancelAppointment.mockResolvedValue({});
  mindbody.removeClientFromClass.mockResolvedValue({});
  mindbody.getClientByPhone.mockResolvedValue({ Id: 7 });
});

// Round-5 verify finding: the cron fed CLASS ids to the appointment API,
// whose "not found" answer LOOKED benign while the enrolment lived on.
describe('class rows in the cron', () => {
  const classRow = (overrides = {}) => row({
    id: 3, session_type_id: 83, mindbody_appointment_id: 4001,
    service_name: 'Vinyasa Flow', ...overrides,
  });

  test('an unpaid class is released via the class API, not the appointment API', async () => {
    db.getStaleUnpaidBookings.mockResolvedValue([classRow()]);

    await expireStaleBookings();

    expect(mindbody.getClientByPhone).toHaveBeenCalledWith('31600000000', null);
    expect(mindbody.removeClientFromClass).toHaveBeenCalledWith(7, 4001);
    expect(mindbody.cancelAppointment).not.toHaveBeenCalled();
    expect(db.updateBookingEvent).toHaveBeenCalledWith(3, expect.objectContaining({ status: 'expired' }));
  });

  test('a failed client lookup flags the class row and leaves it in-flight', async () => {
    db.getStaleUnpaidBookings.mockResolvedValue([classRow()]);
    mindbody.getClientByPhone.mockResolvedValue(null);

    await expireStaleBookings();

    expect(mindbody.removeClientFromClass).not.toHaveBeenCalled();
    expect(db.logError).toHaveBeenCalledWith(
      'appointment_release_failed', expect.stringContaining('class'), '', expect.any(String)
    );
    expect(db.updateBookingEvent).not.toHaveBeenCalled();
  });
});

// A row still unresolved as it crosses the 24h edge of every sweep would go
// permanently silent — flag it on the way out.
describe('rows aging out of the safety-net window', () => {
  test('an aging in-flight row is flagged needs_review', async () => {
    db.getStaleUnpaidBookings.mockResolvedValue([]);
    db.getAgingUnresolvedBookings.mockResolvedValue([
      row({ id: 11, status: 'payment_sent', stripe_session_id: 'cs_old' }),
    ]);

    await expireStaleBookings();

    expect(db.logError).toHaveBeenCalledWith(
      'unresolved_booking_aging_out', expect.stringContaining('MANUAL REVIEW'), '', expect.any(String)
    );
    expect(db.updateBookingEvent).toHaveBeenCalledWith(11, { status: 'needs_review' });
  });
});

// The cron's CLASS_SESSION_TYPES list is pinned against the real catalog in
// tests/catalog-prices.test.js (this file mocks too much to load the catalog).

// Round-4 verify finding: genuine cancel failures were classified benign by a
// substring filter ('status' matched "status code 500"), so rows were marked
// expired while their appointments lived on — invisible to every safety net.
describe('cancel-failure classification', () => {
  test('a real Mindbody failure leaves the row untouched for a retry', async () => {
    db.getStaleUnpaidBookings.mockResolvedValue([row()]);
    mindbody.cancelAppointment.mockRejectedValue(new Error('Request failed with status code 500'));

    await expireStaleBookings();

    expect(db.updateBookingEvent).not.toHaveBeenCalled();
  });

  test('"Cancellation did not take effect" is never treated as benign', async () => {
    db.getStaleUnpaidBookings.mockResolvedValue([row()]);
    mindbody.cancelAppointment.mockRejectedValue(new Error('Cancellation did not take effect — Mindbody returned status "NoShow" for appointment 5001'));

    await expireStaleBookings();

    expect(db.updateBookingEvent).not.toHaveBeenCalled();
  });

  test('an explicit already-cancelled signal still resolves the row', async () => {
    db.getStaleUnpaidBookings.mockResolvedValue([row()]);
    mindbody.cancelAppointment.mockRejectedValue(new Error('Appointment already cancelled'));

    await expireStaleBookings();

    expect(db.updateBookingEvent).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'expired' }));
  });
});

// The reconciliation net: every stranded-row failure mode ends as an attended
// 'payment_sent' row; the cron asks Stripe what really happened.
describe('reconciliation of attended payment_sent rows', () => {
  const attendedRow = (overrides = {}) => ({
    id: 42, mindbody_appointment_id: 8001, phone: '31600000000',
    service_name: 'Tailored Massage', status: 'payment_sent',
    stripe_session_id: 'cs_str', ...overrides,
  });

  test('a paid session repairs the row — customer paid, DB lagged', async () => {
    db.getStaleUnpaidBookings.mockResolvedValue([]);
    db.getAttendedUnresolvedBookings.mockResolvedValue([attendedRow()]);
    payments.getSessionStatus.mockResolvedValue({ status: 'complete', paymentStatus: 'paid' });

    await expireStaleBookings();

    expect(db.updateBookingEvent).toHaveBeenCalledWith(42, expect.objectContaining({ status: 'paid' }));
    expect(db.logError).not.toHaveBeenCalled();
  });

  test('an unpaid session flags the attended booking for the team', async () => {
    db.getStaleUnpaidBookings.mockResolvedValue([]);
    db.getAttendedUnresolvedBookings.mockResolvedValue([attendedRow()]);
    payments.getSessionStatus.mockResolvedValue({ status: 'expired', paymentStatus: 'unpaid' });

    await expireStaleBookings();

    expect(db.logError).toHaveBeenCalledWith(
      'unpaid_attended_booking', expect.stringContaining('MANUAL REVIEW'), '', expect.any(String)
    );
    expect(db.updateBookingEvent).toHaveBeenCalledWith(42, { status: 'needs_review' });
  });

  test('a Stripe blip defers to the next run rather than misflagging', async () => {
    db.getStaleUnpaidBookings.mockResolvedValue([]);
    db.getAttendedUnresolvedBookings.mockResolvedValue([attendedRow()]);
    payments.getSessionStatus.mockResolvedValue(null);

    await expireStaleBookings();

    expect(db.updateBookingEvent).not.toHaveBeenCalled();
    expect(db.logError).not.toHaveBeenCalled();
  });
});

describe('bookings that started without ever being billed', () => {
  // The cron cannot cancel a session in progress, but silence made these free
  // treatments: flag once for the team, then stop matching.
  test('an attended unpaid booking is flagged needs_review, never cancelled', async () => {
    db.getUnpaidStartedBookings.mockResolvedValue([
      row({ id: 9, mindbody_appointment_id: 7001, service_name: 'Tailored Massage' }),
    ]);
    db.getStaleUnpaidBookings.mockResolvedValue([]);

    await expireStaleBookings();

    expect(db.logError).toHaveBeenCalledWith(
      'unpaid_attended_booking', expect.stringContaining('MANUAL REVIEW'), '', expect.any(String)
    );
    expect(db.updateBookingEvent).toHaveBeenCalledWith(9, { status: 'needs_review' });
    expect(mindbody.cancelAppointment).not.toHaveBeenCalled();
  });
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

  // A released appointment must also leave the in-memory cart, or a customer
  // still chatting could later be billed — and pay — for a slot that no longer
  // exists in Mindbody.
  test('the released appointment is purged from the conversation cart', async () => {
    const conversations = require('../src/services/conversation.service');
    conversations.get.mockReturnValue({
      lang: 'en',
      pendingBookings: [
        { appointment_id: 5001, service_name: 'Tailored Massage' },
        { appointment_id: 6002, service_name: 'Other booking' },
      ],
    });
    db.getStaleUnpaidBookings.mockResolvedValue([row()]);

    await expireStaleBookings();

    expect(conversations.update).toHaveBeenCalledWith('31600000000', {
      pendingBookings: [expect.objectContaining({ appointment_id: 6002 })],
    });
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
