// Dashboard API for team-edited settings ("Bot content" page), and the
// bot-wide pause that used to reset to "running" on every redeploy.

const express = require('express');
const request = require('supertest');
const { fakeDb } = require('./helpers/fake-settings-db');

jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/services/whatsapp.service', () => ({}));
jest.mock('../src/services/mindbody.service', () => ({}));
jest.mock('../src/services/payment.service', () => ({ PRICE_MAP: {} }));
jest.mock('../src/services/translation.service', () => ({ translate: jest.fn() }));
const mockDb = fakeDb();
jest.mock('../src/data/database', () => mockDb);

const settings = require('../src/services/settings.service');
const routes = require('../src/routes/dashboard.routes');

const TOKEN = 'test-token';
process.env.DASHBOARD_API_TOKEN = TOKEN;
process.env.BOT_STOP_PASSWORD = 'stop-pw';
const app = express();
app.use(express.json());
app.use('/api/dashboard', routes);
const post = (path, body) => request(app).post(`/api/dashboard${path}`).set('Authorization', `Bearer ${TOKEN}`).send(body || {});
const get = (path) => request(app).get(`/api/dashboard${path}`).set('Authorization', `Bearer ${TOKEN}`);

const EDIT = 'edit-pw';
const notice = { items: [{ text: 'Float cabin in maintenance', until: '2099-01-01' }] };

beforeEach(async () => {
  process.env.SETTINGS_EDIT_PASSWORD = EDIT;
  mockDb.rows.length = 0;
  await settings.load();
});

describe('the bot-wide pause survives a redeploy', () => {
  test('Stop is stored, and the bot reads it after a reload', async () => {
    const res = await post('/bot-stop', { password: 'stop-pw' });
    expect(res.status).toBe(200);
    expect(mockDb.rows.find(r => r.section === 'bot_pause').value).toEqual({ paused: true });
    await settings.load();
    expect(routes.isBotPaused()).toBe(true);
    expect((await get('/bot-status')).body.paused).toBe(true);
    await post('/bot-start', { password: 'stop-pw' });
    await settings.load();
    expect(routes.isBotPaused()).toBe(false);
  });

  test('a wrong password changes nothing', async () => {
    const res = await post('/bot-stop', { password: 'nope' });
    expect(res.status).toBe(403);
    expect(routes.isBotPaused()).toBe(false);
  });
});

describe('GET /settings', () => {
  test('returns every editable section with its value, default and who changed it', async () => {
    await settings.save('notices', notice, { by: 'Fabiana' });
    const res = await get('/settings');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.sections).sort()).toEqual(['closures', 'contact', 'hours', 'notices']);
    expect(res.body.sections.notices.value).toEqual(notice);
    expect(res.body.sections.notices.updatedBy).toBe('Fabiana');
    expect(res.body.sections.hours.default.monday).toEqual({ open: '07:00', close: '21:00' });
  });
});

describe('POST /settings/:section', () => {
  test('saves with the edit password and a name', async () => {
    const res = await post('/settings/notices', { value: notice, by: 'Fabiana', password: EDIT });
    expect(res.status).toBe(200);
    expect(res.body.section.value).toEqual(notice);
    expect(settings.activeNotices().map(n => n.text)).toEqual(['Float cabin in maintenance']);
  });

  test('a wrong edit password is refused and nothing is stored', async () => {
    const res = await post('/settings/notices', { value: notice, by: 'Fabiana', password: 'wrong' });
    expect(res.status).toBe(403);
    expect(mockDb.rows).toHaveLength(0);
  });

  test('no edit password configured on the server: refused, never open', async () => {
    delete process.env.SETTINGS_EDIT_PASSWORD;
    const res = await post('/settings/notices', { value: notice, by: 'Fabiana', password: '' });
    expect(res.status).toBe(500);
    expect(mockDb.rows).toHaveLength(0);
  });

  test('invalid data comes back as a 400 with the readable reason', async () => {
    const res = await post('/settings/notices', { value: { items: [{ text: 'No end date' }] }, by: 'Fabiana', password: EDIT });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/end date/i);
  });

  test('a scheduled change shows up under scheduled, not as the value', async () => {
    const effectiveFrom = new Date(Date.now() + 86400000).toISOString();
    const res = await post('/settings/notices', { value: notice, by: 'Fabiana', password: EDIT, effectiveFrom });
    expect(res.status).toBe(200);
    expect(res.body.section.value).toEqual({ items: [] });
    expect(res.body.section.scheduled).toHaveLength(1);
  });
});

describe('history, restore, cancel', () => {
  test('history lists versions newest first; restore brings one back', async () => {
    await post('/settings/notices', { value: notice, by: 'Fabiana', password: EDIT });
    await post('/settings/notices', { value: { items: [] }, by: 'Paula', password: EDIT });
    const hist = await get('/settings/notices/history');
    expect(hist.body.history.map(h => h.savedBy)).toEqual(['Paula', 'Fabiana']);
    const restore = await post(`/settings/history/${hist.body.history[1].id}/restore`, { by: 'Paula', password: EDIT });
    expect(restore.status).toBe(200);
    expect(settings.activeNotices()).toHaveLength(1);
  });

  test('cancel a scheduled change', async () => {
    const effectiveFrom = new Date(Date.now() + 86400000).toISOString();
    const saved = await post('/settings/notices', { value: notice, by: 'Fabiana', password: EDIT, effectiveFrom });
    const id = saved.body.section.scheduled[0].id;
    const res = await post(`/settings/history/${id}/cancel`, { by: 'Fabiana', password: EDIT });
    expect(res.status).toBe(200);
    expect(res.body.section.scheduled).toHaveLength(0);
  });

  test('restore needs the edit password too', async () => {
    await post('/settings/notices', { value: notice, by: 'Fabiana', password: EDIT });
    const res = await post('/settings/history/1/restore', { by: 'Paula', password: 'wrong' });
    expect(res.status).toBe(403);
  });
});

describe('password check and preview', () => {
  test('the page can check the edit password once before showing forms', async () => {
    expect((await post('/settings/check-password', { password: EDIT })).body.ok).toBe(true);
    expect((await post('/settings/check-password', { password: 'x' })).status).toBe(403);
  });

  test('preview shows what the bot will be told for a draft, without saving it', async () => {
    const inAMonth = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const res = await post('/settings/preview', { section: 'closures', value: { items: [{ from: inAMonth, closed: true, note: 'Christmas' }] } });
    expect(res.status).toBe(200);
    expect(res.body.text).toMatch(/Christmas/);
    expect(mockDb.rows).toHaveLength(0);
  });
});
