// The catalog is what the customer SEES; PRICE_MAP is what Stripe CHARGES.
// These drifted apart once already: the menu quoted Prenatal at €110 and
// Lymphatic at €120 while PRICE_MAP billed €130 for both, so a customer could
// be quoted one price and shown a Stripe link for another. These tests pin the
// two together permanently.

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    checkout: { sessions: { create: jest.fn(), expire: jest.fn() } },
    webhooks: { constructEvent: jest.fn() },
  }));
});

jest.mock('../src/data/database', () => ({
  getPendingStripeSessionByAppointment: jest.fn().mockResolvedValue(null),
}));

const { PRICE_MAP } = require('../src/services/payment.service');
const { DISPLAY_GROUPS } = require('../src/services/dynamic-catalog.service');

/**
 * Every €-amount in a string, as numbers. Ranges carry a single € sign
 * ("€130–170"), so the trailing half is captured separately.
 */
function eurosIn(text) {
  const found = [];
  for (const m of String(text || '').matchAll(/€(\d+)(?:\s*[–—-]\s*(\d+))?/g)) {
    found.push(Number(m[1]));
    if (m[2] !== undefined) found.push(Number(m[2]));
  }
  return found;
}

describe('catalog labels agree with PRICE_MAP', () => {
  const subOptions = DISPLAY_GROUPS.flatMap(grp =>
    (grp.subOptions || []).map(sub => ({ grp, sub }))
  );

  // A sub-option that resolves to exactly one session type and quotes a price
  // must quote THAT session type's price.
  const priced = subOptions.filter(
    ({ sub }) => sub.sessionTypeIds.length === 1 && eurosIn(sub.label).length === 1
  );

  test('there are priced sub-options to check', () => {
    expect(priced.length).toBeGreaterThan(10);
  });

  test.each(priced.map(({ sub }) => [sub.label, sub.sessionTypeIds[0]]))(
    'sub-option "%s" (session type %i) quotes its PRICE_MAP price',
    (label, sessionTypeId) => {
      const expected = PRICE_MAP[sessionTypeId] / 100;
      expect(eurosIn(label)[0]).toBe(expected);
    }
  );

  // A group description like "€130–170 · personalised massage" must span the
  // real min/max of the session types in that group.
  const rangeGroups = DISPLAY_GROUPS.filter(grp => {
    const found = eurosIn(grp.description);
    return found.length === 2 && grp.sessionTypeIds.every(id => PRICE_MAP[id] != null);
  });

  test.each(rangeGroups.map(grp => [grp.display, grp]))(
    'group "%s" description spans its real price range',
    (_display, grp) => {
      const prices = grp.sessionTypeIds.map(id => PRICE_MAP[id] / 100);
      expect(eurosIn(grp.description)).toEqual([
        Math.min(...prices),
        Math.max(...prices),
      ]);
    }
  );
});

describe('massage prices', () => {
  // The team's rule: every massage is €130 for 60 min and €170 for 80 min.
  const SIXTY = { 31: 'Tailored', 35: 'Prenatal', 37: 'Lymphatic', 45: 'Nervous System' };
  const EIGHTY = { 32: 'Tailored', 36: 'Prenatal', 38: 'Lymphatic', 63: 'Nervous System' };

  test.each(Object.entries(SIXTY))('%s 60 min is €130', (id) => {
    expect(PRICE_MAP[id]).toBe(13000);
  });

  test.each(Object.entries(EIGHTY))('%s 80 min is €170', (id) => {
    expect(PRICE_MAP[id]).toBe(17000);
  });
});
