// After an outage the bot replays the messages it missed instead of asking
// customers to repeat themselves — within WhatsApp's 24h reply window. Older
// than that only a template can reach them.

jest.mock('../src/data/database', () => ({
  getUnansweredConversations: jest.fn(),
  isBlocked: jest.fn().mockResolvedValue(false),
  isPaused: jest.fn().mockResolvedValue(false),
  logMessage: jest.fn().mockResolvedValue({}),
}));
jest.mock('../src/services/whatsapp.service', () => ({
  sendTemplate: jest.fn().mockResolvedValue({}),
  sendText: jest.fn().mockResolvedValue({}),
}));
jest.mock('../src/services/outage-alert.service', () => ({
  HOLDING_TEXTS: ['holding-en', 'holding-nl'],
}));
jest.mock('../src/agents/renessence.agent', () => ({
  run: jest.fn().mockResolvedValue(undefined),
}));

const db = require('../src/data/database');
const whatsapp = require('../src/services/whatsapp.service');
const agent = require('../src/agents/renessence.agent');
const { runCatchUp } = require('../src/services/catch-up.service');

const NOW = new Date('2026-09-24T18:00:00Z').getTime();
const agoH = (h) => new Date(NOW - h * 3600 * 1000).toISOString();
const row = (phone, name, hoursAgo, content) => ({ phone, customer_name: name, last_user_at: agoH(hoursAgo), content });

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  jest.clearAllMocks();
  delete process.env.WHATSAPP_CATCHUP_TEMPLATE;
  db.isBlocked.mockResolvedValue(false);
  db.isPaused.mockResolvedValue(false);
});
afterEach(() => jest.useRealTimers());

test('a customer inside the 24h window is answered by replaying their own message with an apology flag', async () => {
  db.getUnansweredConversations.mockResolvedValue([row('31618916550', 'K', 2, 'Moeten we badkleding aan ?')]);

  const r = await runCatchUp({ since: agoH(30), delayMs: 0 });

  expect(db.getUnansweredConversations).toHaveBeenCalledWith(agoH(30), expect.any(String), ['holding-en', 'holding-nl']);
  expect(agent.run).toHaveBeenCalledWith('31618916550', 'K', 'Moeten we badkleding aan ?', { catchUp: { hoursAgo: 2 } });
  expect(r.answered).toHaveLength(1);
  expect(r.unreachable).toHaveLength(0);
});

test('older than 24h: reported as unreachable when no template is configured — nothing sent', async () => {
  db.getUnansweredConversations.mockResolvedValue([row('31620497909', 'Rebecca Brown', 27, "That's all")]);

  const r = await runCatchUp({ since: agoH(30), delayMs: 0 });

  expect(agent.run).not.toHaveBeenCalled();
  expect(whatsapp.sendTemplate).not.toHaveBeenCalled();
  expect(r.unreachable).toEqual([expect.objectContaining({ phone: '31620497909', hoursAgo: 27 })]);
});

test('older than 24h with a template: the re-engagement template is sent and logged', async () => {
  db.getUnansweredConversations.mockResolvedValue([row('31640978075', 'Hippi', 27, 'gift code does not work')]);

  const r = await runCatchUp({ since: agoH(30), delayMs: 0, template: { name: 'assistant_back', language: 'en', useNameParam: true } });

  expect(whatsapp.sendTemplate).toHaveBeenCalledWith('31640978075', 'assistant_back', 'en', ['Hippi']);
  expect(db.logMessage).toHaveBeenCalledWith('31640978075', 'assistant', expect.stringMatching(/template "assistant_back"/));
  expect(r.templated).toHaveLength(1);
  expect(agent.run).not.toHaveBeenCalled();
});

test('the template can come from the environment', async () => {
  process.env.WHATSAPP_CATCHUP_TEMPLATE = 'assistant_back_nl';
  process.env.WHATSAPP_CATCHUP_TEMPLATE_LANG = 'nl';
  db.getUnansweredConversations.mockResolvedValue([row('31600000001', 'A', 40, 'hoi')]);

  await runCatchUp({ since: agoH(48), delayMs: 0 });

  expect(whatsapp.sendTemplate).toHaveBeenCalledWith('31600000001', 'assistant_back_nl', 'nl', []);
  delete process.env.WHATSAPP_CATCHUP_TEMPLATE_LANG;
});

test('paused (team handling) and blocked numbers are skipped, never replayed', async () => {
  db.getUnansweredConversations.mockResolvedValue([row('31600000001', 'Susan', 1, 'reschedule?'), row('31600000002', 'Fraud', 1, 'x')]);
  db.isPaused.mockImplementation(async (p) => p === '31600000001');
  db.isBlocked.mockImplementation(async (p) => p === '31600000002');

  const r = await runCatchUp({ since: agoH(5), delayMs: 0 });

  expect(agent.run).not.toHaveBeenCalled();
  expect(r.skipped.map(s => s.reason)).toEqual([expect.stringMatching(/paused/), 'blocked number']);
});

test('dry run lists the plan and sends nothing', async () => {
  db.getUnansweredConversations.mockResolvedValue([row('31600000001', 'A', 1, 'hi'), row('31600000002', 'B', 30, 'hello')]);

  const r = await runCatchUp({ since: agoH(48), dryRun: true, delayMs: 0, template: { name: 'assistant_back' } });

  expect(agent.run).not.toHaveBeenCalled();
  expect(whatsapp.sendTemplate).not.toHaveBeenCalled();
  expect(r.answered).toEqual([expect.objectContaining({ phone: '31600000001', planned: true })]);
  expect(r.unreachable).toEqual([expect.objectContaining({ phone: '31600000002' })]);
});

test('one failing replay does not stop the others', async () => {
  db.getUnansweredConversations.mockResolvedValue([row('31600000001', 'A', 1, 'hi'), row('31600000002', 'B', 1, 'hello')]);
  agent.run.mockRejectedValueOnce(new Error('boom'));

  const r = await runCatchUp({ since: agoH(5), delayMs: 0 });

  expect(r.failed).toEqual([expect.objectContaining({ phone: '31600000001', error: 'boom' })]);
  expect(r.answered).toEqual([expect.objectContaining({ phone: '31600000002' })]);
});
