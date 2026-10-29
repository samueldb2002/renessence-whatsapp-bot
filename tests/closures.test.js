// Closed days and special opening hours, set by the team in the dashboard.
//
// Before, the bot had no idea about holidays: a closure only worked if the
// team remembered to empty the Mindbody schedules, and the bot still quoted
// normal hours. Now a closed day can never be offered or booked, and on a
// day with special hours only times within them — in code, not just prompt.

const { fakeDb } = require('./helpers/fake-settings-db');

jest.mock('stripe', () => jest.fn().mockImplementation(() => ({
  checkout: { sessions: { create: jest.fn(), expire: jest.fn() } },
  webhooks: { constructEvent: jest.fn() },
})));
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
const { toolCheckAvailability, toolBookAppointment, toolCheckClassSchedule, toolBookClass } = require('../src/agents/tool-implementations');

const PHONE = '31644444444';
const FLOAT = 58; // room treatment on a fixed grid, 85-minute block
const by = 'Fabiana';

/** An open float room all day, as Mindbody returns it. */
const room = (day) => ({
  StartDateTime: `${day}T08:00:00`, EndDateTime: `${day}T21:00:00`,
  Staff: { Id: 1, Name: 'Float room' }, SessionType: { Id: FLOAT },
});

beforeEach(async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-12-20T08:00:00'));
  jest.clearAllMocks();
  conversations.clear(PHONE);
  mockDb.rows.length = 0;
  await settings.load();
  await settings.save('closures', { items: [
    { from: '2026-12-25', to: '2026-12-26', closed: true, note: 'Christmas' },
    { from: '2026-12-31', closed: false, open: '10:00', close: '16:00', note: "New Year's Eve" },
  ] }, { by });
});
afterEach(() => jest.useRealTimers());

describe('check_availability', () => {
  test('a closed day offers nothing and says why', async () => {
    mindbody.getBookableItems.mockResolvedValue([room('2026-12-25')]);
    const res = await toolCheckAvailability(PHONE, { session_type_ids: [FLOAT], start_date: '2026-12-25', end_date: '2026-12-25' });
    expect(res.slots).toEqual([]);
    expect(res.closed).toBe(true);
    expect(res.message).toMatch(/Christmas/);
  });

  test('over a range, only the closed days drop out', async () => {
    mindbody.getBookableItems.mockResolvedValue([room('2026-12-24'), room('2026-12-25'), room('2026-12-26'), room('2026-12-27')]);
    const res = await toolCheckAvailability(PHONE, { session_type_ids: [FLOAT], start_date: '2026-12-24', end_date: '2026-12-27' });
    const days = new Set(res.slots.map(s => s.dateTime.slice(0, 10)));
    expect([...days].sort()).toEqual(['2026-12-24', '2026-12-27']);
  });

  test('special hours: only times that start and end within them', async () => {
    mindbody.getBookableItems.mockResolvedValue([room('2026-12-31')]);
    const res = await toolCheckAvailability(PHONE, { session_type_ids: [FLOAT], start_date: '2026-12-31', end_date: '2026-12-31' });
    expect(res.slots.length).toBeGreaterThan(0);
    for (const s of res.slots) {
      expect(s.timeLabel >= '10:00').toBe(true);
      const [h, m] = s.timeLabel.split(':').map(Number);
      expect(h * 60 + m + 85).toBeLessThanOrEqual(16 * 60);
    }
  });

  test('a closed day is never remembered as offered', async () => {
    mindbody.getBookableItems.mockResolvedValue([room('2026-12-25'), room('2026-12-27')]);
    await toolCheckAvailability(PHONE, { session_type_ids: [FLOAT], start_date: '2026-12-25', end_date: '2026-12-27' });
    const offered = conversations.get(PHONE)?.offeredSlots || [];
    expect(offered.some(o => o.dateTime.startsWith('2026-12-25'))).toBe(false);
  });
});

describe('book_appointment', () => {
  test('refuses a closed day before touching Mindbody', async () => {
    const res = await toolBookAppointment(PHONE, { session_type_id: FLOAT, start_date_time: '2026-12-25T10:00:00', client_name: 'Ann Smit', client_email: 'ann@example.com' });
    expect(res.error).toBe('closed');
    expect(res.message).toMatch(/Christmas/);
    expect(mindbody.getClientByPhone).not.toHaveBeenCalled();
    expect(mindbody.addAppointment).not.toHaveBeenCalled();
  });

  // The refusal is English instructions for the model; a Dutch day name
  // ("vrijdag 25 december") in it could reach an English-speaking guest.
  test('names the day in English, like the rest of the message', async () => {
    const res = await toolBookAppointment(PHONE, { session_type_id: FLOAT, start_date_time: '2026-12-25T10:00:00', client_name: 'Ann Smit', client_email: 'ann@example.com' });
    expect(res.message).toMatch(/Friday 25 December 2026/);
    expect(res.message).not.toMatch(/vrijdag/);
  });

  test('refuses a time outside special hours', async () => {
    const res = await toolBookAppointment(PHONE, { session_type_id: FLOAT, start_date_time: '2026-12-31T15:30:00', client_name: 'Ann Smit', client_email: 'ann@example.com' });
    expect(res.error).toBe('closed');
    expect(mindbody.addAppointment).not.toHaveBeenCalled();
  });
});

describe('classes', () => {
  const cls = (start) => ({ Id: 7, StartDateTime: start, MaxCapacity: 10, TotalBooked: 0, ClassDescription: { Name: 'Vinyasa', SessionType: { Id: 83 } } });

  test('classes on a closed day are not listed', async () => {
    mindbody.getClasses.mockResolvedValue([cls('2026-12-25T10:00:00'), cls('2026-12-27T10:00:00')]);
    const res = await toolCheckClassSchedule(PHONE, { session_type_ids: [83], start_date: '2026-12-25', end_date: '2026-12-27' });
    expect(res.classes.map(c => c.dateTime.slice(0, 10))).toEqual(['2026-12-27']);
  });

  test('booking a class on a closed day is refused', async () => {
    const res = await toolBookClass(PHONE, { class_id: 7, session_type_id: 83, class_name: 'Vinyasa', class_date_time: '2026-12-25T10:00:00', client_name: 'Ann Smit', client_email: 'ann@example.com' });
    expect(res.error).toBe('closed');
    expect(mindbody.addClientToClass).not.toHaveBeenCalled();
  });
});
