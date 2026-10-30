// Promotions the team runs from the dashboard ("Bot content" → Promotions).
//
// Until Oct 2026 every campaign was code: the prompt text in offering.js, the
// WhatsApp intro in intro-promo.service.js, the poster in public/, and a
// redeploy to switch it on — while the December gift-card deal sat undated in
// the knowledge base. Now a promotion is data with dates, and the prompt
// section and the intro message are generated from it.

const { fakeDb } = require('./helpers/fake-settings-db');

jest.mock('stripe', () => jest.fn().mockImplementation(() => ({ checkout: { sessions: {} }, webhooks: {} })));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/services/whatsapp.service', () => ({
  sendText: jest.fn().mockResolvedValue({}), sendImage: jest.fn().mockResolvedValue({}),
}));
const mockDb = Object.assign(fakeDb(), {
  getLastMessageAt: jest.fn(), getLastReminderAt: jest.fn(), claimPromoMessage: jest.fn(),
  getGuestLanguage: jest.fn(), logMessage: jest.fn(), campaignImageExists: jest.fn(),
});
jest.mock('../src/data/database', () => mockDb);

const whatsapp = require('../src/services/whatsapp.service');
const settings = require('../src/services/settings.service');
const { buildSystemPrompt } = require('../src/agents/system-prompt');
const { maybeSendIntroPromo, isPromoMessage } = require('../src/services/intro-promo.service');

const by = 'Fabiana';
const PHONE = '31612345678';
const IMAGE_ID = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b';

const promo = (over = {}) => ({
  id: 'winter-glow-2026',
  name: 'Winter Glow',
  from: '2026-12-01',
  until: '2026-12-14',
  botInfo: 'Every Renewal Facial booked in this period comes with a complimentary hand massage.',
  onlyWhenAsked: false,
  afterEnd: null,
  intro: { enabled: false, en: '', nl: '', image: null },
  ...over,
});
const withIntro = (over = {}) => promo({ intro: { enabled: true, en: 'Winter Glow is here ✨', nl: 'Winter Glow is er ✨', image: null }, ...over });
const save = (items) => settings.save('promotions', { items }, { by });

function promptAt(iso) {
  jest.setSystemTime(new Date(iso));
  return buildSystemPrompt('31611111111', 'Alice');
}
const promotionsOf = (p) => p.slice(p.indexOf('## Promotions'), p.indexOf('\n## Session'));
const knowledgeBaseOf = (p) => p.slice(p.indexOf('## Knowledge base'), p.indexOf('## Opening hours, closures and notices'));

beforeEach(async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-11-20T10:00:00'));
  jest.clearAllMocks();
  mockDb.rows.length = 0;
  mockDb.getLastMessageAt.mockResolvedValue(null);
  mockDb.getLastReminderAt.mockResolvedValue(null);
  mockDb.claimPromoMessage.mockResolvedValue(true);
  mockDb.getGuestLanguage.mockResolvedValue(null);
  mockDb.campaignImageExists.mockResolvedValue(true);
  await settings.load();
});
afterEach(() => jest.useRealTimers());

