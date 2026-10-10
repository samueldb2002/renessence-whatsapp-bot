// Paula's stage 2 + 3: payment status for team links, re-opening a chat after
// WhatsApp's 24-hour window, and the Dutch <-> English translator.

const express = require('express');
const request = require('supertest');

jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/services/whatsapp.service', () => ({
  sendText: jest.fn().mockResolvedValue({}),
  sendTemplate: jest.fn().mockResolvedValue({}),
  sendCTAButton: jest.fn().mockResolvedValue({}),
}));
jest.mock('../src/services/mindbody.service', () => ({}));
jest.mock('../src/services/payment.service', () => ({
  PRICE_MAP: {},
  createCustomPaymentLink: jest.fn().mockResolvedValue({ sessionId: 'cs_team_1', paymentUrl: 'https://pay.example/1' }),
}));
jest.mock('../src/services/translation.service', () => ({ translate: jest.fn() }));
jest.mock('../src/data/database', () => ({
  getLastInboundMessageAt: jest.fn(),
  getGuestLanguage: jest.fn().mockResolvedValue('nl'),
  query: jest.fn().mockResolvedValue({ rows: [{ customer_name: 'Floor Clijsen' }] }),
  isPaused: jest.fn().mockResolvedValue(false),
  pauseConversation: jest.fn().mockResolvedValue(undefined),
  queueTeamMessage: jest.fn().mockResolvedValue(undefined),
  logMessage: jest.fn().mockResolvedValue(undefined),
  clearNeedsReply: jest.fn().mockResolvedValue(undefined),
  recordManualPaymentLink: jest.fn().mockResolvedValue(undefined),
  getConversationStatus: jest.fn().mockResolvedValue(null),
  markReopenSent: jest.fn().mockResolvedValue(undefined),
  cancelQueuedTeamMessages: jest.fn().mockResolvedValue(1),
  claimQueuedTeamMessages: jest.fn(),
  releaseQueuedTeamMessage: jest.fn().mockResolvedValue(undefined),
}));

const db = require('../src/data/database');
const whatsapp = require('../src/services/whatsapp.service');
const translationMock = require('../src/services/translation.service');

const TOKEN = 'test-token';
process.env.DASHBOARD_API_TOKEN = TOKEN;
const app = express();
app.use(express.json());
app.use('/api/dashboard', require('../src/routes/dashboard.routes'));
const post = (path, body) => request(app).post(`/api/dashboard${path}`).set('Authorization', `Bearer ${TOKEN}`).send(body || {});

const HOUR = 3600 * 1000;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.WHATSAPP_REOPEN_TEMPLATE = 'team_reply_waiting';
  process.env.WHATSAPP_REOPEN_TEMPLATE_LANGS = 'en,nl';
  process.env.WHATSAPP_REOPEN_TEMPLATE_HAS_NAME = 'true';
  db.getLastInboundMessageAt.mockResolvedValue(new Date(Date.now() - 30 * HOUR).toISOString());
  db.getGuestLanguage.mockResolvedValue('nl');
  db.isPaused.mockResolvedValue(false);
  db.getConversationStatus.mockResolvedValue(null);
});

