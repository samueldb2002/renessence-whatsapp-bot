/**
 * Tests for the Stripe webhook handler (src/routes/stripe.routes.js).
 * All external services are mocked — no real HTTP calls or DB connections.
 */

const express = require('express');
const request = require('supertest');

// ── mocks (must be before require of the route) ───────────────────────────────

const mockConstructWebhookEvent = jest.fn();
const mockHandlePaymentSuccess   = jest.fn();
const mockHandlePaymentExpired   = jest.fn();

jest.mock('../src/services/payment.service', () => ({
  constructWebhookEvent:  mockConstructWebhookEvent,
  handlePaymentSuccess:   mockHandlePaymentSuccess,
  handlePaymentExpired:   mockHandlePaymentExpired,
}));

const mockSendText = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/services/whatsapp.service', () => ({ sendText: mockSendText }));

const mockCancelAppointment = jest.fn().mockResolvedValue(undefined);
const mockUpdateAppointmentNotes = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/services/mindbody.service', () => ({
  cancelAppointment: mockCancelAppointment,
  updateAppointmentNotes: mockUpdateAppointmentNotes,
}));

const mockSendBookingConfirmationEmail = jest.fn().mockResolvedValue(undefined);
const mockSendEscalationEmail = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/services/email.service', () => ({
  sendBookingConfirmationEmail: mockSendBookingConfirmationEmail,
  sendEscalationEmail: mockSendEscalationEmail,
}));

const mockGetBookingByStripeSession    = jest.fn();
const mockUpdateBookingByStripeSession = jest.fn().mockResolvedValue(undefined);
const mockGetBookingEventById          = jest.fn().mockResolvedValue(null);
const mockGetBookingEventByAppointment = jest.fn().mockResolvedValue(null);
const mockUpdateBookingEvent           = jest.fn().mockResolvedValue(undefined);
const mockUpdateBookingEventIfStatus   = jest.fn().mockResolvedValue(true);
jest.mock('../src/data/database', () => ({
  getBookingByStripeSession:    mockGetBookingByStripeSession,
  updateBookingByStripeSession: mockUpdateBookingByStripeSession,
  getBookingEventById:          mockGetBookingEventById,
  getBookingEventByAppointment: mockGetBookingEventByAppointment,
  updateBookingEvent:           mockUpdateBookingEvent,
  updateBookingEventIfStatus:   mockUpdateBookingEventIfStatus,
  logError: jest.fn(),
}));

