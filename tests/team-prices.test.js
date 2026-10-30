// Prices and order rules the team edits in the dashboard ("Bot content" →
// Prices, Behaviour).
//
// A price lived in PRICE_MAP (what Stripe charges), in catalog labels, in the
// step-1 menu and the rules of the prompt, and in knowledge-base text. They
// drifted once (the menu quoted Prenatal at €110 while Stripe billed €130), so
// a price edit must move all of them together — or none.

const { fakeDb } = require('./helpers/fake-settings-db');

jest.mock('stripe', () => jest.fn().mockImplementation(() => ({ checkout: { sessions: {} }, webhooks: {} })));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockDb = fakeDb();
jest.mock('../src/data/database', () => mockDb);

const settings = require('../src/services/settings.service');
const payment = require('../src/services/payment.service');
const catalog = require('../src/services/dynamic-catalog.service');
const { buildSystemPrompt } = require('../src/agents/system-prompt');
const { DEFAULT_PRICES, BOOKABLE_PRICE_IDS } = require('../src/config/prices');

const by = 'Fabiana';
const defaults = () => clone(settings.DEFAULTS.prices);
const clone = (v) => JSON.parse(JSON.stringify(v));
const withPrices = (changes) => { const v = defaults(); Object.assign(v.cents, changes); return v; };
const prompt = () => buildSystemPrompt('31611111111', 'Alice');
const knowledgeBaseOf = (p) => p.slice(p.indexOf('## Knowledge base'), p.indexOf('## Opening hours, closures and notices'));

beforeEach(async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-11-10T10:00:00'));
  mockDb.rows.length = 0;
  await settings.load();
});
afterEach(() => jest.useRealTimers());

describe('saving prices', () => {
  test('every bookable treatment has a price, in whole euros up to €1000', async () => {
    const missing = defaults(); delete missing.cents['31'];
    expect((await settings.save('prices', missing, { by })).error).toMatch(/Tailored Massage 60 min/);
    expect((await settings.save('prices', withPrices({ 31: 13050 }), { by })).error).toMatch(/whole euros/);
    expect((await settings.save('prices', withPrices({ 31: 0 }), { by })).error).toMatch(/€1 and €1000/);
    expect((await settings.save('prices', withPrices({ 31: 150000 }), { by })).error).toMatch(/€1 and €1000/);
    expect((await settings.save('prices', withPrices({ 9999: 1000 }), { by })).error).toMatch(/9999/);
    expect((await settings.save('prices', withPrices({ 31: 14000 }), { by })).ok).toBe(true);
  });

  test('the defaults are the code prices of exactly the bookable treatments', () => {
    expect(Object.keys(defaults().cents).map(Number).sort((a, b) => a - b)).toEqual([...BOOKABLE_PRICE_IDS].sort((a, b) => a - b));
    for (const id of BOOKABLE_PRICE_IDS) expect(defaults().cents[id]).toBe(DEFAULT_PRICES[id]);
  });
});

