// FAQ answers the team edits in the dashboard ("Bot content" → FAQ): parking,
// what to bring, pregnancy… Until Oct 2026 they were knowledge-base JSON,
// editable only by a developer. Answers the code itself enforces (the 24-hour
// cancellation rule, membership terms) stay out of the team's list.

const { fakeDb } = require('./helpers/fake-settings-db');

jest.mock('stripe', () => jest.fn().mockImplementation(() => ({ checkout: { sessions: {} }, webhooks: {} })));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockDb = fakeDb();
jest.mock('../src/data/database', () => mockDb);

const settings = require('../src/services/settings.service');
const { buildSystemPrompt } = require('../src/agents/system-prompt');

const by = 'Fabiana';
const clone = (v) => JSON.parse(JSON.stringify(v));
const faqOf = () => {
  const p = buildSystemPrompt('31611111111', 'Alice');
  const kbJson = p.slice(p.indexOf('## Knowledge base') + '## Knowledge base'.length, p.indexOf('## Opening hours, closures and notices')).trim();
  return JSON.parse(kbJson).faq;
};
const edited = (fn) => { const v = clone(settings.DEFAULTS.faq); fn(v.items); return v; };

beforeEach(async () => {
  mockDb.rows.length = 0;
  await settings.load();
});

test('the defaults are the knowledge-base answers', () => {
  const kb = require('../src/data/knowledge-base.json');
  expect(faqOf().parking).toBe(kb.faq.parking);
  expect(settings.DEFAULTS.faq.items.find(i => i.key === 'parking').topic).toBe('Parking');
});

test('an edited answer replaces the old one', async () => {
  expect((await settings.save('faq', edited(items => { items.find(i => i.key === 'parking').answer = 'Free parking in our own garage, entrance on the Gershwinlaan.'; }), { by })).ok).toBe(true);
  expect(faqOf().parking).toBe('Free parking in our own garage, entrance on the Gershwinlaan.');
});

test('a new topic is added and a removed one is gone', async () => {
  await settings.save('faq', edited(items => {
    items.push({ key: '', topic: 'Towels and robes', answer: 'Towels and a robe are ready for you; no need to bring your own.' });
    items.splice(items.findIndex(i => i.key === 'pets'), 1);
  }), { by });
  const faq = faqOf();
  expect(faq.towels_and_robes).toMatch(/Towels and a robe/);
  expect(faq.pets).toBeUndefined();
});

test('answers the code enforces stay out of the team list', async () => {
  expect(settings.DEFAULTS.faq.items.map(i => i.key)).not.toContain('cancellation');
  expect((await settings.save('faq', edited(items => { items.push({ key: 'cancellation', topic: 'Cancellation', answer: 'Free cancellation up to 2 hours before.' }); }), { by })).error).toMatch(/Cancellation/);
  // …and the code's own answer is still what the bot reads.
  expect(faqOf().cancellation).toMatch(/24 uur/);
});

test('a topic needs a name and an answer, once', async () => {
  expect((await settings.save('faq', edited(items => { items[0].answer = ''; }), { by })).error).toMatch(/answer/);
  expect((await settings.save('faq', edited(items => { items.push({ ...items[0] }); }), { by })).error).toMatch(/twice/);
});
