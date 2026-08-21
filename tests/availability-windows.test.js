// The "no afternoon availability while the calendar is wide open" bug
// (Jane Foo / Fabi's report, 10 Oct 2026).
//
// Mindbody returns ONE availability record per schedule-availability row the
// team enters. When a therapist's afternoon is entered as stacked ~60-minute
// rows, no single record fits an 80-minute session — even though the
// CONTIGUOUS free time fits it easily and booking it by hand in Mindbody
// works. Touching/overlapping records must be merged per therapist before
// slot generation.

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
}));
jest.mock('../src/data/database', () => ({
  getPendingStripeSessionByAppointment: jest.fn().mockResolvedValue(null),
  logMessage: jest.fn(), logError: jest.fn().mockResolvedValue(true),
  query: jest.fn().mockResolvedValue({ rows: [] }),
}));

const mindbody = require('../src/services/mindbody.service');
const conversations = require('../src/services/conversation.service');
const { toolCheckAvailability } = require('../src/agents/tool-implementations');

const PHONE = '31633333333';
const TAILORED_80 = 32; // 80-minute Tailored Massage
const DAY = '2026-10-10';

/** One Mindbody availability record, as the API returns it. */
function win(staffId, staffName, start, end) {
  return {
    StartDateTime: `${DAY}T${start}:00`,
    EndDateTime: `${DAY}T${end}:00`,
    Staff: { Id: staffId, Name: staffName },
    SessionType: { Id: TAILORED_80 },
  };
}

// The schedule from the team's calendar screenshot: mornings entered as one
// ~90-min row, afternoons as stacked 60-min rows that TOUCH each other.
const SCREENSHOT_SCHEDULE = [
  win(11, 'Merel M',   '09:00', '10:30'), // fits 80 → 09:00 (the bot got this right)
  win(11, 'Merel M',   '13:00', '14:00'), // lone 60-min row — genuinely can't fit 80
  win(11, 'Merel M',   '15:00', '16:00'), // ┐ touching rows: contiguous 15:00–17:00,
  win(11, 'Merel M',   '16:00', '17:00'), // ┘ which fits an 80-min session at 15:00
  win(12, 'Esmeralda', '10:00', '11:30'), // fits 80 → 10:00 (the bot got this right)
  win(12, 'Esmeralda', '15:00', '16:00'), // ┐ same contiguous afternoon pair
  win(12, 'Esmeralda', '16:00', '17:00'), // ┘
];

beforeEach(() => {
  jest.clearAllMocks();
  conversations.clear(PHONE);
  mindbody.getBookableItems.mockResolvedValue(SCREENSHOT_SCHEDULE);
});

describe('fragmented therapist schedules (the Jane Foo bug)', () => {
  test('touching 60-min rows merge, so the afternoon 80-min slot EXISTS', async () => {
    const result = await toolCheckAvailability(PHONE, {
      session_type_ids: [TAILORED_80], start_date: DAY, end_date: DAY,
    });

    const times = result.slots.map(s => s.timeLabel);
    expect(times).toContain('09:00'); // morning kept
    expect(times).toContain('10:00');
    expect(times).toContain('15:00'); // the slot the bot denied existed
  });

  test('the afternoon filter finds the merged slot instead of claiming none', async () => {
    const result = await toolCheckAvailability(PHONE, {
      session_type_ids: [TAILORED_80], start_date: DAY, end_date: DAY,
      part_of_day: 'afternoon',
    });

    expect(result.no_availability).toBeUndefined();
    expect(result.slots.map(s => s.timeLabel)).toContain('15:00');
  });

  test('a lone 60-min row still yields no 80-min slot — merging never invents time', async () => {
    const result = await toolCheckAvailability(PHONE, {
      session_type_ids: [TAILORED_80], start_date: DAY, end_date: DAY,
    });

    // 13:00–14:00 stands alone: 80 min genuinely does not fit there.
    expect(result.slots.map(s => s.timeLabel)).not.toContain('13:00');
    // And nothing may start where the merged block can't contain the session:
    // 16:00 + 80min = 17:20 > 17:00.
    expect(result.slots.map(s => s.timeLabel)).not.toContain('16:00');
  });

  test('windows of DIFFERENT therapists never merge', async () => {
    // Two therapists covering 15:00–16:00 and 16:00–17:00 separately is NOT
    // two free hours for one 80-min session.
    mindbody.getBookableItems.mockResolvedValue([
      win(11, 'Merel M',   '15:00', '16:00'),
      win(12, 'Esmeralda', '16:00', '17:00'),
    ]);

    const result = await toolCheckAvailability(PHONE, {
      session_type_ids: [TAILORED_80], start_date: DAY, end_date: DAY,
    });

    expect(result.slots).toEqual([]);
  });

  test('a truncated Mindbody page is drained via pagination, not read as "less availability"', async () => {
    const { fetchAllPages } = jest.requireActual('../src/services/mindbody.service');
    const pageA = Array.from({ length: 200 }, (_, i) => ({ id: i }));
    const pageB = Array.from({ length: 40 }, (_, i) => ({ id: 200 + i }));
    const fetchPage = jest.fn()
      .mockResolvedValueOnce({ items: pageA, total: 240 })
      .mockResolvedValueOnce({ items: pageB, total: 240 });

    const all = await fetchAllPages(fetchPage);

    expect(all).toHaveLength(240);
    expect(fetchPage).toHaveBeenNthCalledWith(1, 0, 200);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 200, 200);
  });

  test('pagination stops on a short page and never loops past the cap', async () => {
    const { fetchAllPages } = jest.requireActual('../src/services/mindbody.service');
    const shortPage = jest.fn().mockResolvedValue({ items: [{ id: 1 }], total: undefined });
    expect(await shortPage && (await fetchAllPages(shortPage)).length).toBe(1);
    expect(shortPage).toHaveBeenCalledTimes(1); // one page, one request — the normal case

    // An API that ignores Limit/Offset and returns identical full pages must
    // terminate at the page cap rather than loop forever.
    const stuck = jest.fn().mockResolvedValue({ items: Array.from({ length: 200 }, (_, i) => ({ id: i })), total: undefined });
    await fetchAllPages(stuck);
    expect(stuck.mock.calls.length).toBeLessThanOrEqual(10);
  });

  test('overlapping duplicate records merge instead of double-counting', async () => {
    mindbody.getBookableItems.mockResolvedValue([
      win(11, 'Merel M', '14:00', '15:30'),
      win(11, 'Merel M', '14:30', '16:00'), // overlaps the previous row
    ]);

    const result = await toolCheckAvailability(PHONE, {
      session_type_ids: [TAILORED_80], start_date: DAY, end_date: DAY,
    });

    // Merged 14:00–16:00 fits 80 min at both grid times 14:00 (→15:20) — and
    // the narrow/wide split may add the window start; either way 14:00 exists
    // exactly once.
    const at14 = result.slots.filter(s => s.timeLabel === '14:00');
    expect(at14).toHaveLength(1);
  });
});
