// Treatments the team manages in the dashboard ("Bot content" → Treatments):
// pause one, change its menu name or note, change the days it runs.
//
// Until Oct 2026 each was a code edit: the gym combos and acupuncture were
// switched off in DISCONTINUED_SESSION_TYPES, Nervous System Reset and Let It
// Go were tied to their day in DAY_RESTRICTIONS and in prompt prose, and the
// step-1 menu was a hand-written copy of the catalog. A paused treatment must
// be unbookable in code, not just missing from the menu.

const { fakeDb } = require('./helpers/fake-settings-db');

jest.mock('stripe', () => jest.fn().mockImplementation(() => ({
  checkout: { sessions: { create: jest.fn(), expire: jest.fn() } },
  webhooks: { constructEvent: jest.fn() },
})));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/services/whatsapp.service', () => ({
  sendText: jest.fn(), sendButtons: jest.fn(), sendList: jest.fn(), sendCTAButton: jest.fn(),
}));
jest.mock('../src/services/email.service', () => ({}));
jest.mock('../src/services/gift-card-check.service', () => ({}));
jest.mock('../src/services/mindbody.service', () => ({
  getBookableItems: jest.fn(),
  getClasses: jest.fn(),
  getClientByPhone: jest.fn(),
  addAppointment: jest.fn(),
  addClientToClass: jest.fn(),
  getRoomOccupancy: jest.fn().mockResolvedValue({ known: true, busy: new Map() }),
  RESOURCE_MAP: {},
}));
const mockDb = {
  ...fakeDb(),
  getActivePayFirstHolds: jest.fn().mockResolvedValue([]),
  getPendingStripeSessionByAppointment: jest.fn().mockResolvedValue(null),
  logMessage: jest.fn(), logError: jest.fn().mockResolvedValue(true),
  query: jest.fn().mockResolvedValue({ rows: [] }),
};
jest.mock('../src/data/database', () => mockDb);

const mindbody = require('../src/services/mindbody.service');
const conversations = require('../src/services/conversation.service');
const settings = require('../src/services/settings.service');
const catalog = require('../src/services/dynamic-catalog.service');
const { buildSystemPrompt } = require('../src/agents/system-prompt');
const { toolCheckAvailability, toolBookAppointment, toolCheckClassSchedule, toolBookClass } = require('../src/agents/tool-implementations');

const PHONE = '31655555555';
const by = 'Fabiana';
const clone = (v) => JSON.parse(JSON.stringify(v));
const edited = (fn) => { const t = clone(settings.DEFAULTS.treatments); fn(t); return t; };
const prompt = () => buildSystemPrompt('31611111111', 'Alice');
const stepOneMenu = (p) => p.slice(p.indexOf('1. If the treatment is NOT specified'), p.indexOf('2. When a parent group is selected'));
const menuRows = (category) => catalog.buildCategoryWhatsAppSections(catalog.getCatalog(), category).flatMap(s => s.rows);
const slotDay = (day, id) => ({ StartDateTime: `${day}T09:00:00`, EndDateTime: `${day}T19:00:00`, Staff: { Id: 1, Name: 'Room' }, SessionType: { Id: id } });

beforeEach(async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-11-10T08:00:00'));
  jest.clearAllMocks();
  conversations.clear(PHONE);
  mockDb.rows.length = 0;
  await settings.load();
});
afterEach(async () => {
  await settings.save('treatments', clone(settings.DEFAULTS.treatments), { by });
  jest.useRealTimers();
});

describe('a paused treatment', () => {
  beforeEach(async () => {
    expect((await settings.save('treatments', edited(t => { t.items.float.paused = true; }), { by })).ok).toBe(true);
  });

  test('can not be checked or booked, and Mindbody is never asked', async () => {
    const avail = await toolCheckAvailability(PHONE, { session_type_ids: [58], start_date: '2026-11-12', end_date: '2026-11-12' });
    expect(avail.error).toBe('service_paused');
    expect(avail.message).toMatch(/Float Journey/);
    const book = await toolBookAppointment(PHONE, { session_type_id: 58, start_date_time: '2026-11-12T10:00:00', client_name: 'Ann Smit', client_email: 'ann@example.com' });
    expect(book.error).toBe('service_paused');
    expect(mindbody.getBookableItems).not.toHaveBeenCalled();
    expect(mindbody.addAppointment).not.toHaveBeenCalled();
  });

  test('other treatments asked for together are still checked', async () => {
    mindbody.getBookableItems.mockResolvedValue([slotDay('2026-11-12', 64)]);
    const avail = await toolCheckAvailability(PHONE, { session_type_ids: [58, 64], start_date: '2026-11-12', end_date: '2026-11-12' });
    expect(avail.error).toBeUndefined();
    expect(mindbody.getBookableItems).toHaveBeenCalledTimes(1);
    expect(mindbody.getBookableItems.mock.calls[0][0]).toBe(64);
  });

  test('is gone from the menu and the step-1 list, and the bot is told it is paused', () => {
    expect(menuRows('Tech Treatments').map(r => r.id)).not.toContain('svc_58');
    const p = prompt();
    expect(stepOneMenu(p)).not.toMatch(/svc_58/);
    expect(p).toMatch(/Paused for now[^\n]*Float Journey/);
  });
});

