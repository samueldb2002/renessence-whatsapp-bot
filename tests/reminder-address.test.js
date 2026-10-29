// The reminder address came from the SPA_ADDRESS env var (an empty "📍"
// line when unset). It now comes from the team-edited contact details:
// the knowledge-base address until someone changes it.

const { fakeDb } = require('./helpers/fake-settings-db');

jest.mock('../src/services/whatsapp.service', () => ({ sendText: jest.fn().mockResolvedValue({}) }));
jest.mock('../src/services/mindbody.service', () => ({}));
const mockDb = { ...fakeDb(), hasReminderBeenSent: jest.fn().mockResolvedValue(false), logReminder: jest.fn() };
jest.mock('../src/data/database', () => mockDb);

const whatsapp = require('../src/services/whatsapp.service');
const settings = require('../src/services/settings.service');
const { sendReminderIfNotSent } = require('../src/services/reminder.service');

const appointment = (id) => ({ Id: id, StartDateTime: '2026-12-02T10:00:00', Client: { MobilePhone: '+31612345678' }, SessionType: { Name: 'Float Journey' } });
const lastText = () => whatsapp.sendText.mock.calls.at(-1)[1];

beforeEach(async () => {
  jest.clearAllMocks();
  mockDb.rows.length = 0;
  await settings.load();
});

test('the reminder shows the address from the contact details', async () => {
  await sendReminderIfNotSent(appointment(1), '24h');
  expect(lastText()).toContain('📍 George Gershwinlaan 520, 1082 MT Amsterdam');
});

test('an address changed in the dashboard is used in the next reminder', async () => {
  await settings.save('contact', { ...settings.contact(), address: 'Zuidplein 1, 1077 XV Amsterdam' }, { by: 'Fabiana' });
  await sendReminderIfNotSent(appointment(2), '2h');
  expect(lastText()).toContain('📍 Zuidplein 1, 1077 XV Amsterdam');
});