describe('re-opening a chat after the 24h window', () => {
  test('sends the template in the guest\'s language with their first name, queues the reply, pauses the bot', async () => {
    const res = await post('/conversations/31630316040/reopen', { message: 'Je massage staat vrijdag om 14:35 klaar.' });

    expect(res.body).toEqual({ success: true, queued: true, templateSent: true, paused: true });
    expect(whatsapp.sendTemplate).toHaveBeenCalledWith('31630316040', 'team_reply_waiting', 'nl', ['Floor']);
    expect(db.queueTeamMessage).toHaveBeenCalledWith('31630316040', 'Je massage staat vrijdag om 14:35 klaar.');
    expect(db.pauseConversation).toHaveBeenCalledWith('31630316040', 'Floor Clijsen');
    expect(db.clearNeedsReply).toHaveBeenCalledWith('31630316040');
    expect(db.markReopenSent).toHaveBeenCalledWith('31630316040');
    expect(whatsapp.sendText).not.toHaveBeenCalled(); // the reply itself waits for the guest
  });

  test('while an invitation is still unanswered, a further reply only joins the queue — no second paid template', async () => {
    db.getConversationStatus.mockResolvedValue({ reopen_sent_at: new Date(Date.now() - 2 * HOUR).toISOString() });
    db.isPaused.mockResolvedValue(true);
    const res = await post('/conversations/31630316040/reopen', { message: 'Nog één ding: neem slippers mee.' });
    expect(res.body).toEqual({ success: true, queued: true, templateSent: false, paused: true });
    expect(whatsapp.sendTemplate).not.toHaveBeenCalled();
    expect(db.queueTeamMessage).toHaveBeenCalledWith('31630316040', 'Nog één ding: neem slippers mee.');
  });

  test('once the guest answered after an invitation and the window closed again, a new invitation is allowed', async () => {
    db.getConversationStatus.mockResolvedValue({ reopen_sent_at: new Date(Date.now() - 23 * HOUR).toISOString() });
    db.getLastInboundMessageAt.mockResolvedValue(new Date(Date.now() - 22 * HOUR).toISOString()); // answered, but window open
    const open = await post('/conversations/31630316040/reopen', { message: 'x' });
    expect(open.body).toMatchObject({ windowOpen: true });
    db.getConversationStatus.mockResolvedValue({ reopen_sent_at: new Date(Date.now() - 60 * HOUR).toISOString() });
    db.getLastInboundMessageAt.mockResolvedValue(new Date(Date.now() - 50 * HOUR).toISOString());
    await post('/conversations/31630316040/reopen', { message: 'x' });
    expect(whatsapp.sendTemplate).toHaveBeenCalledTimes(1);
  });

  test('a waiting reply can be cancelled', async () => {
    const res = await post('/conversations/31630316040/queued/12/cancel');
    expect(res.body).toEqual({ success: true });
    expect(db.cancelQueuedTeamMessages).toHaveBeenCalledWith('31630316040', 12);
  });

  test('cancelling a reply that already went out says so', async () => {
    db.cancelQueuedTeamMessages.mockResolvedValueOnce(0);
    const res = await post('/conversations/31630316040/queued/12/cancel');
    expect(res.body).toMatchObject({ success: false, alreadySent: true });
  });

  test('a direct reply in an open window sends the parked replies first, in order', async () => {
    db.getLastInboundMessageAt.mockResolvedValue(new Date(Date.now() - 1 * HOUR).toISOString());
    db.claimQueuedTeamMessages.mockResolvedValue([{ id: 7, content: 'parked' }]);
    const res = await post('/conversations/31630316040/send', { message: 'new reply' });
    expect(res.body).toEqual({ success: true });
    expect(whatsapp.sendText.mock.calls.map(c => c[1])).toEqual(['parked', 'new reply']);
  });

  test('if a parked reply fails, the direct reply is held back too (order)', async () => {
    db.getLastInboundMessageAt.mockResolvedValue(new Date(Date.now() - 1 * HOUR).toISOString());
    db.claimQueuedTeamMessages.mockResolvedValue([{ id: 7, content: 'parked' }]);
    whatsapp.sendText.mockRejectedValueOnce(new Error('timeout'));
    const res = await post('/conversations/31630316040/send', { message: 'new reply' });
    expect(res.body.success).toBe(false);
    expect(whatsapp.sendText).toHaveBeenCalledTimes(1); // only the failed parked attempt
  });

  test('falls back to the first configured language', async () => {
    db.getGuestLanguage.mockResolvedValue('en');
    process.env.WHATSAPP_REOPEN_TEMPLATE_LANGS = 'nl';
    await post('/conversations/31600000001/reopen');
    expect(whatsapp.sendTemplate).toHaveBeenCalledWith('31600000001', 'team_reply_waiting', 'nl', ['Floor']);
    expect(db.queueTeamMessage).not.toHaveBeenCalled();
  });

  test('refuses while the window is still open — a normal reply works then', async () => {
    db.getLastInboundMessageAt.mockResolvedValue(new Date(Date.now() - 2 * HOUR).toISOString());
    const res = await post('/conversations/31600000001/reopen', { message: 'hi' });
    expect(res.body).toMatchObject({ success: false, windowOpen: true });
    expect(whatsapp.sendTemplate).not.toHaveBeenCalled();
  });

  test('explains what is missing when no template is configured', async () => {
    delete process.env.WHATSAPP_REOPEN_TEMPLATE;
    const res = await post('/conversations/31600000001/reopen', { message: 'hi' });
    expect(res.body).toMatchObject({ success: false, notConfigured: true });
    expect(whatsapp.sendTemplate).not.toHaveBeenCalled();
    expect(db.queueTeamMessage).not.toHaveBeenCalled();
  });

  test('a template WhatsApp refuses is reported, nothing queued or paused', async () => {
    whatsapp.sendTemplate.mockRejectedValueOnce(Object.assign(new Error('400'), { response: { data: { error: { message: 'Template name does not exist in the translation' } } } }));
    const res = await post('/conversations/31600000001/reopen', { message: 'hi' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: false });
    expect(res.body.error).toMatch(/Template name does not exist/);
    expect(db.queueTeamMessage).not.toHaveBeenCalled();
    expect(db.pauseConversation).not.toHaveBeenCalled();
  });
});