test('pausing one massage removes just that option from the massages list', async () => {
  await settings.save('treatments', edited(t => { t.items.prenatal.paused = true; }), { by });
  const subIds = catalog.getCatalog().byGroupId.svc_massages.subOptions.map(s => s.id);
  expect(subIds).not.toContain('svc_pm');
  expect(subIds).toContain('svc_tm');
  expect(prompt()).not.toMatch(/"svc_pm"/);
  const book = await toolBookAppointment(PHONE, { session_type_id: 36, start_date_time: '2026-11-12T10:00:00', client_name: 'Ann Smit', client_email: 'ann@example.com' });
  expect(book.error).toBe('service_paused');
});

test('paused classes can not be listed or booked', async () => {
  await settings.save('treatments', edited(t => { t.items.classes.paused = true; }), { by });
  const sched = await toolCheckClassSchedule(PHONE, { session_type_ids: [83], start_date: '2026-11-12', end_date: '2026-11-12' });
  expect(sched.error).toBe('service_paused');
  const book = await toolBookClass(PHONE, { class_id: 1, session_type_id: 83, class_name: 'Vinyasa', class_date_time: '2026-11-12T10:00:00', client_name: 'Ann Smit', client_email: 'ann@example.com' });
  expect(book.error).toBe('service_paused');
  expect(mindbody.getClasses).not.toHaveBeenCalled();
});

describe('the days a treatment runs', () => {
  test('by default Nervous System Reset is Fridays only and Let It Go Tuesdays only', () => {
    const p = prompt();
    expect(p).toMatch(/\*\*Nervous System Reset\*\* \(session types 45 & 63\): \*\*Fridays only\*\*/);
    expect(p).toMatch(/\*\*Let It Go\*\* \(session type 109\): \*\*Tuesdays only\*\*/);
  });

  test('moving Nervous System Reset to Thursdays changes the slots and the rule', async () => {
    await settings.save('treatments', edited(t => { t.items.nsr.days = [4]; }), { by });
    // 12 November 2026 is a Thursday, 13 November a Friday.
    mindbody.getBookableItems.mockResolvedValue([slotDay('2026-11-12', 45), slotDay('2026-11-13', 45)]);
    const avail = await toolCheckAvailability(PHONE, { session_type_ids: [45], start_date: '2026-11-12', end_date: '2026-11-13' });
    expect(new Set(avail.slots.map(s => s.dateTime.slice(0, 10)))).toEqual(new Set(['2026-11-12']));
    expect(prompt()).toMatch(/\*\*Nervous System Reset\*\* \(session types 45 & 63\): \*\*Thursdays only\*\*/);
  });

  test('every day lifts the restriction', async () => {
    await settings.save('treatments', edited(t => { t.items.nsr.days = []; }), { by });
    expect(prompt()).not.toMatch(/\*\*Nervous System Reset\*\* \(session types 45 & 63\)/);
  });
});

describe('the menu name and note', () => {
  test('a new name and note reach the menu, the step-1 list and the catalog', async () => {
    expect((await settings.save('treatments', edited(t => { t.menu.svc_58 = { name: 'Float', note: '60 min · private cabin' }; }), { by })).ok).toBe(true);
    const row = menuRows('Tech Treatments').find(r => r.id === 'svc_58');
    expect(row).toEqual({ id: 'svc_58', title: 'Float', description: '€80 · 60 min · private cabin' });
    expect(stepOneMenu(prompt())).toMatch(/"svc_58","title":"Float","description":"€80 · 60 min · private cabin"/);
  });

  test('the defaults are the list the bot always showed', () => {
    const menu = stepOneMenu(prompt());
    expect(menu).toMatch(/"svc_finn","title":"Finnish Sauna Journey","description":"€80–90 · 60 min"/);
    expect(menu).toMatch(/"svc_oxy","title":"Oxygen Hydroxy","description":"€50–95 · seated or lying"/);
    expect(menu).toMatch(/"svc_massages","title":"Massages","description":"Tailored · Prenatal · Lymphatic · Nervous System · Let It Go"/);
  });

  test('names and notes must fit WhatsApp', async () => {
    expect((await settings.save('treatments', edited(t => { t.menu.svc_58.name = 'A very long float journey name'; }), { by })).error).toMatch(/24/);
    expect((await settings.save('treatments', edited(t => { t.menu.svc_58.note = 'x'.repeat(70); }), { by })).error).toMatch(/72/);
  });

  test('unknown treatments and days are refused', async () => {
    expect((await settings.save('treatments', edited(t => { t.items.cryo = { paused: false, days: [] }; }), { by })).error).toMatch(/cryo/);
    expect((await settings.save('treatments', edited(t => { t.items.nsr.days = [9]; }), { by })).error).toMatch(/day/);
  });
});