jest.mock('../src/utils/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// ── test app ──────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  // Stripe routes expect a raw body (Buffer)
  app.use(express.raw({ type: 'application/json' }));
  const stripeRouter = require('../src/routes/stripe.routes');
  app.use('/', stripeRouter);
  return app;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function makeSession(overrides = {}) {
  return {
    id: 'cs_test_123',
    payment_intent: 'pi_test_456',
    payment_method_types: ['card'],
    customer_email: 'customer@example.com',
    customer_details: { name: 'Test User', email: 'customer@example.com' },
    metadata: {
      from: '31612345678',
      serviceName: 'Float Journey',
      dateTime: '2026-08-01 09:00',
      appointmentId: '12345',
      appointment_ids: '12345',
    },
    ...overrides,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockGetBookingByStripeSession.mockResolvedValue(null); // not yet paid by default
  mockGetBookingEventById.mockResolvedValue(null);
  mockGetBookingEventByAppointment.mockResolvedValue(null);
});

// ── Guards against acting on money state that lies ────────────────────────────

describe('POST / — paid-booking guards', () => {
  test('an expired session never cancels an appointment whose row reads PAID', async () => {
    // The expired session may be an orphaned duplicate: the customer paid a
    // DIFFERENT link for the same appointment.
    mockConstructWebhookEvent.mockReturnValue({
      type: 'checkout.session.expired',
      data: { object: makeSession() },
    });
    mockHandlePaymentExpired.mockReturnValue({
      from: '31612345678', serviceName: 'Float Journey', appointmentId: '12345',
      bookingEventIds: '77',
    });
    mockGetBookingEventByAppointment.mockResolvedValue({ id: 77, status: 'paid' });

    const res = await request(buildApp()).post('/').set('stripe-signature', 'sig').send(Buffer.from('{}'));

    expect(res.status).toBe(200);
    expect(mockCancelAppointment).not.toHaveBeenCalled();
    expect(mockSendText).not.toHaveBeenCalled(); // no false "cancelled" message
  });

  test('an expiry event only destroys rows that still BELONG to the session (round 3)', async () => {
    // Row 77 was rebilled on a newer session after a rollback; the OLD
    // session's (possibly delayed, possibly redelivered) expiry event must not
    // touch it or its appointment.
    mockConstructWebhookEvent.mockReturnValue({
      type: 'checkout.session.expired',
      data: { object: makeSession({ id: 'cs_OLD' }) },
    });
    mockHandlePaymentExpired.mockReturnValue({
      from: '31612345678', serviceName: 'Massage', appointmentId: '12345',
      bookingEventIds: '77',
    });
    mockGetBookingEventById.mockResolvedValue({
      id: 77, status: 'payment_sent', stripe_session_id: 'cs_NEWER', mindbody_appointment_id: 12345,
    });

    const res = await request(buildApp()).post('/').set('stripe-signature', 'sig').send(Buffer.from('{}'));

    expect(res.status).toBe(200);
    expect(mockUpdateBookingEvent).not.toHaveBeenCalled();
    expect(mockCancelAppointment).not.toHaveBeenCalled();
    expect(mockSendText).not.toHaveBeenCalled();
  });

  test('an expiry redelivery is idempotent — already-expired rows produce no second cancellation text', async () => {
    mockConstructWebhookEvent.mockReturnValue({
      type: 'checkout.session.expired',
      data: { object: makeSession({ id: 'cs_test_123' }) },
    });
    mockHandlePaymentExpired.mockReturnValue({
      from: '31612345678', serviceName: 'Massage', appointmentId: '12345',
      bookingEventIds: '77',
    });
    mockGetBookingEventById.mockResolvedValue({
      id: 77, status: 'expired', stripe_session_id: 'cs_test_123', mindbody_appointment_id: 12345,
    });

    await request(buildApp()).post('/').set('stripe-signature', 'sig').send(Buffer.from('{}'));

    expect(mockCancelAppointment).not.toHaveBeenCalled();
    expect(mockSendText).not.toHaveBeenCalled();
  });

  test('an owned in-flight row IS expired and its appointment cancelled', async () => {
    mockConstructWebhookEvent.mockReturnValue({
      type: 'checkout.session.expired',
      data: { object: makeSession({ id: 'cs_test_123' }) },
    });
    mockHandlePaymentExpired.mockReturnValue({
      from: '31612345678', serviceName: 'Massage', appointmentId: '12345',
      bookingEventIds: '77',
    });
    mockGetBookingEventById.mockResolvedValue({
      id: 77, status: 'payment_sent', stripe_session_id: 'cs_test_123', mindbody_appointment_id: 12345,
    });
    mockUpdateBookingEventIfStatus.mockResolvedValue(true);

    await request(buildApp()).post('/').set('stripe-signature', 'sig').send(Buffer.from('{}'));

    expect(mockUpdateBookingEventIfStatus).toHaveBeenCalledWith('77', ['pending', 'payment_sent'], expect.objectContaining({ status: 'expired' }));
    expect(mockCancelAppointment).toHaveBeenCalledWith('12345');
    expect(mockSendText).toHaveBeenCalled();
  });

  test('a completed event with a non-paid payment_status is refused (async methods)', async () => {
    mockConstructWebhookEvent.mockReturnValue({
      type: 'checkout.session.completed',
      data: { object: makeSession({ payment_status: 'unpaid' }) },
    });

    await request(buildApp()).post('/').set('stripe-signature', 'sig').send(Buffer.from('{}'));

    expect(mockUpdateBookingEvent).not.toHaveBeenCalled();
    expect(mockUpdateBookingByStripeSession).not.toHaveBeenCalled();
    expect(mockSendText).not.toHaveBeenCalled();
  });

  test('a payment landing on a RELEASED booking escalates instead of confirming', async () => {
    // expireSession failed at T+15, the customer paid the zombie link: money
    // is real, the slot is gone. Team must rebook or refund — the customer
    // must not be told "fully confirmed".
    mockConstructWebhookEvent.mockReturnValue({
      type: 'checkout.session.completed',
      data: { object: makeSession({ metadata: { ...makeSession().metadata, booking_event_ids: '77' } }) },
    });
    mockHandlePaymentSuccess.mockReturnValue({
      from: '31612345678', serviceName: 'Float Journey', dateTime: '2026-08-01 09:00',
      bookingEventIds: '77', appointmentId: '12345', customerEmail: 'c@example.com', customerName: 'Test',
    });
    mockGetBookingEventById.mockResolvedValue({ id: 77, status: 'expired' });

    const res = await request(buildApp()).post('/').set('stripe-signature', 'sig').send(Buffer.from('{}'));

    expect(res.status).toBe(200);
    expect(mockSendEscalationEmail).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('PAYMENT ON RELEASED BOOKING'),
    }));
    const msg = mockSendText.mock.calls[0]?.[1] || '';
    expect(msg).not.toContain('fully confirmed');
    expect(msg).toContain('team');
  });
});