// The regression the plan names: menu, labels, quotes and the charge move together.
describe('a price edit changes the menu, the catalog label and the charged amount together', () => {
  beforeEach(async () => {
    await settings.save('prices', withPrices({ 31: 14000, 58: 8500, 83: 2500 }), { by });
  });
  afterEach(async () => { await settings.save('prices', defaults(), { by }); });

  test('what Stripe charges', () => {
    expect(payment.PRICE_MAP[31]).toBe(14000);
    expect(payment.getPriceInCents(31)).toBe(14000);
    expect(payment.getPrice(58)).toBe(85);
  });

  test('the catalog labels and the WhatsApp list', () => {
    const c = catalog.getCatalog();
    expect(c.byGroupId.svc_31._subOption.label).toBe('60 min – €140');
    expect(c.byGroupId.svc_tm.description).toMatch(/^€140–170/);
    expect(c.byGroupId.svc_58.description).toMatch(/^€85/);
    const rows = catalog.buildCategoryWhatsAppSections(c, 'Tech Treatments')[0].rows;
    expect(rows.find(r => r.id === 'svc_58').description).toMatch(/^€85/);
  });

  test('the prompt: catalog, step-1 menu, examples and rules', () => {
    const p = prompt();
    expect(p).toMatch(/"svc_58",\s*"title":"Float Journey",\s*"description":"€85 · 60 min"/);
    expect(p).toMatch(/"svc_tm","title":"Tailored Massage",\s*"description":"€140–170 · 60 or 80 min"/);
    expect(p).toMatch(/Send payment link \(€25\)/);
    expect(p).not.toMatch(/"description":"€80 · 60 min"/);
  });

  test('the knowledge-base prices the bot reads', () => {
    const kb = knowledgeBaseOf(prompt());
    expect(kb).toMatch(/Tailored Massage":"60min EUR 140 \/ 80min EUR 170"/);
    expect(kb).toMatch(/1 persoon \(60 min\)":"Vanaf EUR 85"/);
    expect(kb).toMatch(/"single_class":"EUR 25"/);
    expect(kb).not.toMatch(/Tailored Massage":"60min EUR 130/);
  });
});

test('a scheduled price change switches on at its time, everywhere at once', async () => {
  await settings.save('prices', withPrices({ 64: 5000 }), { by, effectiveFrom: new Date('2026-12-01T00:00:00').toISOString() });
  expect(payment.PRICE_MAP[64]).toBe(4500);
  expect(catalog.getCatalog().byGroupId.svc_64.description).toMatch(/^€45/);
  jest.setSystemTime(new Date('2026-12-01T00:00:30'));
  await settings.load(); // the minute reload
  expect(payment.PRICE_MAP[64]).toBe(5000);
  expect(catalog.getCatalog().byGroupId.svc_64.description).toMatch(/^€50/);
  expect(prompt()).toMatch(/"svc_64",\s*"title":"Red Light Therapy",\s*"description":"€50 · 15 min"/);
  await settings.save('prices', defaults(), { by });
});

describe('orders that go to the team', () => {
  afterEach(async () => { await settings.save('behaviour', clone(settings.DEFAULTS.behaviour), { by }); });

  test('the threshold moves the team rule and the prepay backstop together', async () => {
    expect((await settings.save('behaviour', { ...clone(settings.DEFAULTS.behaviour), teamThresholdEur: 200 }, { by })).ok).toBe(true);
    expect(payment.JOURNEY_TEAM_THRESHOLD_CENTS).toBe(20000);
    expect(payment.JOURNEY_PREPAY_THRESHOLD_CENTS).toBe(20000);
    // A €155 journey is no longer prepaid in full: float and red light stay for reception.
    const cart = [{ session_type_id: 58, amount_cents: 8000 }, { session_type_id: 64, amount_cents: 4500 }, { session_type_id: 30, amount_cents: 3000 }];
    expect(payment.selectBillableItems(cart).map(i => i.session_type_id)).toEqual([30]);
    const p = prompt();
    expect(p).toMatch(/## Orders of €200 or more \(2\+ treatments\)/);
    // The examples are recomputed: Massage 60 (€130) + Red Light (€45) = €175 → book it.
    expect(p).toMatch(/Massage 60 min \(€130\) \+ Red Light \(€45\) = €175 → book it/);
  });

  test('a threshold must be whole euros between €50 and €2000', async () => {
    expect((await settings.save('behaviour', { ...clone(settings.DEFAULTS.behaviour), teamThresholdEur: 20 }, { by })).error).toMatch(/€50 and €2000/);
  });

  test('who gets the team emails', async () => {
    expect((await settings.save('behaviour', { ...clone(settings.DEFAULTS.behaviour), escalationEmail: 'nope' }, { by })).error).toMatch(/email/i);
    await settings.save('behaviour', { ...clone(settings.DEFAULTS.behaviour), escalationEmail: 'team@renessence.com' }, { by });
    expect(settings.teamInbox()).toBe('team@renessence.com');
  });
});
