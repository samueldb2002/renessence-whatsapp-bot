// Gina & Nathalie (Oct 2026): two friends each wanted Red Light + Oxygen at the
// same time. The bot "confirmed" four bookings, but only Gina's two existed —
// the same-turn duplicate check collapsed Nathalie's calls into Gina's, told
// the model they were "already created", and the €150 team rule never fired.

const mockCreate = jest.fn();
jest.mock('openai', () => jest.fn().mockImplementation(() => ({ chat: { completions: { create: mockCreate } } })));
jest.mock('stripe', () => jest.fn().mockImplementation(() => ({
  checkout: { sessions: { create: jest.fn(), expire: jest.fn(), retrieve: jest.fn() } },
  webhooks: { constructEvent: jest.fn() },
})));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/services/whatsapp.service', () => ({
  sendText: jest.fn().mockResolvedValue({}), sendButtons: jest.fn().mockResolvedValue({}),
  sendList: jest.fn().mockResolvedValue({}), sendCTAButton: jest.fn().mockResolvedValue({}),
}));
jest.mock('../src/services/outage-alert.service', () => ({
  recordAgentFailure: jest.fn(), recordAgentSuccess: jest.fn().mockResolvedValue(), holdingMessage: () => 'hold', HOLDING_TEXTS: [],
}));
jest.mock('../src/data/database', () => ({
  getMessagesByPhone: jest.fn().mockResolvedValue([]),
  loadConversationState: jest.fn().mockResolvedValue(null),
  saveConversationState: jest.fn().mockResolvedValue(),
  logMessage: jest.fn(),
  getPayFirstRowsForPhone: jest.fn().mockResolvedValue([]),
  getBookingEventById: jest.fn().mockResolvedValue(null),
  markConversationEscalated: jest.fn(),
  setConversationLanguage: jest.fn().mockResolvedValue(),
}));
jest.mock('../src/agents/tool-implementations', () => ({
  ...jest.requireActual('../src/agents/tool-implementations'),
  toolBookAppointment: jest.fn(),
  executeRespond: jest.fn().mockResolvedValue(),
}));

const tools = require('../src/agents/tool-implementations');
const conversations = require('../src/services/conversation.service');
const agent = require('../src/agents/renessence.agent');

const PHONE = '31645358184';
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const gina = { client_name: 'Gina van Spall', client_email: 'gina@example.com' };
const nathalie = { client_name: 'Nathalie Link', client_email: 'nathalie@example.com' };

function script(...toolCallBatches) {
  mockCreate.mockReset();
  for (const batch of toolCallBatches) {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { role: 'assistant', content: null, tool_calls: batch } }] });
  }
}
const respond = (id) => call(id, 'respond', { message: 'ok', ui_type: 'none' });
/** The tool results the model saw, by tool_call_id. */
function toolResults() {
  const msgs = mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0].messages;
  return Object.fromEntries(msgs.filter(m => m.role === 'tool').map(m => [m.tool_call_id, JSON.parse(m.content)]));
}

beforeEach(() => {
  jest.clearAllMocks();
  conversations.clear(PHONE);
  tools.toolBookAppointment.mockImplementation(async () => ({ success: true, payOnLocation: true }));
});

test('two people × (Red Light + Oxygen) = €190 → the whole order goes to the team, nothing is booked', async () => {
  script(
    [
      call('a', 'book_appointment', { session_type_id: 64, start_date_time: '2026-10-09T08:40:00', ...gina }),
      call('b', 'book_appointment', { session_type_id: 64, start_date_time: '2026-10-09T08:40:00', ...nathalie }),
      call('c', 'book_appointment', { session_type_id: 71, start_date_time: '2026-10-09T09:00:00', ...gina }),
      call('d', 'book_appointment', { session_type_id: 71, start_date_time: '2026-10-09T09:00:00', ...nathalie }),
    ],
    [respond('r')],
  );
  await agent.run(PHONE, 'Gina', 'Bevestig');
  expect(tools.toolBookAppointment).not.toHaveBeenCalled();
  const results = toolResults();
  for (const id of ['a', 'b', 'c', 'd']) expect(results[id]).toMatchObject({ error: 'journey_needs_team', journey_total: '€190' });
});

test('two people, same treatment and time (under €150) → two bookings, one per person', async () => {
  script(
    [
      call('a', 'book_appointment', { session_type_id: 64, start_date_time: '2026-10-09T08:40:00', ...gina }),
      call('b', 'book_appointment', { session_type_id: 64, start_date_time: '2026-10-09T08:40:00', ...nathalie }),
    ],
    [respond('r')],
  );
  await agent.run(PHONE, 'Gina', 'Bevestig');
  expect(tools.toolBookAppointment).toHaveBeenCalledTimes(2);
  expect(tools.toolBookAppointment.mock.calls.map(c => c[1].client_name)).toEqual(['Gina van Spall', 'Nathalie Link']);
});

test('a true repeat (same person) is skipped — and the model is told it is NOT an extra booking', async () => {
  script(
    [
      call('a', 'book_appointment', { session_type_id: 64, start_date_time: '2026-10-09T08:40:00', ...gina }),
      call('b', 'book_appointment', { session_type_id: 64, start_date_time: '2026-10-09T08:40:00', ...gina }),
    ],
    [respond('r')],
  );
  await agent.run(PHONE, 'Gina', 'Bevestig');
  expect(tools.toolBookAppointment).toHaveBeenCalledTimes(1);
  const skipped = toolResults().b;
  expect(skipped.error).toBe('duplicate_booking_skipped');
  expect(skipped.message).toMatch(/NOT an extra booking/);
  expect(skipped.message).not.toMatch(/already created/);
});

test('the AI sees exact treatment names (seated vs lying)', () => {
  const { getServiceName } = require('../src/services/dynamic-catalog.service');
  expect(getServiceName(92)).toBe('Oxygen Hydroxy (seated, 30 min)');
  expect(getServiceName(71)).toBe('Oxygen Hydroxy (lying, 30 min)');
});