// A journey over the prepay threshold bills treatments that are normally
// settled at reception. Their Mindbody note still reads "UNPAID — pay on
// location", so the front desk would charge a guest who already paid.
describe('POST / — clearing the UNPAID note on prepaid treatments', () => {
  function completedSessionWith(metadata) {
    const session = makeSession({ metadata: { ...makeSession().metadata, ...metadata } });
    mockConstructWebhookEvent.mockReturnValue({
      type: 'checkout.session.completed',
      data: { object: session },
    });
    mockHandlePaymentSuccess.mockReturnValue({ from: '31612345678', serviceName: 'Float Journey' });
    return session;
  }

  async function post() {
    return request(buildApp()).post('/').set('stripe-signature', 'sig_test').send(Buffer.from('{}'));
  }

  test('every prepaid on-location appointment has its note rewritten', async () => {
    completedSessionWith({ prepaid_on_location_apt_ids: '12345,67890' });

    const res = await post();

    expect(res.status).toBe(200);
    expect(mockUpdateAppointmentNotes).toHaveBeenCalledTimes(2);
    expect(mockUpdateAppointmentNotes).toHaveBeenCalledWith('12345', expect.stringContaining('PAID online'));
    expect(mockUpdateAppointmentNotes).toHaveBeenCalledWith('67890', expect.stringContaining('PAID online'));
  });

  test('an ordinary pay-online journey touches no notes', async () => {
    completedSessionWith({});

    await post();

    expect(mockUpdateAppointmentNotes).not.toHaveBeenCalled();
  });

  test('a Mindbody failure does not break the payment confirmation', async () => {
    completedSessionWith({ prepaid_on_location_apt_ids: '12345' });
    mockUpdateAppointmentNotes.mockRejectedValueOnce(new Error('Mindbody down'));

    const res = await post();

    expect(res.status).toBe(200);
    expect(mockSendText).toHaveBeenCalled(); // customer still gets confirmed
  });
});

