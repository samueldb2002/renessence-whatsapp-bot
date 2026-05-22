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
jest.mock('../src/services/mindbody.service', () => ({ cancelAppointment: mockCancelAppointment }));

const mockSendBookingConfirmationEmail = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/services/email.service', () => ({
  sendBookingConfirmationEmail: mockSendBookingConfirmationEmail,
}));

const mockGetBookingByStripeSession    = jest.fn();
const mockUpdateBookingByStripeSession = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/data/database', () => ({
  getBookingByStripeSession:    mockGetBookingByStripeSession,
  updateBookingByStripeSession: mockUpdateBookingByStripeSession,
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
