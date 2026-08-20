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

describe('knowledge base agrees with PRICE_MAP', () => {
  // The Dutch FAQ data carries prices in two places: the massage "types" lines
  // and the "pricing" section. Both fed the bot's chat answers, and both had
  // drifted (Prenatal €110, Lymphatic €120, Float €75, Sauna €70, intake €140).
  const kb = require('../src/data/knowledge-base.json');
  const cents = id => PRICE_MAP[id] / 100;

  // "60min EUR 130 / 80min EUR 170" — the treatment type lines
  test.each([
    ['Tailored Massage', 31, 32],
    ['Prenatal Massage', 35, 36],
    ['Lymphatic Drainage', 37, 38],
  ])('types line "%s" quotes the billed prices', (key, id60, id80) => {
    const line = kb.treatments.traditional.massage.types[key];
    expect(line).toContain(`60min EUR ${cents(id60)}`);
    expect(line).toContain(`80min EUR ${cents(id80)}`);
  });

  // The "pricing" FAQ section, entry → session type
  test.each([
    ['traditional_treatments', 'massage', 'Tailored 60 min', 31],
    ['traditional_treatments', 'massage', 'Tailored 80 min', 32],
    ['traditional_treatments', 'massage', 'Prenatal 60 min', 35],
    ['traditional_treatments', 'massage', 'Prenatal 80 min', 36],
    ['traditional_treatments', 'massage', 'Lymphatic Drainage 60 min', 37],
    ['traditional_treatments', 'massage', 'Lymphatic Drainage 80 min', 38],
    ['traditional_treatments', 'acupuncture', 'Eerste sessie 75 min', 43],
    ['traditional_treatments', 'acupuncture', 'Vervolg 60 min', 44],
    ['traditional_treatments', 'acupuncture', 'Vervolg 75 min', 52],
    ['tech_treatments', 'float', '1 persoon (60 min)', 58],
    ['tech_treatments', 'finnish_sauna', 'Solo (60 min)', 87],
  ])('pricing.%s.%s["%s"] quotes the billed price', (section, group, key, sessionTypeId) => {
    expect(kb.pricing[section][group][key]).toContain(`EUR ${cents(sessionTypeId)}`);
  });

  test('Nervous System Reset single session quotes €130', () => {
    expect(kb.pricing.traditional_treatments.nervous_system_reset['1 sessie 90 min'])
      .toContain(`EUR ${cents(45)}`);
  });

  // A third pocket of prices: the treatment DESCRIPTIONS also carry them.
  test.each([
    ['Eerste sessie (75 min)', 43],
    ['Vervolg (60 min)', 44],
    ['Vervolg (75 min)', 52],
  ])('acupuncture description "%s" quotes the billed price', (key, sessionTypeId) => {
    expect(kb.treatments.traditional.acupuncture.durations_and_prices[key])
      .toContain(`EUR ${cents(sessionTypeId)}`);
  });

  test('NSR description quotes the billed single-session price', () => {
    expect(kb.treatments.traditional.nervous_system_reset.prices['Enkele sessie'])
      .toContain(`EUR ${cents(45)}`);
  });
});

describe('cron class list agrees with the catalog', () => {
  // expire-bookings deliberately duplicates the catalog's isClass ids instead
  // of importing the catalog (which would drag Stripe into the cron). This
  // test is the sync contract: add a class to the catalog and the cron's list
  // must follow, or unpaid enrolments of the new class become unreleasable.
  test('CLASS_SESSION_TYPES covers exactly the catalog isClass session types', () => {
    const { CLASS_SESSION_TYPES } = require('../src/services/expire-bookings.service');
    const catalogClassIds = DISPLAY_GROUPS
      .filter(g => g.isClass)
      .flatMap(g => g.sessionTypeIds);
    expect([...CLASS_SESSION_TYPES].sort()).toEqual([...new Set(catalogClassIds)].sort());
  });
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
