// What the bot is told about opening hours, closures, notices and contact
// details comes from the team's dashboard edits, not from code. One source:
// the knowledge base no longer carries its own copy of these facts, so the
// bot can't quote an old opening time next to the new one.

const { fakeDb } = require('./helpers/fake-settings-db');

jest.mock('stripe', () => jest.fn().mockImplementation(() => ({ checkout: { sessions: {} }, webhooks: {} })));
const mockDb = fakeDb();
jest.mock('../src/data/database', () => mockDb);

const settings = require('../src/services/settings.service');
const { buildSystemPrompt } = require('../src/agents/system-prompt');

const by = 'Fabiana';
const section = (prompt) => prompt.slice(prompt.indexOf('## Opening hours, closures and notices'), prompt.indexOf('\n## Session'));

beforeEach(async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-12-01T10:00:00'));
  mockDb.rows.length = 0;
  await settings.load();
});
afterEach(() => jest.useRealTimers());

test('the prompt has the team-edited section after the knowledge base and before Session', () => {
  const p = buildSystemPrompt('31611111111', 'Alice');
  const facts = p.indexOf('## Opening hours, closures and notices');
  expect(facts).toBeGreaterThan(p.indexOf('## Knowledge base'));
  expect(facts).toBeLessThan(p.indexOf('\n## Session'));
});

test('default hours are grouped by identical days', () => {
  const s = section(buildSystemPrompt('31611111111', 'Alice'));
  expect(s).toContain('Monday–Thursday 07:00–21:00');
  expect(s).toContain('Friday 07:00–20:00');
  expect(s).toContain('Sunday 09:00–18:00');
  expect(s).toContain('George Gershwinlaan 520, 1082 MT Amsterdam');
});

test('the knowledge base no longer carries its own opening hours, address or contact', () => {
  const p = buildSystemPrompt('31611111111', 'Alice');
  const kbJson = p.slice(p.indexOf('## Knowledge base'), p.indexOf('## Opening hours, closures and notices'));
  expect(kbJson).not.toContain('"opening_hours"');
  expect(kbJson).not.toContain('"contact":{"general"');
  expect(kbJson).not.toContain('George Gershwinlaan');
  expect(kbJson).toContain('"parking"'); // the rest of location stays
});

test('edited hours, a closure, special hours and a notice reach the bot without a redeploy', async () => {
  await settings.save('hours', { ...settings.hours(), sunday: { closed: true } }, { by });
  await settings.save('closures', { items: [
    { from: '2026-12-25', to: '2026-12-26', closed: true, note: 'Christmas' },
    { from: '2026-12-31', closed: false, open: '09:00', close: '17:00', note: "New Year's Eve" },
  ] }, { by });
  await settings.save('notices', { items: [{ text: 'Float cabin in maintenance', until: '2026-12-03' }] }, { by });
  const s = section(buildSystemPrompt('31611111111', 'Alice'));
  expect(s).toContain('Sunday closed');
  expect(s).toContain('Friday 25 December 2026 – Saturday 26 December 2026: closed (Christmas)');
  expect(s).toContain("Thursday 31 December 2026: open 09:00–17:00 only (New Year's Eve)");
  expect(s).toContain('Float cabin in maintenance (until Thursday 3 December 2026)');
});

test('expired notices and closures that are over disappear by themselves', async () => {
  await settings.save('closures', { items: [{ from: '2026-12-02', closed: true, note: 'Staff day' }] }, { by });
  await settings.save('notices', { items: [{ text: 'Hammam closed', until: '2026-12-02' }] }, { by });
  jest.setSystemTime(new Date('2026-12-03T09:00:00'));
  const s = section(buildSystemPrompt('31611111111', 'Alice'));
  expect(s).not.toContain('Staff day');
  expect(s).not.toContain('Hammam closed');
  expect(s).toContain('No closures or special opening hours are planned.');
});

test('a changed email address replaces the old one everywhere in the prompt', async () => {
  await settings.save('contact', { ...settings.contact(), emails: { ...settings.contact().emails, events: 'evenementen@renessence.nl' } }, { by });
  const p = buildSystemPrompt('31611111111', 'Alice');
  expect(p).not.toContain('events@renessence.com');
  expect(p).toContain('evenementen@renessence.nl');
  expect(p.match(/evenementen@renessence\.nl/g).length).toBeGreaterThan(2);
});

test('two customers still share the prompt prefix with edits in place', async () => {
  await settings.save('notices', { items: [{ text: 'Float cabin in maintenance', until: '2026-12-31' }] }, { by });
  const a = buildSystemPrompt('31611111111', 'Alice');
  const b = buildSystemPrompt('31622222222', 'Bob');
  expect(a.slice(0, a.indexOf('\n## Session'))).toBe(b.slice(0, b.indexOf('\n## Session')));
});
