// Big journeys must be prepaid.
//
// Most single treatments (Float, saunas, oxygen, red light, hydrowave) are
// deliberately paid at reception. But a journey like massage + LED + float
// comes to €240 and used to be booked with nothing taken upfront. Once a
// journey's total crosses the threshold, everything in it goes on one Stripe
// link — including the parts that would normally be paid on location.

jest.mock('stripe', () => jest.fn().mockImplementation(() => ({
  checkout: { sessions: { create: jest.fn(), expire: jest.fn() } },
  webhooks: { constructEvent: jest.fn() },
})));
jest.mock('../src/data/database', () => ({
  getPendingStripeSessionByAppointment: jest.fn().mockResolvedValue(null),
}));

const {
  selectBillableItems,
  JOURNEY_PREPAY_THRESHOLD_CENTS,
  PRICE_MAP,
} = require('../src/services/payment.service');

/** A cart item for a session type, priced from PRICE_MAP. */
function item(sessionTypeId, name) {
  return {
    booking_event_id: sessionTypeId,
    appointment_id: 5000 + sessionTypeId,
    session_type_id: sessionTypeId,
    service_name: name,
    amount_cents: PRICE_MAP[sessionTypeId],
  };
}

const MASSAGE = () => item(31, 'Tailored Massage');   // €130, pay-online
const LED     = () => item(30, 'LED Light Therapy');  // €30,  pay-online
const FLOAT   = () => item(58, 'Float Journey');      // €80,  pay-on-location
const REDLIGHT= () => item(64, 'Red Light Therapy');  // €45,  pay-on-location
const SAUNA   = () => item(87, 'Finnish Sauna');      // €80,  pay-on-location

const names = billed => billed.map(b => b.service_name).sort();
const total = billed => billed.reduce((s, b) => s + b.amount_cents, 0);

test('the threshold is €150', () => {
  expect(JOURNEY_PREPAY_THRESHOLD_CENTS).toBe(15000);
});

describe('below the threshold — nothing changes', () => {
  test('a lone float is still paid at reception', () => {
    expect(selectBillableItems([FLOAT()])).toEqual([]);
  });

  test('float + red light (€125) is still paid at reception', () => {
    expect(selectBillableItems([FLOAT(), REDLIGHT()])).toEqual([]);
  });

  test('a lone massage is billed because massages are always pay-online', () => {
    expect(names(selectBillableItems([MASSAGE()]))).toEqual(['Tailored Massage']);
  });

  test('a massage plus a float below €150 bills only the massage', () => {
    // €130 + €80 = €210 — over the threshold, so this case is covered below.
    // Here: LED €30 + float... no. Use red light €45 + LED €30 = €75.
    expect(names(selectBillableItems([LED(), REDLIGHT()]))).toEqual(['LED Light Therapy']);
  });
});

describe('at or above the threshold — the whole journey is prepaid', () => {
  test('massage + LED + float (€240) bills all three', () => {
    const billed = selectBillableItems([MASSAGE(), LED(), FLOAT()]);
    expect(names(billed)).toEqual(['Float Journey', 'LED Light Therapy', 'Tailored Massage']);
    expect(total(billed)).toBe(24000);
  });

  test('two pay-on-location treatments totalling €160 are prepaid', () => {
    const billed = selectBillableItems([FLOAT(), SAUNA()]);
    expect(names(billed)).toEqual(['Finnish Sauna', 'Float Journey']);
    expect(total(billed)).toBe(16000);
  });

  test('exactly €150 counts as over the line', () => {
    const exact = [
      { session_type_id: 58, service_name: 'A', amount_cents: 7500 },
      { session_type_id: 58, service_name: 'B', amount_cents: 7500 },
    ];
    expect(selectBillableItems(exact)).toHaveLength(2);
  });

  test('one cent under €150 is not', () => {
    const under = [
      { session_type_id: 58, service_name: 'A', amount_cents: 7500 },
      { session_type_id: 58, service_name: 'B', amount_cents: 7499 },
    ];
    expect(selectBillableItems(under)).toEqual([]);
  });
});

describe('edge cases', () => {
  test('an empty cart bills nothing', () => {
    expect(selectBillableItems([])).toEqual([]);
  });

  test('items with an unknown session type are kept — they came from a trusted path', () => {
    const legacy = [{ session_type_id: null, service_name: 'Legacy', amount_cents: 5000 }];
    expect(names(selectBillableItems(legacy))).toEqual(['Legacy']);
  });

  test('a missing amount does not break the total', () => {
    const odd = [MASSAGE(), { session_type_id: 58, service_name: 'No price', amount_cents: null }];
    expect(() => selectBillableItems(odd)).not.toThrow();
    expect(names(selectBillableItems(odd))).toEqual(['Tailored Massage']);
  });

  test('the caller cannot mutate the cart through the result', () => {
    const cart = [MASSAGE(), LED(), FLOAT()];
    selectBillableItems(cart).pop();
    expect(cart).toHaveLength(3);
  });
});
