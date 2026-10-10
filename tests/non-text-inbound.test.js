// A guest answering the re-open invitation with a photo or a template button
// must still count as writing: queued team replies go out, and a paused chat
// gets no automatic bot answer.
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/services/whatsapp.service', () => ({ sendText: jest.fn().mockResolvedValue({}) }));
jest.mock('../src/agents/renessence.agent', () => ({ run: jest.fn(), decodeInput: jest.fn() }));
jest.mock('../src/services/intro-promo.service', () => ({ maybeSendIntroPromo: jest.fn() }));
jest.mock('../src/services/team-queue.service', () => ({ deliverQueuedTeamMessages: jest.fn().mockResolvedValue(1) }));
jest.mock('../src/routes/dashboard.routes', () => ({ isBotPaused: () => false }));
jest.mock('../src/data/database', () => ({
  logConversation: jest.fn(), logMessage: jest.fn().mockResolvedValue(undefined),
  isBlocked: jest.fn().mockResolvedValue(false), isPaused: jest.fn().mockResolvedValue(false),
  unarchiveConversation: jest.fn().mockResolvedValue(undefined), setNeedsReply: jest.fn(),
}));

const db = require('../src/data/database');
const whatsapp = require('../src/services/whatsapp.service');
const teamQueue = require('../src/services/team-queue.service');
const { handle, handleNonText } = require('../src/handlers/message.handler');

beforeEach(() => { jest.clearAllMocks(); db.isPaused.mockResolvedValue(false); db.isBlocked.mockResolvedValue(false); });

test('a photo on a paused chat: no bot reply, the team is flagged, parked replies go out', async () => {
  db.isPaused.mockResolvedValue(true);
  await handleNonText({ from: '31600000001', name: 'Sanne', type: 'photo', alreadyLogged: true, ack: 'Bedankt voor je foto!' });
  expect(whatsapp.sendText).not.toHaveBeenCalled();
  expect(db.setNeedsReply).toHaveBeenCalledWith('31600000001', 'New photo — bot is paused');
  expect(teamQueue.deliverQueuedTeamMessages).toHaveBeenCalledWith('31600000001');
  expect(db.logMessage).not.toHaveBeenCalled(); // already logged as [image:#id]
});

test('an unsupported message on an active chat gets the short notice and still delivers parked replies', async () => {
  await handle({ from: '31600000002', name: 'Tom', type: 'sticker', text: '' });
  expect(db.logMessage).toHaveBeenCalledWith('31600000002', 'user', '[sticker message]');
  expect(whatsapp.sendText).toHaveBeenCalledWith('31600000002', 'Sorry, I can only process text messages.');
  expect(teamQueue.deliverQueuedTeamMessages).toHaveBeenCalledWith('31600000002');
});

test('a blocked number stays silent', async () => {
  db.isBlocked.mockResolvedValue(true);
  await handleNonText({ from: '31600000003', type: 'video', ack: 'x' });
  expect(whatsapp.sendText).not.toHaveBeenCalled();
  expect(teamQueue.deliverQueuedTeamMessages).not.toHaveBeenCalled();
});
