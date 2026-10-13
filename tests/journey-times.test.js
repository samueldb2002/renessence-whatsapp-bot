// The bot booked a float at 15:00 while the website, the app and the team's
// "Journey Times" sheet start that journey at 14:45 (arrival; the float itself
// begins at 15:00). Guests arrived late, and bot bookings collided with the
// website's grid. The windows below are real Mindbody availability (Tue 6 and
// Sat 10 Oct 2026, read via /diag/avail): website bookings start at 13:15,
// 14:45, 16:15 … and each occupies 85 minutes.

jest.mock('stripe', () => jest.fn().mockImplementation(() => ({
  checkout: { sessions: { create: jest.fn(), expire: jest.fn() } },
  webhooks: { constructEvent: jest.fn() },
})));
jest.mock('../src/services/whatsapp.service', () => ({
  sendText: jest.fn(), sendButtons: jest.fn(), sendList: jest.fn(), sendCTAButton: jest.fn(),
}));
jest.mock('../src/services/email.service', () => ({}));
jest.mock('../src/services/gift-card-check.service', () => ({}));
jest.mock('../src/services/mindbody.service', () => ({ getBookableItems: jest.fn() }));
jest.mock('../src/data/database', () => ({
  getPendingStripeSessionByAppointment: jest.fn().mockResolvedValue(null),
  logMessage: jest.fn(), logError: jest.fn().mockResolvedValue(true),
  query: jest.fn().mockResolvedValue({ rows: [] }),
}));

const mindbody = require('../src/services/mindbody.service');
const conversations = require('../src/services/conversation.service');
const { toolCheckAvailability } = require('../src/agents/tool-implementations');
const { SERVICE_SLOT_TIMES } = require('../src/config/slot-times');

const PHONE = '31644444444';
const FLOAT = 58, FINNISH_1P = 87, OXY_SEATED_30 = 92, OXY_SEATED_60 = 94, OXY_LYING_60 = 93, HYDROWAVE = 80, RED_LIGHT = 64, IR_SMALL = 98;

const windows = (day, sessionTypeId, ranges) => ranges.map(([start, end]) => ({
  StartDateTime: `${day}T${start}:00`,
  EndDateTime: `${day}T${end}:00`,
  Staff: { Id: 5, Name: 'Desk' },
  SessionType: { Id: sessionTypeId },
}));

async function offered(day, sessionTypeId, ranges, part_of_day) {
  mindbody.getBookableItems.mockResolvedValue(windows(day, sessionTypeId, ranges));
  const r = await toolCheckAvailability(PHONE, { session_type_ids: [sessionTypeId], start_date: day, end_date: day, ...(part_of_day ? { part_of_day } : {}) });
  return (r.slots || []).map(s => s.timeLabel);
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-10-01T08:00:00'));
  jest.clearAllMocks();
  conversations.clear(PHONE);
});
afterEach(() => jest.useRealTimers());

describe('the grids are the Journey Times sheet', () => {
  test.each([
    ['Float',            FLOAT,         ['07:15', '08:45', '10:15', '11:45', '13:15', '14:45', '16:15', '17:45']],
    ['Finnish Sauna',    FINNISH_1P,    ['08:15', '09:45', '11:15', '12:45', '14:15', '15:45', '17:15']],
  ])('%s journeys start at the sheet times', (_name, id, times) => {
    expect(SERVICE_SLOT_TIMES[id]).toEqual(times);
  });

  test('Oxygen Hydroxy runs the 40-minute grid 07:00–19:00 (seated and lying, 30\' and 60\')', () => {
    for (const id of [92, 94, 71, 93]) {
      expect(SERVICE_SLOT_TIMES[id][0]).toBe('07:00');
      expect(SERVICE_SLOT_TIMES[id]).toContain('14:20');
      expect(SERVICE_SLOT_TIMES[id]).not.toContain('08:50');
      expect(SERVICE_SLOT_TIMES[id][SERVICE_SLOT_TIMES[id].length - 1]).toBe('19:00');
    }
  });

  test('Infrared Sauna every 35 min 07:00–19:50, Red Light every 25 min to 19:30, Hydrowave every 30 min to 19:00', () => {
    expect(SERVICE_SLOT_TIMES[IR_SMALL].slice(0, 3)).toEqual(['07:00', '07:35', '08:10']);
    expect(SERVICE_SLOT_TIMES[IR_SMALL].slice(-1)).toEqual(['19:50']);
    expect(SERVICE_SLOT_TIMES[RED_LIGHT].slice(-2)).toEqual(['19:05', '19:30']);
    expect(SERVICE_SLOT_TIMES[HYDROWAVE].slice(-3)).toEqual(['18:00', '18:30', '19:00']);
  });
});

