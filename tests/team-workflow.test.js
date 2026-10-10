// Team feedback (Paula, Oct 2026): escalation emails arrived for chats the
// dashboard didn't show as escalated, and a member's bookings landed on a
// duplicate Mindbody profile so her pass didn't apply.

jest.mock('stripe', () => jest.fn().mockImplementation(() => ({
  checkout: { sessions: { create: jest.fn(), expire: jest.fn() } },
  webhooks: { constructEvent: jest.fn() },
})));
jest.mock('../src/services/whatsapp.service', () => ({
  sendText: jest.fn().mockResolvedValue({}), sendButtons: jest.fn(), sendList: jest.fn(), sendCTAButton: jest.fn(),
}));
jest.mock('../src/services/email.service', () => ({
  sendEscalationEmail: jest.fn().mockResolvedValue({ sent: true }),
  sendRescheduleRequestEmail: jest.fn().mockResolvedValue({ sent: true }),
  sendGiftCardRequestEmail: jest.fn().mockResolvedValue({ sent: true }),
}));
jest.mock('../src/data/database', () => ({
  hasRecentTeamNotification: jest.fn().mockResolvedValue(false),
  logEscalation: jest.fn().mockResolvedValue(undefined),
  markConversationEscalated: jest.fn().mockResolvedValue(undefined),
  logMessage: jest.fn(), logError: jest.fn().mockResolvedValue(true),
  query: jest.fn().mockResolvedValue({ rows: [] }),
}));

const db = require('../src/data/database');
const { toolForwardReschedule, toolForwardGiftCard } = require('../src/agents/tool-implementations');
const { rankClients } = require('../src/services/mindbody.service');

beforeEach(() => jest.clearAllMocks());

describe('every request emailed to the team also flags the guest as "needs reply"', () => {
  test('a reschedule request', async () => {
    await toolForwardReschedule('31600000001', 'Anna', { new_date: 'Friday 16 Oct, afternoon', treatment: 'Float', customer_email: 'anna@example.com' });
    expect(db.markConversationEscalated).toHaveBeenCalledWith('31600000001', expect.stringMatching(/^Reschedule request: Float/));
  });

  test('a gift-card booking request', async () => {
    await toolForwardGiftCard('31600000002', 'Bram', { gift_card_number: 'GC123', treatment: 'Massage', preferred_day: 'Saturday' });
    expect(db.markConversationEscalated).toHaveBeenCalledWith('31600000002', 'Gift card booking request');
  });

  test('an old-system gift card', async () => {
    await toolForwardGiftCard('31600000003', 'Cleo', { gift_card_number: 'OLD9', treatment: 'Facial', preferred_day: 'Monday', customer_email: 'c@example.com', old_system: true });
    expect(db.markConversationEscalated).toHaveBeenCalledWith('31600000003', 'Old gift card — transfer needed');
  });
});

describe('choosing between Mindbody profiles that share a phone number', () => {
  const dup = { Id: '200', FirstName: 'M', LastName: 'Peri', CreationDate: '2026-09-30T10:00:00', Active: true };
  const member = { Id: '150', FirstName: 'Michelle', LastName: 'Periquet', CreationDate: '2025-03-01T10:00:00', Active: true };

  test('the profile holding an active pass wins, even when Mindbody lists the duplicate first', () => {
    expect(rankClients([dup, member], { 150: true })[0].Id).toBe('150');
    expect(rankClients([dup, { ...member, CreationDate: '2026-10-01T10:00:00' }], { 150: true })[0].Id).toBe('150');
  });

  test('without passes the original (oldest) profile wins', () => {
    expect(rankClients([dup, member], {})[0].Id).toBe('150');
  });

  test('an inactive profile loses to an active one', () => {
    expect(rankClients([{ ...member, Active: false }, dup], {})[0].Id).toBe('200');
  });

  test('without creation dates the lower Mindbody id counts as older', () => {
    const a = { Id: '300', FirstName: 'A' }, b = { Id: '120', FirstName: 'B' };
    expect(rankClients([a, b], {})[0].Id).toBe('120');
  });
});
