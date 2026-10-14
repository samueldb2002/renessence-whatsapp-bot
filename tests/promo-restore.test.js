// The PT promotion is logged as a bot message just before the guest's first
// message is handled. The history restore treated ANY earlier row as an
// ongoing conversation ("CONTINUING CONVERSATION — do not greet"), so every
// brand-new guest lost the AI-assistant welcome during the campaign.

const mockCreate = jest.fn();
jest.mock('openai', () => jest.fn().mockImplementation(() => ({ chat: { completions: { create: mockCreate } } })));
jest.mock('stripe', () => jest.fn().mockImplementation(() => ({
  checkout: { sessions: { create: jest.fn(), expire: jest.fn(), retrieve: jest.fn() } },
  webhooks: { constructEvent: jest.fn() },
})));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/services/whatsapp.service', () => ({
  sendText: jest.fn().mockResolvedValue({}), sendButtons: jest.fn().mockResolvedValue({}),
  sendList: jest.fn().mockResolvedValue({}), sendCTAButton: jest.fn().mockResolvedValue({}), sendImage: jest.fn().mockResolvedValue({}),
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
  executeRespond: jest.fn().mockResolvedValue(),
}));

const db = require('../src/data/database');
const conversations = require('../src/services/conversation.service');
const agent = require('../src/agents/renessence.agent');
const { CAMPAIGNS } = require('../src/services/intro-promo.service');

const PHONE = '31600000001';
const respond = { id: 'r', type: 'function', function: { name: 'respond', arguments: JSON.stringify({ message: 'ok', ui_type: 'none' }) } };

async function systemPromptFor(rows) {
  conversations.clear(PHONE);
  db.getMessagesByPhone.mockResolvedValue(rows);
  mockCreate.mockReset();
  mockCreate.mockResolvedValueOnce({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [respond] } }] });
  await agent.run(PHONE, 'Gina', 'Hi');
  return mockCreate.mock.calls[0][0].messages[0].content;
}

test('a brand-new guest who only got the promo is greeted as new', async () => {
  const p = await systemPromptFor([{ role: 'assistant', content: CAMPAIGNS[0].caption.en }]);
  expect(p).not.toMatch(/CONTINUING CONVERSATION/);
});

test('a guest with an earlier chat is still a continuing conversation', async () => {
  const p = await systemPromptFor([
    { role: 'user', content: 'Can I book a float?' },
    { role: 'assistant', content: 'Sure! Which day?' },
    { role: 'assistant', content: CAMPAIGNS[0].caption.nl },
  ]);
  expect(p).toMatch(/CONTINUING CONVERSATION/);
});
