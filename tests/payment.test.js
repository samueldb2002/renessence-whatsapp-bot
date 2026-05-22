// payment.service.js requires Stripe with a real API key at load time.
// We mock the stripe module so the service loads without credentials.
jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    checkout: { sessions: { create: jest.fn(), expire: jest.fn() } },
    webhooks: { constructEvent: jest.fn() },
  }));
});

// Also mock the database so it doesn't try to connect
jest.mock('../src/data/database', () => ({
  getPendingStripeSessionByAppointment: jest.fn().mockResolvedValue(null),
}));

const { getPriceInCents, getPrice, PRICE_MAP } = require('../src/services/payment.service');

describe('getPriceInCents', () => {
  // ── Gym combo treatments (€50 = 5000 cents) ────────────────────────────────
  test.each([99, 100, 101, 102, 103, 104, 105])(
    'session type %i → 5000 cents (Gym combo €50)',
    (id) => expect(getPriceInCents(id)).toBe(5000)
  );

  // ── Tech Treatments ─────────────────────────────────────────────────────────
  test('Float Journey (58) → 8000 cents (€80)', () => {
    expect(getPriceInCents(58)).toBe(8000);
  });

  test('Hyperbaric 60 min seated (75) → 9500 cents (€95)', () => {
    expect(getPriceInCents(75)).toBe(9500);
  });

  test('Hyperbaric 30 min seated (74) → 5000 cents (€50)', () => {
    expect(getPriceInCents(74)).toBe(5000);
  });

  test('Finnish Sauna 1p (87) → 8000 cents (€80)', () => {
    expect(getPriceInCents(87)).toBe(8000);
  });

  test('Finnish Sauna 2p (69) → 8000 cents (€80)', () => {
    expect(getPriceInCents(69)).toBe(8000);
  });

  test('Finnish Sauna 3p (66) → 9000 cents (€90)', () => {
    expect(getPriceInCents(66)).toBe(9000);
  });

  test('Red Light Therapy (64) → 4500 cents (€45)', () => {
    expect(getPriceInCents(64)).toBe(4500);
  });

  test('Hydrowave (80) → 3000 cents (€30)', () => {
    expect(getPriceInCents(80)).toBe(3000);
  });

  test('Studio Classes (83) → 2200 cents (€22)', () => {
    expect(getPriceInCents(83)).toBe(2200);
  });

  // ── Traditional Treatments ──────────────────────────────────────────────────
  test('Acupuncture first session (43) → 15000 cents (€150)', () => {
    expect(getPriceInCents(43)).toBe(15000);
  });

  test('Orchid Facial (41) → 16500 cents (€165)', () => {
    expect(getPriceInCents(41)).toBe(16500);
  });

  test('Tailored Massage 60 min (31) → 13000 cents (€130)', () => {
    expect(getPriceInCents(31)).toBe(13000);
  });

  test('Tailored Massage 80 min (32) → 17000 cents (€170)', () => {
    expect(getPriceInCents(32)).toBe(17000);
  });

  // ── Unknown session type ────────────────────────────────────────────────────
  test('unknown session type → null', () => {
    expect(getPriceInCents(9999)).toBeNull();
  });

  test('0 → null', () => {
    expect(getPriceInCents(0)).toBeNull();
  });
});

describe('getPrice', () => {
  test('converts cents to euros correctly', () => {
    expect(getPrice(58)).toBe(80);
    expect(getPrice(100)).toBe(50);
    expect(getPrice(43)).toBe(150);
  });

  test('unknown session type → null', () => {
    expect(getPrice(9999)).toBeNull();
  });
});

describe('PRICE_MAP completeness', () => {
  test('all values are positive integers (cents)', () => {
    for (const [id, cents] of Object.entries(PRICE_MAP)) {
      expect(Number.isInteger(cents)).toBe(true);
      expect(cents).toBeGreaterThan(0);
    }
  });

  test('all values are multiples of 100 (whole euros)', () => {
    for (const [id, cents] of Object.entries(PRICE_MAP)) {
      expect(cents % 100).toBe(0);
    }
  });

  test('contains all 7 gym combo IDs', () => {
    [99, 100, 101, 102, 103, 104, 105].forEach(id => {
      expect(PRICE_MAP[id]).toBeDefined();
    });
  });
});
