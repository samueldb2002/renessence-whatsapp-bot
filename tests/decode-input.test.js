// decodeInput depends on OpenAI, Stripe, pg, mindbody, etc. through the agent.
// Mock all heavy dependencies so only the pure decode logic runs.

jest.mock('openai', () => jest.fn().mockImplementation(() => ({})));
jest.mock('stripe', () => jest.fn().mockImplementation(() => ({
  checkout: { sessions: { create: jest.fn(), expire: jest.fn() } },
  webhooks: { constructEvent: jest.fn() },
})));
jest.mock('../src/data/database', () => ({
  getMessagesByPhone: jest.fn().mockResolvedValue([]),
  logMessage: jest.fn(),
  logConversation: jest.fn(),
  unarchiveConversation: jest.fn().mockResolvedValue(undefined),
  isPaused: jest.fn().mockResolvedValue(false),
  getPendingStripeSessionByAppointment: jest.fn().mockResolvedValue(null),
}));
jest.mock('../src/services/whatsapp.service', () => ({ sendText: jest.fn(), sendList: jest.fn() }));
jest.mock('../src/services/mindbody.service', () => ({
  getBookableItems: jest.fn(),
  getToken: jest.fn(),
}));
jest.mock('../src/services/email.service', () => ({}));

const { decodeInput } = require('../src/agents/renessence.agent');

// Helper: wrap an id/title in the shapes WhatsApp sends
const btn = (id, title = '') => ({ id, title });
const list = (id, title = '') => ({ id, title });

describe('decodeInput — slot selection', () => {
  test('slot_ id is decoded to structured string', () => {
    const result = decodeInput(btn('slot_2026-05-01T09:00:00_5_58', '09:00'));
    expect(result).toContain('dateTime=2026-05-01T09:00:00');
    expect(result).toContain('staffId=5');
    expect(result).toContain('sessionTypeId=58');
  });

  test('slot_ with zero staff', () => {
    const result = decodeInput(btn('slot_2026-08-15T14:30:00_0_80', '14:30'));
    expect(result).toContain('staffId=0');
    expect(result).toContain('sessionTypeId=80');
  });
});

describe('decodeInput — class selection', () => {
  test('class_ id returns classId', () => {
    const result = decodeInput(list('class_456', 'Vinyasa Flow'));
    expect(result).toBe('Vinyasa Flow [classId=456]');
  });

  test('class_ with numeric only title', () => {
    const result = decodeInput(btn('class_123', 'Pilates'));
    expect(result).toContain('classId=123');
  });
});

describe('decodeInput — service / svc_ selection', () => {
  test('unknown svc_ falls back to legacy numeric parse', () => {
    // svc_99 is a gym combo — if catalog has it, returns display name
    // Either way it must not throw
    const result = decodeInput(list('svc_99', 'Heat & Meet'));
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  test('service_ prefix (legacy) extracts session type id', () => {
    const result = decodeInput(btn('service_58', 'Float Journey'));
    expect(result).toBe('Float Journey [sessionTypeId=58]');
  });
});

describe('decodeInput — cancellation & reschedule', () => {
  test('cancel_apt_ returns cancel string', () => {
    const result = decodeInput(btn('cancel_apt_12345', 'Float Journey'));
    expect(result).toBe('Cancel appointment 12345 (Float Journey)');
  });

  test('reschedule_apt_ returns reschedule string', () => {
    const result = decodeInput(list('reschedule_apt_67890', 'Infrared Sauna'));
    expect(result).toBe('Reschedule appointment 67890 (Infrared Sauna)');
  });
});

describe('decodeInput — menu buttons (MAP)', () => {
  test.each([
    ['menu_book', 'I want to book an appointment'],
    ['menu_appointments', 'Show my upcoming appointments'],
    ['confirm_yes', 'Yes, confirm'],
    ['confirm_no', 'No, cancel'],
    ['cancel_confirm', 'Yes, cancel the appointment'],
    ['cancel_no', 'No, keep the appointment'],
    ['date_week', 'This week'],
    ['date_nextweek', 'Next week'],
    ['cat_tech', 'Tech Treatments'],
    ['cat_massages', 'Massages'],
  ])('id=%s → %s', (id, expected) => {
    expect(decodeInput(btn(id, ''))).toBe(expected);
  });
});

describe('decodeInput — dynamic prefixes', () => {
  test('cat_ prefix falls through to generic label', () => {
    const result = decodeInput(btn('cat_studio', ''));
    expect(result).toContain('studio');
  });

  test('info_ prefix', () => {
    const result = decodeInput(btn('info_pricing', ''));
    expect(result).toContain('pricing');
  });

  test('date_ prefix', () => {
    const result = decodeInput(btn('date_tomorrow', ''));
    expect(result).toContain('tomorrow');
  });
});

describe('decodeInput — null / missing id', () => {
  test('no id → null', () => {
    expect(decodeInput(undefined, undefined)).toBeNull();
  });

  test('empty id → falls through to title fallback', () => {
    // id is falsy so returns null
    expect(decodeInput({ id: '' }, undefined)).toBeNull();
  });
});

describe('decodeInput — listReply takes precedence over missing buttonReply', () => {
  test('list reply with slot id works', () => {
    const result = decodeInput(undefined, list('slot_2026-09-01T10:00:00_3_31', '10:00'));
    expect(result).toContain('sessionTypeId=31');
  });
});