describe('saving a promotion', () => {
  test('needs a name, dates in order and what the bot should know', async () => {
    expect((await save([promo({ name: ' ' })])).error).toMatch(/name/i);
    expect((await save([promo({ until: '2026-11-30' })])).error).toMatch(/end date is before the start date/);
    expect((await save([promo({ botInfo: 'Hi' })])).error).toMatch(/what the bot should know/i);
    expect((await save([promo()])).ok).toBe(true);
  });

  test('the id is fixed lowercase letters, digits and dashes, and unique', async () => {
    expect((await save([promo({ id: 'Winter Glow!' })])).error).toMatch(/id/i);
    expect((await save([promo(), promo({ name: 'Copy' })])).error).toMatch(/twice/);
  });

  test('an intro needs both texts, each within a WhatsApp caption', async () => {
    expect((await save([withIntro({ intro: { enabled: true, en: 'Hello', nl: '', image: null } })])).error).toMatch(/Dutch/);
    expect((await save([withIntro({ intro: { enabled: true, en: 'x'.repeat(1025), nl: 'Hoi', image: null } })])).error).toMatch(/1024/);
    // Switched off, the texts may stay empty.
    expect((await save([promo({ intro: { enabled: false, en: '', nl: '', image: null } })])).ok).toBe(true);
  });

  // A guest must never get two promotions before their answer.
  test('only one promotion with an intro message can run at a time', async () => {
    const overlap = withIntro({ id: 'gift-week', name: 'Gift week', from: '2026-12-10', until: '2026-12-20' });
    expect((await save([withIntro(), overlap])).error).toMatch(/Winter Glow.*Gift week|Gift week.*Winter Glow/);
    expect((await save([withIntro(), { ...overlap, intro: { ...overlap.intro, enabled: false } }])).ok).toBe(true);
    expect((await save([withIntro(), { ...overlap, from: '2026-12-15' }])).ok).toBe(true);
  });

  test('a poster must be one of ours', async () => {
    const intro = (image) => ({ enabled: true, en: 'Hello', nl: 'Hoi', image });
    expect((await save([withIntro({ intro: intro('https://example.com/x.jpg') })])).error).toMatch(/poster/i);
    expect((await save([withIntro({ intro: intro(`/public/campaign/${IMAGE_ID}.jpg`) })])).ok).toBe(true);
  });

  test('what the bot says after the end needs its own end date, after the promotion', async () => {
    expect((await save([promo({ afterEnd: { text: 'It has ended, kindly say so.', until: '' } })])).error).toMatch(/after it ends/i);
    expect((await save([promo({ afterEnd: { text: 'It has ended, kindly say so.', until: '2026-12-10' } })])).error).toMatch(/after it ends/i);
    expect((await save([promo({ afterEnd: { text: 'It has ended, kindly say so.', until: '2027-01-31' } })])).ok).toBe(true);
  });
});

describe('what the bot is told', () => {
  test('a saved promotion is in the prompt only on its dates', async () => {
    await save([promo()]);
    expect(promotionsOf(promptAt('2026-11-30T23:30:00'))).not.toMatch(/Winter Glow/);
    const running = promotionsOf(promptAt('2026-12-01T00:30:00'));
    expect(running).toMatch(/Winter Glow/);
    expect(running).toMatch(/complimentary hand massage/);
    expect(promotionsOf(promptAt('2026-12-14T23:30:00'))).toMatch(/Winter Glow/);
    expect(promotionsOf(promptAt('2026-12-15T00:30:00'))).not.toMatch(/Winter Glow/);
  });

  // An edit then only changes the end of the prompt; the cached start stays.
  test('the section sits after the knowledge base and before Session', async () => {
    await save([promo()]);
    const p = promptAt('2026-12-02T10:00:00');
    expect(p.indexOf('## Promotions')).toBeGreaterThan(p.indexOf('## Knowledge base'));
    expect(p.indexOf('## Promotions')).toBeLessThan(p.indexOf('\n## Session'));
  });

  test('"only when asked" tells the bot never to bring it up itself', async () => {
    await save([promo({ onlyWhenAsked: true })]);
    expect(promotionsOf(promptAt('2026-12-02T10:00:00'))).toMatch(/only when the guest asks/i);
  });

  test('with an intro message the bot is told not to repeat the pitch', async () => {
    await save([withIntro()]);
    expect(promotionsOf(promptAt('2026-12-02T10:00:00'))).toMatch(/Never repeat that pitch/);
  });

  test('after the end the bot gets the after-end text, until its date', async () => {
    await save([promo({ afterEnd: { text: 'Winter Glow has ended; facials booked in it keep their hand massage.', until: '2027-01-31' } })]);
    const after = promotionsOf(promptAt('2026-12-20T10:00:00'));
    expect(after).toMatch(/facials booked in it keep their hand massage/);
    expect(after).not.toMatch(/complimentary hand massage/);
    expect(promotionsOf(promptAt('2027-02-01T10:00:00'))).not.toMatch(/Winter Glow/);
  });

  test('with nothing running the bot is told not to invent a promotion', async () => {
    await save([]);
    expect(promotionsOf(promptAt('2026-12-02T10:00:00'))).toMatch(/no promotions running/i);
  });

  // It was undated knowledge-base text: the bot quoted it in any month.
  test('the December gift-card deal is in the prompt 1–24 December, and no longer in the knowledge base', () => {
    const december = promptAt('2026-12-10T10:00:00');
    expect(promotionsOf(december)).toMatch(/€90.*€75/);
    expect(knowledgeBaseOf(december)).not.toMatch(/december_promotion|EUR 90 voor EUR 75/);
    expect(promotionsOf(promptAt('2026-11-20T10:00:00'))).not.toMatch(/€90.*€75/);
    expect(promotionsOf(promptAt('2026-12-25T10:00:00'))).not.toMatch(/€90.*€75/);
  });
});

