// The PT-promotion intro is wired into the message handler: never on a
// button/list tap (that always answers an earlier bot message), and inside
// the guest's lock — a fresh guest's quick second message used to take the
// lock while the first one was still sending the promo, and got answered first.
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/services/whatsapp.service', () => ({ sendText: jest.fn().mockResolvedValue({}) }));
jest.mock('../src/agents/renessence.agent', () => ({ run: jest.fn(), decodeInput: jest.fn(() => 'Confirm') }));
jest.mock('../src/services/intro-promo.service', () => ({ maybeSendIntroPromo: jest.fn() }));
jest.mock('../src/services/team-queue.service', () => ({ deliverQueuedTeamMessages: jest.fn().mockResolvedValue(0) }));
jest.mock('../src/routes/dashboard.routes', () => ({ isBotPaused: () => false }));
jest.mock('../src/data/database', () => ({
  logConversation: jest.fn(), logMessage: jest.fn().mockResolvedValue(undefined),
  isBlocked: jest.fn().mockResolvedValue(false), isPaused: jest.fn().mockResolvedValue(false),
  unarchiveConversation: jest.fn().mockResolvedValue(undefined), setNeedsReply: jest.fn(),
}));

const agent = require('../src/agents/renessence.agent');
const promo = require('../src/services/intro-promo.service');
const { handle } = require('../src/handlers/message.handler');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
beforeEach(() => { jest.clearAllMocks(); promo.maybeSendIntroPromo.mockResolvedValue(false); agent.run.mockResolvedValue(); });

test('a typed message is offered to the promo, a tap is marked as a tap', async () => {
  await handle({ from: '31600000011', name: 'Sanne', text: 'Hi there' });
  expect(promo.maybeSendIntroPromo).toHaveBeenLastCalledWith('31600000011', { text: 'Hi there', isTap: false });
  await handle({ from: '31600000011', name: 'Sanne', buttonReply: { id: 'confirm_booking', title: 'Confirm' } });
  expect(promo.maybeSendIntroPromo).toHaveBeenLastCalledWith('31600000011', { text: 'Confirm', isTap: true });
});

test('two quick messages: promo, answer to the first, then the second', async () => {
  const events = [];
  promo.maybeSendIntroPromo.mockImplementation(async (_from, { text }) => { events.push(`promo:${text}`); if (text === 'A') await sleep(60); });
  agent.run.mockImplementation(async (_from, _name, text) => { events.push(`run:${text}`); await sleep(10); });
  const first = handle({ from: '31600000012', name: 'Tom', text: 'A' });
  await sleep(5);
  const second = handle({ from: '31600000012', name: 'Tom', text: 'B' });
  await Promise.all([first, second]);
  expect(events).toEqual(['promo:A', 'run:A', 'promo:B', 'run:B']);
});

test('a failing promo never blocks the answer', async () => {
  promo.maybeSendIntroPromo.mockRejectedValue(new Error('db down'));
  await handle({ from: '31600000013', name: 'Ann', text: 'Hi' });
  expect(agent.run).toHaveBeenCalledWith('31600000013', 'Ann', 'Hi');
});
