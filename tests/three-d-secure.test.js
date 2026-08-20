// Every card payment must request 3D Secure (bank verification).
//
// request_three_d_secure: 'any' tells Stripe to never use an SCA exemption:
// EU cards always verify, US cards verify whenever their bank supports 3DS,
// and a card whose bank can't verify still pays normally (no lost bookings).
// A verified payment shifts "that wasn't me" chargeback liability to the bank.
// iDEAL needs nothing here — an iDEAL payment IS a bank-app approval.
//
// The flag must be on ALL THREE checkout-creation sites: the combined journey
// link, the single-booking link, and the dashboard's manual team links.

const mockSessionsCreate = jest.fn();

jest.mock('stripe', () => jest.fn().mockImplementation(() => ({
  checkout: {
    sessions: {
      create: (...args) => mockSessionsCreate(...args),
      expire: jest.fn(),
    },
  },
  webhooks: { constructEvent: jest.fn() },
})));

jest.mock('../src/data/database', () => ({
  getPendingStripeSessionByAppointment: jest.fn().mockResolvedValue(null),
}));

const paymentService = require('../src/services/payment.service');

beforeEach(() => {
  mockSessionsCreate.mockReset();
  mockSessionsCreate.mockResolvedValue({ id: 'cs_test', url: 'https://pay.stripe.test/cs_test' });
});

function lastSessionArgs() {
  expect(mockSessionsCreate).toHaveBeenCalledTimes(1);
  return mockSessionsCreate.mock.calls[0][0];
}

const THREE_DS = { card: { request_three_d_secure: 'any' } };

describe('3D Secure is requested on every card payment', () => {
  test('combined journey link', async () => {
    await paymentService.createCombinedPaymentLink({
      items: [{
        bookingEventId: 1, appointmentId: 100, serviceName: 'Tailored Massage',
        dateTimeLabel: 'maandag 25 augustus at 14:00', amountCents: 13000,
      }],
      customerEmail: 'guest@example.com',
      from: '31600000000',
    });

    expect(lastSessionArgs().payment_method_options).toEqual(THREE_DS);
  });

  test('single-booking link', async () => {
    await paymentService.createPaymentLink({
      appointmentId: 100, clientId: 7, from: '31600000000',
      serviceName: 'Tailored Massage', dateTime: 'maandag 25 augustus 14:00',
      amount: 13000, customerEmail: 'guest@example.com',
    });

    expect(lastSessionArgs().payment_method_options).toEqual(THREE_DS);
  });

  test('manual dashboard link', async () => {
    await paymentService.createCustomPaymentLink({
      amountCents: 5000, description: 'Gift card top-up', from: '31600000000',
    });

    expect(lastSessionArgs().payment_method_options).toEqual(THREE_DS);
  });

  test('iDEAL stays available alongside cards on customer-facing links', async () => {
    await paymentService.createCombinedPaymentLink({
      items: [{ bookingEventId: 1, appointmentId: 100, serviceName: 'X', dateTimeLabel: 'y', amountCents: 1000 }],
      from: '31600000000',
    });

    expect(lastSessionArgs().payment_method_types).toEqual(['card', 'ideal']);
  });
});
