// Promotion posters uploaded on the dashboard. A poster used to be a file in
// public/ plus a code change and a redeploy; the container's files are wiped
// on every deploy, so posters live in the database and are served from there
// on a public, unguessable address (WhatsApp fetches media without our token).

const express = require('express');
const request = require('supertest');
const { fakeDb } = require('./helpers/fake-settings-db');

jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/services/whatsapp.service', () => ({}));
jest.mock('../src/services/mindbody.service', () => ({}));
jest.mock('../src/services/payment.service', () => ({ PRICE_MAP: {} }));
jest.mock('../src/services/translation.service', () => ({ translate: jest.fn() }));
const mockImages = new Map();
const mockDb = Object.assign(fakeDb(), {
  async insertCampaignImage({ id, mime, bytes, uploadedBy }) { mockImages.set(id, { mime, bytes: Buffer.from(bytes), uploadedBy }); },
  async getCampaignImage(id) { const i = mockImages.get(id); return i ? { mime: i.mime, bytes: i.bytes } : null; },
  async campaignImageExists(id) { return mockImages.has(id); },
});
jest.mock('../src/data/database', () => mockDb);

const dashboardRoutes = require('../src/routes/dashboard.routes');
const campaignImageRoutes = require('../src/routes/campaign-images.routes');

const TOKEN = 'test-token';
const EDIT = 'edit-pw';
process.env.DASHBOARD_API_TOKEN = TOKEN;
const app = express();
app.use(express.json());
app.use('/public', campaignImageRoutes);
app.use('/api/dashboard', dashboardRoutes);

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 3)]);
const upload = (bytes, type = 'image/jpeg', password = EDIT) => request(app)
  .post('/api/dashboard/campaign-images')
  .set('Authorization', `Bearer ${TOKEN}`)
  .set('Content-Type', type)
  .set('X-Edit-Password', password)
  .set('X-Edited-By', encodeURIComponent('Zoë'))
  .send(bytes);

beforeEach(() => {
  process.env.SETTINGS_EDIT_PASSWORD = EDIT;
  mockImages.clear();
});

test('a JPEG poster is stored and served on a public address, without a token', async () => {
  const res = await upload(JPEG);
  expect(res.status).toBe(200);
  expect(res.body.image).toMatch(/^\/public\/campaign\/[0-9a-f-]{36}\.jpg$/);
  expect([...mockImages.values()][0].uploadedBy).toBe('Zoë');

  const served = await request(app).get(res.body.image);
  expect(served.status).toBe(200);
  expect(served.headers['content-type']).toBe('image/jpeg');
  expect(Buffer.compare(served.body, JPEG)).toBe(0);
  // The dashboard shows it from another site; helmet's default would block that.
  expect(served.headers['cross-origin-resource-policy']).toBe('cross-origin');
});

test('a PNG works too', async () => {
  const res = await upload(PNG, 'image/png');
  expect(res.body.image).toMatch(/\.png$/);
  expect((await request(app).get(res.body.image)).headers['content-type']).toBe('image/png');
});

test('a file that is not really a JPEG or PNG is refused', async () => {
  const res = await upload(Buffer.from('GIF89a........'));
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/JPEG or PNG/);
  expect(mockImages.size).toBe(0);
});

test('without the edit password nothing is stored', async () => {
  expect((await upload(JPEG, 'image/jpeg', 'wrong')).status).toBe(403);
  expect(mockImages.size).toBe(0);
});

test('a poster over 2 MB is refused with a message the team can act on', async () => {
  const res = await upload(Buffer.concat([JPEG, Buffer.alloc(2 * 1024 * 1024)]));
  expect(res.status).toBe(413);
  expect(res.body.error).toMatch(/2 MB/);
});

// Found in the dashboard: the browser blocked the PT poster (a file in public/)
// with ERR_BLOCKED_BY_RESPONSE.NotSameOrigin.
test('a poster file in public/ can be shown by the dashboard too', async () => {
  const res = await request(app).get('/public/pt-promo-2026-10.jpg');
  expect(res.status).toBe(200);
  expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
});

test('an unknown or malformed poster address is a 404', async () => {
  expect((await request(app).get('/public/campaign/3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b.jpg')).status).toBe(404);
  expect((await request(app).get('/public/campaign/..%2F..%2Fserver.js')).status).toBe(404);
});