describe('POST / — checkout.session.completed', () => {
  test('marks booking as paid and sends WhatsApp confirmation', async () => {
    const session = makeSession();
    mockConstructWebhookEvent.mockReturnValue({
      type: 'checkout.session.completed',
      data: { object: session },
    });
    mockHandlePaymentSuccess.mockReturnValue({
      from: '31612345678',
      serviceName: 'Float Journey',
      dateTime: '2026-08-01 09:00',
      customerEmail: 'customer@example.com',
      customerName: 'Test User',
    });

    const app = buildApp();
    const res = await request(app)
      .post('/')
      .set('stripe-signature', 'sig_test')
      .send(Buffer.from('{}'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(mockUpdateBookingByStripeSession).toHaveBeenCalledWith(
      'cs_test_123',
      expect.objectContaining({ status: 'paid' })
    );
    expect(mockSendText).toHaveBeenCalledWith(
      '31612345678',
      expect.stringContaining('Payment received')
    );
  });

  test('skips duplicate if booking already paid (idempotency)', async () => {
    const session = makeSession();
    mockConstructWebhookEvent.mockReturnValue({
      type: 'checkout.session.completed',
      data: { object: session },
    });
    // Simulate already-paid booking
    mockGetBookingByStripeSession.mockResolvedValue({ status: 'paid' });

    const app = buildApp();
    const res = await request(app)
      .post('/')
      .set('stripe-signature', 'sig_test')
      .send(Buffer.from('{}'));

    expect(res.status).toBe(200);
    expect(mockUpdateBookingByStripeSession).not.toHaveBeenCalled();
    expect(mockSendText).not.toHaveBeenCalled();
  });

  test('does not send WhatsApp for web sessions (from starts with web_)', async () => {
    const session = makeSession({ metadata: { from: 'web_abc123', serviceName: 'Float Journey', dateTime: '2026-08-01 09:00', appointmentId: '12345' } });
    mockConstructWebhookEvent.mockReturnValue({
      type: 'checkout.session.completed',
      data: { object: session },
    });
    mockHandlePaymentSuccess.mockReturnValue({
      from: 'web_abc123',
      serviceName: 'Float Journey',
      dateTime: '2026-08-01 09:00',
      customerEmail: null,
      customerName: '',
    });

    const app = buildApp();
    await request(app)
      .post('/')
      .set('stripe-signature', 'sig_test')
      .send(Buffer.from('{}'));

    expect(mockSendText).not.toHaveBeenCalled();
  });

  test('returns 400 when constructWebhookEvent throws', async () => {
    mockConstructWebhookEvent.mockImplementation(() => { throw new Error('Bad signature'); });

    const app = buildApp();
    const res = await request(app)
      .post('/')
      .set('stripe-signature', 'bad_sig')
      .send(Buffer.from('{}'));

    expect(res.status).toBe(400);
    expect(res.text).toContain('Webhook Error');
  });
});

describe('POST / — checkout.session.expired', () => {
  test('cancels Mindbody appointment and notifies customer', async () => {
    const session = makeSession();
    mockConstructWebhookEvent.mockReturnValue({
      type: 'checkout.session.expired',
      data: { object: session },
    });
    mockHandlePaymentExpired.mockReturnValue({
      appointmentId: '12345',
      from: '31612345678',
      serviceName: 'Float Journey',
      dateTime: '2026-08-01 09:00',
    });

    const app = buildApp();
    const res = await request(app)
      .post('/')
      .set('stripe-signature', 'sig_test')
      .send(Buffer.from('{}'));

    expect(res.status).toBe(200);
    expect(mockCancelAppointment).toHaveBeenCalledWith('12345');
    expect(mockSendText).toHaveBeenCalledWith(
      '31612345678',
      expect.stringContaining('cancelled')
    );
  });

  test('cancels multiple appointments from comma-separated IDs', async () => {
    const session = makeSession();
    mockConstructWebhookEvent.mockReturnValue({
      type: 'checkout.session.expired',
      data: { object: session },
    });
    mockHandlePaymentExpired.mockReturnValue({
      appointmentId: '111,222,333',
      from: '31612345678',
      serviceName: 'Float + Sauna',
      dateTime: '',
    });

    const app = buildApp();
    await request(app)
      .post('/')
      .set('stripe-signature', 'sig_test')
      .send(Buffer.from('{}'));

    expect(mockCancelAppointment).toHaveBeenCalledTimes(3);
    expect(mockCancelAppointment).toHaveBeenCalledWith('111');
    expect(mockCancelAppointment).toHaveBeenCalledWith('222');
    expect(mockCancelAppointment).toHaveBeenCalledWith('333');
  });

  test('does not send WhatsApp for web sessions on expiry', async () => {
    const session = makeSession();
    mockConstructWebhookEvent.mockReturnValue({
      type: 'checkout.session.expired',
      data: { object: session },
    });
    mockHandlePaymentExpired.mockReturnValue({
      appointmentId: '12345',
      from: 'web_abc123',
      serviceName: 'Float Journey',
      dateTime: '',
    });

    const app = buildApp();
    await request(app)
      .post('/')
      .set('stripe-signature', 'sig_test')
      .send(Buffer.from('{}'));

    expect(mockCancelAppointment).toHaveBeenCalledWith('12345');
    expect(mockSendText).not.toHaveBeenCalled();
  });

  test('skips WhatsApp if appointment already cancelled in Mindbody', async () => {
    const session = makeSession();
    mockConstructWebhookEvent.mockReturnValue({
      type: 'checkout.session.expired',
      data: { object: session },
    });
    mockHandlePaymentExpired.mockReturnValue({
      appointmentId: '12345',
      from: '31612345678',
      serviceName: 'Float Journey',
      dateTime: '',
    });
    // Simulate "already cancelled" Mindbody error
    mockCancelAppointment.mockRejectedValue(
      Object.assign(new Error('already cancelled'), {
        response: { data: { Error: { Message: 'already cancelled' } } },
      })
    );

    const app = buildApp();
    const res = await request(app)
      .post('/')
      .set('stripe-signature', 'sig_test')
      .send(Buffer.from('{}'));

    expect(res.status).toBe(200);
    expect(mockSendText).not.toHaveBeenCalled();
  });
});

describe('POST / — unknown event type', () => {
  test('unhandled event types still return received: true', async () => {
    mockConstructWebhookEvent.mockReturnValue({
      type: 'payment_intent.created',
      data: { object: {} },
    });

    const app = buildApp();
    const res = await request(app)
      .post('/')
      .set('stripe-signature', 'sig_test')
      .send(Buffer.from('{}'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });
});