describe('team payment links are tracked once delivered', () => {
  test('the link is recorded with its Stripe session after WhatsApp accepted it', async () => {
    db.getLastInboundMessageAt.mockResolvedValue(new Date(Date.now() - 1 * HOUR).toISOString());
    const res = await post('/conversations/31600000001/payment-link', { amount: '80', description: 'Float Journey' });
    expect(res.body.success).toBe(true);
    expect(db.recordManualPaymentLink).toHaveBeenCalledWith({ phone: '31600000001', sessionId: 'cs_team_1', amountCents: 8000, description: 'Float Journey' });
  });
});

describe('translate route', () => {
  test('returns the translation', async () => {
    translationMock.translate.mockResolvedValue('Can we come with two people on Saturday?');
    const res = await post('/translate', { text: 'Kunnen we zaterdag met z\'n tweeën komen?', target: 'en' });
    expect(res.body).toEqual({ translated: 'Can we come with two people on Saturday?' });
  });
  test('rejects an unknown target language', async () => {
    const res = await post('/translate', { text: 'hallo', target: 'de' });
    expect(res.status).toBe(400);
  });
  test('hides provider errors from the dashboard', async () => {
    translationMock.translate.mockRejectedValue(new Error('429 You have no credits remaining'));
    const res = await post('/translate', { text: 'hallo', target: 'en' });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Translation failed — please try again.');
  });
});

describe('queued replies go out when the guest answers', () => {
  const { deliverQueuedTeamMessages } = require('../src/services/team-queue.service');

  test('in order, each logged as a team message', async () => {
    db.claimQueuedTeamMessages.mockResolvedValue([{ id: 7, content: 'first' }, { id: 8, content: 'second' }]);
    expect(await deliverQueuedTeamMessages('31600000001')).toEqual({ sent: 2, failed: false });
    expect(whatsapp.sendText.mock.calls.map(c => c[1])).toEqual(['first', 'second']);
    expect(db.logMessage).toHaveBeenCalledWith('31600000001', 'team', 'first');
    expect(db.clearNeedsReply).not.toHaveBeenCalled(); // the guest's new message still needs reading
  });

  test('a failed send stops delivery so replies never go out of order; the rest waits too', async () => {
    db.claimQueuedTeamMessages.mockResolvedValue([{ id: 7, content: 'first' }, { id: 8, content: 'second' }]);
    whatsapp.sendText.mockRejectedValueOnce(new Error('timeout'));
    expect(await deliverQueuedTeamMessages('31600000001')).toEqual({ sent: 0, failed: true });
    expect(db.releaseQueuedTeamMessage).toHaveBeenCalledWith(7, true);   // tried: keeps its attempt
    expect(db.releaseQueuedTeamMessage).toHaveBeenCalledWith(8, false);  // never tried: attempt given back
    expect(whatsapp.sendText).toHaveBeenCalledTimes(1);
  });
});
