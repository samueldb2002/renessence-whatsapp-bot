// Passes & Memberships and packages, edited by the team in the dashboard.
// Both were prose in code (config/offering.js, the "Oxygen 5x package" prompt
// block) and in the knowledge base (the 5x/3x packs), so a new price meant a
// redeploy — and the rules quote the 1 Month Pass price by name.

const { fakeDb } = require('./helpers/fake-settings-db');

jest.mock('stripe', () => jest.fn().mockImplementation(() => ({ checkout: { sessions: {} }, webhooks: {} })));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockDb = fakeDb();
jest.mock('../src/data/database', () => mockDb);

const settings = require('../src/services/settings.service');
const { buildSystemPrompt } = require('../src/agents/system-prompt');

const by = 'Fabiana';
const clone = (v) => JSON.parse(JSON.stringify(v));
const prompt = () => buildSystemPrompt('31611111111', 'Alice');
const knowledgeBaseOf = (p) => p.slice(p.indexOf('## Knowledge base'), p.indexOf('## Opening hours, closures and notices'));
const sectionOf = (p, heading) => { const a = p.indexOf(heading); return p.slice(a, p.indexOf('\n## ', a + 3)); };

beforeEach(async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-11-10T10:00:00'));
  mockDb.rows.length = 0;
  await settings.load();
});
afterEach(() => jest.useRealTimers());

describe('Passes & Memberships', () => {
  const edited = (fn) => { const m = clone(settings.DEFAULTS.memberships); fn(m); return m; };
  const item = (m, name) => m.groups.flatMap(g => g.items).find(i => i.name === name);

  test('a new price reaches the list and every rule that quotes it', async () => {
    expect((await settings.save('memberships', edited(m => { item(m, '1 Month Pass').priceEur = 310; }), { by })).ok).toBe(true);
    const p = prompt();
    expect(p).toContain('1 Month Pass — €310 for 1 month. Does NOT renew automatically.');
    expect(p).toMatch(/say the 1 Month Pass is €310/);
    expect(p).toMatch(/the 1 Month Pass, €310, is always available/);
    expect(p).not.toMatch(/€295/);
  });

  test('a product the team removes is gone, and so is the rule about it', async () => {
    await settings.save('memberships', edited(m => { m.groups[0].items = m.groups[0].items.filter(i => i.name !== '6 Month Pass'); }), { by });
    const p = prompt();
    expect(sectionOf(p, '## Passes & Memberships')).not.toMatch(/6 Month Pass/);
    // The reception-only intro offer rule is fixed, whatever the list says.
    expect(p).toMatch(/Never mention the reception-only intro offer/);
  });

  test('prices are whole euros, and every group has a name and at least one product', async () => {
    expect((await settings.save('memberships', edited(m => { item(m, '3 Month Pass').priceEur = 27.5; }), { by })).error).toMatch(/3 Month Pass.*whole euros/);
    expect((await settings.save('memberships', edited(m => { m.groups[1].items = []; }), { by })).error).toMatch(/Memberships.*at least one/);
    expect((await settings.save('memberships', edited(m => { m.groups[2].name = ''; }), { by })).error).toMatch(/name/);
  });
});

describe('packages', () => {
  test('the packages are their own section, and gone from the knowledge base', () => {
    const p = prompt();
    const packages = sectionOf(p, '## Packages');
    expect(packages).toMatch(/5x Hyperbaric Oxygen Hydroxy/);
    expect(packages).toMatch(/€350/);
    expect(packages).toMatch(/Infrared Sauna.*€125/);
    expect(packages).toMatch(/Nervous System Reset.*€360/);
    expect(knowledgeBaseOf(p)).not.toMatch(/5x Pack|3x Pack|EUR 350 \(i\.p\.v\./);
    expect(p).not.toMatch(/## Oxygen 5x package/);
  });

  test('an edited package is what the bot quotes', async () => {
    const v = { items: [{ name: 'Float 3x', text: 'Three Float Journeys for €210, valid for 6 months.' }] };
    expect((await settings.save('packages', v, { by })).ok).toBe(true);
    const packages = sectionOf(prompt(), '## Packages');
    expect(packages).toMatch(/Float 3x/);
    expect(packages).not.toMatch(/Hyperbaric/);
  });

  test('a package needs a name and a description', async () => {
    expect((await settings.save('packages', { items: [{ name: '', text: 'Three Float Journeys for €210.' }] }, { by })).error).toMatch(/name/);
    expect((await settings.save('packages', { items: [{ name: 'Float 3x', text: 'x' }] }, { by })).error).toMatch(/Float 3x/);
  });
});