describe('the intro message comes from the saved promotion', () => {
  const ON = () => new Date('2026-12-02T10:00:00');

  test('it goes out on its dates and is logged with the promotion id', async () => {
    await save([withIntro()]);
    expect(await maybeSendIntroPromo(PHONE, { text: 'Hi', now: ON() })).toBe(true);
    expect(mockDb.claimPromoMessage).toHaveBeenCalledWith('winter-glow-2026', PHONE);
    expect(whatsapp.sendText).toHaveBeenCalledWith(PHONE, 'Winter Glow is here ✨');
    expect(mockDb.logMessage).toHaveBeenCalledWith(PHONE, 'assistant', 'Winter Glow is here ✨', { campaignId: 'winter-glow-2026' });
    expect(await maybeSendIntroPromo(PHONE, { text: 'Hi', now: new Date('2026-12-15T10:00:00') })).toBe(false);
  });

  test('Dutch guests get the Dutch text', async () => {
    await save([withIntro()]);
    await maybeSendIntroPromo(PHONE, { text: 'Hoi, kan ik morgen boeken?', now: ON() });
    expect(whatsapp.sendText).toHaveBeenCalledWith(PHONE, 'Winter Glow is er ✨');
  });

  test('switched off, nothing is sent', async () => {
    await save([promo()]);
    expect(await maybeSendIntroPromo(PHONE, { text: 'Hi', now: ON() })).toBe(false);
    expect(mockDb.claimPromoMessage).not.toHaveBeenCalled();
  });

  test('a poster uploaded in the dashboard goes out as an image from our public address', async () => {
    await save([withIntro({ intro: { enabled: true, en: 'Winter Glow is here ✨', nl: 'Winter Glow is er ✨', image: `/public/campaign/${IMAGE_ID}.jpg` } })]);
    await maybeSendIntroPromo(PHONE, { text: 'Hi', now: ON() });
    expect(mockDb.campaignImageExists).toHaveBeenCalledWith(IMAGE_ID);
    expect(whatsapp.sendImage).toHaveBeenCalledWith(PHONE, expect.stringMatching(new RegExp(`^https://.+/public/campaign/${IMAGE_ID}\\.jpg$`)), 'Winter Glow is here ✨');
  });

  // WhatsApp accepts a send with a broken image URL and then delivers nothing.
  test('a poster that is gone falls back to the text', async () => {
    mockDb.campaignImageExists.mockResolvedValue(false);
    await save([withIntro({ intro: { enabled: true, en: 'Winter Glow is here ✨', nl: 'Winter Glow is er ✨', image: `/public/campaign/${IMAGE_ID}.jpg` } })]);
    await maybeSendIntroPromo(PHONE, { text: 'Hi', now: ON() });
    expect(whatsapp.sendImage).not.toHaveBeenCalled();
    expect(whatsapp.sendText).toHaveBeenCalledWith(PHONE, 'Winter Glow is here ✨');
  });
});

// isPromoMessage compared exact caption text: once the team edits a caption,
// guests who got the old one would look like an earlier conversation.
describe('an edited promo caption still counts as a promo', () => {
  test('a logged intro is recognised by its promotion id, whatever its text', () => {
    expect(isPromoMessage('Any text the team wrote last week', 'winter-glow-2026')).toBe(true);
    expect(isPromoMessage('Hi, can I book a float?', null)).toBe(false);
  });

  test('intros logged before the id was stored are still recognised by their text', () => {
    const pt = settings.DEFAULTS.promotions.items.find(p => p.id === 'pt-promo-2026-10');
    expect(isPromoMessage(pt.intro.en)).toBe(true);
    expect(isPromoMessage(`📷 PT promotion image\n\n${pt.intro.nl}`)).toBe(true);
  });
});