describe('offers on real Mindbody availability', () => {
  test('Float, Tue 6 Oct: journey times only, and only where the full 85-min block fits', async () => {
    const times = await offered('2026-10-06', FLOAT, [['07:00', '11:00'], ['12:25', '13:15'], ['14:40', '16:15'], ['17:40', '20:00']]);
    // The old grid offered 15:00 here: its 85-min block (to 16:25) runs into the website's 16:15 journey.
    expect(times).toEqual(['07:15', '08:45', '14:45', '17:45']);
  });

  test('Float, Sat 10 Oct (website bookings at 10:15 … 16:15): only 08:45 is really free', async () => {
    const times = await offered('2026-10-10', FLOAT, [['08:00', '10:15'], ['11:40', '11:45'], ['13:10', '13:15'], ['14:40', '14:45'], ['16:10', '16:15'], ['17:40', '18:00']]);
    expect(times).toEqual(['08:45']);
  });

  test('Finnish Sauna, Sat 10 Oct: 08:15–12:45 fit before the 14:15 booking; nothing later fits', async () => {
    const times = await offered('2026-10-10', FINNISH_1P, [['08:00', '14:15'], ['15:40', '15:45'], ['17:10', '18:00']]);
    expect(times).toEqual(['08:15', '09:45', '11:15', '12:45']);
  });

  test('Oxygen seated 30\', Tue 6 Oct: the 40-minute grid around the 11:00, 13:40 and 14:20 bookings', async () => {
    const ranges = [['07:00', '11:00'], ['11:35', '13:40'], ['14:15', '14:20'], ['14:55', '20:00']];
    expect(await offered('2026-10-06', OXY_SEATED_30, ranges, 'morning')).toEqual(['07:00', '07:40', '08:20', '09:00', '09:40', '10:20', '11:40']);
    expect(await offered('2026-10-06', OXY_SEATED_30, ranges, 'afternoon')).toEqual(['12:20', '13:00', '15:00', '15:40', '16:20']);
    expect(await offered('2026-10-06', OXY_SEATED_30, ranges, 'evening')).toEqual(['17:00', '17:40', '18:20', '19:00']);
  });
});

// Team, Oct 2026: an oxygen journey includes 5 minutes' prep (30' → 35-minute
// block, 60' → 65), and a 60' session simply takes two consecutive journeys —
// the grid 07:00, 07:40, 08:20 … never moves. Hydrowave's last journey is 19:00
// on weekdays and 17:00 at weekends (19:30, 20:00 and 20:15 are gone).
describe('Oxygen 60\' and Hydrowave closing times', () => {
  test('a 60\' session needs two consecutive journeys free', async () => {
    // Someone has the 08:20 journey: 07:00 + 65 min fits before it, 07:40 does not.
    expect(await offered('2026-10-06', OXY_SEATED_60, [['07:00', '08:20']])).toEqual(['07:00']);
    expect(await offered('2026-10-06', OXY_LYING_60, [['07:00', '08:20']])).toEqual(['07:00']);
    expect(await offered('2026-10-06', OXY_SEATED_30, [['07:00', '08:20']])).toEqual(['07:00', '07:40']);
    // Only the 07:00 journey is free (07:40 is booked): no room for a 60'.
    expect(await offered('2026-10-06', OXY_SEATED_60, [['07:00', '07:40']])).toEqual([]);
  });

  test('after a 60\' at 07:00 (room free from 08:05) the next journey is still 08:20', async () => {
    expect(await offered('2026-10-06', OXY_SEATED_30, [['08:05', '10:00']])).toEqual(['08:20', '09:00']);
    expect(await offered('2026-10-06', OXY_SEATED_60, [['08:05', '10:00']])).toEqual(['08:20']);
  });

  test('a 60\' is not offered when its 65-minute block runs past closing', async () => {
    expect(await offered('2026-10-06', OXY_SEATED_30, [['18:00', '20:00']])).toEqual(['18:20', '19:00']);
    expect(await offered('2026-10-06', OXY_SEATED_60, [['18:00', '20:00']])).toEqual(['18:20']);
  });

  test('Hydrowave: last journey 19:00 on weekdays, 17:00 on Saturday and Sunday', async () => {
    expect(await offered('2026-10-06', HYDROWAVE, [['07:00', '20:00']], 'evening')).toEqual(['17:00', '17:30', '18:00', '18:30', '19:00']);
    expect(await offered('2026-10-10', HYDROWAVE, [['08:00', '18:00']], 'evening')).toEqual(['17:00']);
    expect(await offered('2026-10-11', HYDROWAVE, [['08:00', '18:00']], 'evening')).toEqual(['17:00']);
    expect(await offered('2026-10-10', HYDROWAVE, [['08:00', '18:00']], 'afternoon')).toContain('16:30');
  });
});
