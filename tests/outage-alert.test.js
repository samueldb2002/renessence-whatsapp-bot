// The 23 Sept 2026 outage: OpenAI credits ran out and for 26 hours every
// customer got "Something went wrong. Please try again." while nobody was
// told. These tests pin the replacement behaviour.

jest.mock('../src/services/email.service', () => ({
  sendOpsAlertEmail: jest.fn().mockResolvedValue({ sent: true }),
}));

const email = require('../src/services/email.service');
const outage = require('../src/services/outage-alert.service');

const noCredits = Object.assign(new Error('429 You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.'), { status: 429 });
const quotaCode = Object.assign(new Error('429 {"error":{"code":"insufficient_quota"}}'), { status: 429, error: { code: 'insufficient_quota' } });
const rateLimit = Object.assign(new Error('429 Rate limit reached for gpt-4o'), { status: 429 });
const badKey = Object.assign(new Error('401 Incorrect API key provided'), { status: 401 });
const serverErr = Object.assign(new Error('500 The server had an error'), { status: 500 });

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-23T14:18:00Z'));
  jest.clearAllMocks();
  outage._reset();
});
afterEach(() => jest.useRealTimers());

describe('classification', () => {
  test('no credits / insufficient_quota → billing; bad key → auth; rate limit and 5xx → transient', () => {
    expect(outage.classifyOpenAIError(noCredits)).toBe('billing');
    expect(outage.classifyOpenAIError(quotaCode)).toBe('billing');
    expect(outage.classifyOpenAIError(badKey)).toBe('auth');
    expect(outage.classifyOpenAIError(rateLimit)).toBe('rate_limit');
    expect(outage.classifyOpenAIError(serverErr)).toBe('other');
  });
});

describe('a persistent failure is an outage', () => {
  test('first failure: alert email immediately, customer gets the holding message, /health shows down', async () => {
    const r = await outage.recordAgentFailure('31620497909', 'Rebecca Brown', noCredits);

    expect(r).toEqual({ kind: 'billing', notifyCustomer: true, outage: true });
    expect(email.sendOpsAlertEmail).toHaveBeenCalledTimes(1);
    const { subject, html } = email.sendOpsAlertEmail.mock.calls[0][0];
    expect(subject).toMatch(/BOT DOWN/);
    expect(html).toMatch(/no credits left/);
    expect(html).toMatch(/platform\.openai\.com/);
    expect(html).toMatch(/Rebecca Brown/);

    const status = outage.getOutageStatus();
    expect(status.status).toBe('down');
    expect(status.kind).toBe('billing');
    expect(status.customersAffected).toBe(1);
  });

  test('retries from the same customer within an hour are NOT answered again', async () => {
    await outage.recordAgentFailure('31631900565', 'Zoë', noCredits);
    const again = await outage.recordAgentFailure('31631900565', 'Zoë', noCredits);   // "Ihi"
    const third = await outage.recordAgentFailure('31631900565', 'Zoë', noCredits);   // "Hi*"
    expect(again.notifyCustomer).toBe(false);
    expect(third.notifyCustomer).toBe(false);

    jest.advanceTimersByTime(61 * 60 * 1000);
    const later = await outage.recordAgentFailure('31631900565', 'Zoë', noCredits);
    expect(later.notifyCustomer).toBe(true);
  });

  test('the team gets ONE email, then at most one reminder per hour, however many customers hit it', async () => {
    for (let i = 0; i < 8; i++) await outage.recordAgentFailure(`3160000000${i}`, `C${i}`, noCredits);
    expect(email.sendOpsAlertEmail).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(59 * 60 * 1000);
    await outage.recordAgentFailure('31600000099', 'Late', noCredits);
    expect(email.sendOpsAlertEmail).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(2 * 60 * 1000);
    await outage.recordAgentFailure('31600000098', 'Later', noCredits);
    expect(email.sendOpsAlertEmail).toHaveBeenCalledTimes(2);
    expect(email.sendOpsAlertEmail.mock.calls[1][0].subject).toMatch(/STILL DOWN/);
    expect(email.sendOpsAlertEmail.mock.calls[1][0].html).toMatch(/Customers affected:<\/b> 10/);
  });

  test('a failed alert email is retried on the next failure instead of being lost', async () => {
    email.sendOpsAlertEmail.mockRejectedValueOnce(new Error('graph down'));
    await outage.recordAgentFailure('31600000001', 'A', noCredits);
    await outage.recordAgentFailure('31600000002', 'B', noCredits);
    expect(email.sendOpsAlertEmail).toHaveBeenCalledTimes(2);
  });

  test('recovery: the first successful call sends the all-clear with the affected list and resets', async () => {
    await outage.recordAgentFailure('31640978075', 'Hippi', noCredits);
    await outage.recordAgentFailure('31613597859', 'Lift- IQ', noCredits);
    jest.advanceTimersByTime(26 * 60 * 60 * 1000);

    await outage.recordAgentSuccess();

    expect(email.sendOpsAlertEmail).toHaveBeenCalledTimes(2);
    const { subject, html } = email.sendOpsAlertEmail.mock.calls[1][0];
    expect(subject).toMatch(/BOT BACK/);
    expect(subject).toMatch(/down 26\.0h, 2 customers affected/);
    expect(html).toMatch(/Hippi/);
    expect(html).toMatch(/Lift- IQ/);
    expect(outage.getOutageStatus()).toBeNull();
  });

  test('a success with no open outage is a no-op (no email)', async () => {
    await outage.recordAgentSuccess();
    expect(email.sendOpsAlertEmail).not.toHaveBeenCalled();
  });
});

describe('transient failures are not outages', () => {
  test('a rate limit or 5xx keeps the plain retry hint and sends no email', async () => {
    const r1 = await outage.recordAgentFailure('31600000001', 'A', rateLimit);
    const r2 = await outage.recordAgentFailure('31600000001', 'A', serverErr);
    expect(r1).toEqual({ kind: 'rate_limit', notifyCustomer: true, outage: false });
    expect(r2).toEqual({ kind: 'other', notifyCustomer: true, outage: false });
    expect(email.sendOpsAlertEmail).not.toHaveBeenCalled();
    expect(outage.getOutageStatus()).toBeNull();
  });
});

describe('customer holding message', () => {
  test('is honest, names the team follow-up and the email address, in both languages', () => {
    expect(outage.holdingMessage('en')).toMatch(/temporarily unavailable/);
    expect(outage.holdingMessage('en')).toMatch(/welcome@renessence\.com/);
    expect(outage.holdingMessage('nl')).toMatch(/tijdelijk niet beschikbaar/);
    expect(outage.holdingMessage('nl')).toMatch(/welcome@renessence\.com/);
    expect(outage.holdingMessage('en')).not.toMatch(/try again/i);
  });
});
