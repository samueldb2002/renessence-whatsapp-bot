// A photo with a caption whose download fails must still deliver the guest's
// words to the bot, not "Sorry, I can only process text messages".
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/handlers/message.handler', () => ({ handle: jest.fn().mockResolvedValue(undefined), handleNonText: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/voice.service', () => ({
  downloadWhatsAppMedia: jest.fn(),
  transcribeWhatsAppVoice: jest.fn(),
}));
jest.mock('../src/data/database', () => ({
  isWebhookProcessed: jest.fn().mockResolvedValue(false),
  markWebhookProcessed: jest.fn().mockResolvedValue(undefined),
  saveMedia: jest.fn().mockResolvedValue(55),
  logMessage: jest.fn().mockResolvedValue(undefined),
}));

const express = require('express');
const request = require('supertest');
const handler = require('../src/handlers/message.handler');
const voice = require('../src/services/voice.service');
const { PHOTO_ACK } = require('../src/config/non-text');

process.env.NODE_ENV = 'development';
delete process.env.WHATSAPP_APP_SECRET;
const app = express();
app.use(express.json());
app.use('/webhook', require('../src/routes/webhook'));

let n = 0;
const photo = (caption) => ({
  entry: [{ changes: [{ value: {
    contacts: [{ profile: { name: 'Sanne' } }],
    messages: [{ id: `wamid.${++n}`, from: '31600000001', type: 'image', image: { id: 'media1', mime_type: 'image/jpeg', ...(caption ? { caption } : {}) } }],
  } }] }],
});
const settle = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => jest.clearAllMocks());

test('download fails, caption present: the caption reaches the bot as text', async () => {
  voice.downloadWhatsAppMedia.mockRejectedValue(new Error('Graph timeout'));
  await request(app).post('/webhook').send(photo('Can I book a massage with this on Saturday?'));
  await settle();
  expect(handler.handle).toHaveBeenCalledWith(expect.objectContaining({ from: '31600000001', text: 'Can I book a massage with this on Saturday?' }));
  expect(handler.handleNonText).not.toHaveBeenCalled();
});

test('download works, no caption: stored and acknowledged as a photo', async () => {
  voice.downloadWhatsAppMedia.mockResolvedValue(Buffer.from('x'));
  await request(app).post('/webhook').send(photo(''));
  await settle();
  expect(handler.handleNonText).toHaveBeenCalledWith(expect.objectContaining({ type: 'photo', alreadyLogged: true, ack: PHOTO_ACK }));
  expect(handler.handle).not.toHaveBeenCalled();
});
