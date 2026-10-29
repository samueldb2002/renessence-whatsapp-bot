// The team's "New Passes, Memberships & Promotions" document: from Monday
// 19 October 2026 the old memberships (Live HI, Move HI, Say HI …) are
// replaced by Passes and Memberships, and from 19 October to 1 November a
// Pass comes with a complimentary PT session — sent to guests as a standard
// WhatsApp message. Everything switches by date, so the bot can be deployed
// before the launch.

jest.mock('stripe', () => jest.fn().mockImplementation(() => ({ checkout: { sessions: {} }, webhooks: {} })));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/services/whatsapp.service', () => ({
  sendText: jest.fn().mockResolvedValue({}), sendImage: jest.fn().mockResolvedValue({}),
}));
jest.mock('../src/data/database', () => ({
  getLastMessageAt: jest.fn(), getLastReminderAt: jest.fn(), claimPromoMessage: jest.fn(), getGuestLanguage: jest.fn(), logMessage: jest.fn(),
}));

const fs = require('fs');
const db = require('../src/data/database');
const whatsapp = require('../src/services/whatsapp.service');
const { buildSystemPrompt } = require('../src/agents/system-prompt');
const { maybeSendIntroPromo, isPromoMessage, CAMPAIGNS, looksDutch } = require('../src/services/intro-promo.service');

const at = (iso) => new Date(iso); // local (Europe/Amsterdam on the server)
function promptAt(iso) {
  jest.useFakeTimers();
  jest.setSystemTime(at(iso));
  try { return buildSystemPrompt('31611111111', 'Alice'); } finally { jest.useRealTimers(); }
}
const knowledgeBaseOf = (p) => p.slice(p.indexOf('## Knowledge base'), p.lastIndexOf('\n## Session\n'));

// The July package promo ended on 31 July 2026 but stayed in the prompt,
// kept quiet only by the model reading the date. Ended offers leave the prompt.
test('the ended July package promo is not in the prompt', () => {
  const p = promptAt('2026-10-29T10:00:00');
  expect(p).not.toMatch(/July package promo/);
  expect(p).not.toMatch(/free Infrared Sauna session/);
});

describe('the bot\'s offering switches on 19 October', () => {
  test('before the launch nothing changes', () => {
    const p = promptAt('2026-10-18T23:59:00');
    expect(p).not.toMatch(/Passes & Memberships \(since/);
    expect(p).not.toMatch(/PT promotion/);
    expect(p).toMatch(/Live HI €400\/month/);
  });

  test('from 19 October: the new Passes, Memberships and Duo prices', () => {
    const p = promptAt('2026-10-19T00:30:00'); // UTC is still 18 October here
    for (const line of [
      '1 Month Pass — €295 for 1 month. Does NOT renew automatically.',
      '3 Month Pass — €275 per month, 3-month commitment.',
      '6 Month Pass — €250 per month, 6-month commitment.',
      '3 Month Membership — €350 per month, 3-month commitment.',
      '6 Month Membership — €325 per month, 6-month commitment.',
      '12 Month Membership — €300 per month, 12-month commitment.',
      '3 Month Duo — €650 per month, 3-month commitment.',
      '12 Month Duo — €500 per month, 12-month commitment.',
    ]) expect(p).toContain(line);
    expect(p).toMatch(/25% discount on tech treatments, classes and concerts and 10% discount on massages, facials and other traditional treatments/);
    expect(p).toMatch(/Passes\*\* — no freezing and no Membership discounts/);
    expect(p).toMatch(/Membership discounts can't be applied to bookings or payment links in this chat/);
    // Paula, 14 Oct: only the 60-minute Hyperbaric Reset stays.
    expect(p).toMatch(/Hyperbaric Reset \(60 min\)\*\* — a separate oxygen-only plan[^\n]*€550 per month for 1 Hyperbaric Oxygen Hydroxy session of 60 minutes per day/);
    expect(p).toMatch(/The Heat Reset \(1 and 2 people\) and the Hyperbaric Reset \(30 min\) are discontinued/);
    expect(p).toMatch(/Memberships \/ credits \/ strippenkaart → book via https:\/\/renessence\.com/);
  });

  test('from 19 October the old products are gone from the knowledge base and the rules', () => {
    const p = promptAt('2026-10-20T10:00:00');
    const kb = knowledgeBaseOf(p);
    expect(kb).not.toMatch(/Live HI|Move HI|Say HI|Heat Reset|Hyperbaric Reset|EUR \d+\/maand/);
    expect(kb).not.toMatch(/One-Month Pass/);
    expect(p).not.toMatch(/Live HI €400|Move HI €450|Say HI €500/);
    expect(p).not.toMatch(/One-Month Pass facts/);
    // The summer rule used to forbid €300/€350 per month — now real prices.
    expect(p).not.toMatch(/never mention[^.]*€300/);
  });

  test('the reception-only €250 intro pass is never quoted as an offer', () => {
    const p = promptAt('2026-10-20T10:00:00');
    expect(p).not.toMatch(/Intro-Pass/i);
    for (const sentence of p.split(/(?<=[.!?])\s+/)) {
      if (/intro/i.test(sentence)) expect(sentence).not.toMatch(/€250/);
    }
    expect(p).toMatch(/Never mention the reception-only intro offer/);
  });

  test('Today in the Session line is the Amsterdam date, also just after midnight', () => {
    expect(promptAt('2026-10-19T00:30:00')).toMatch(/Today: 2026-10-19 \| Tomorrow: 2026-10-20/);
  });

  test('the PT promotion runs 19 October – 1 November, then the bot knows it ended', () => {
    expect(promptAt('2026-10-19T09:00:00')).toMatch(/## PT promotion/);
    const last = promptAt('2026-11-01T23:30:00');
    expect(last).toMatch(/## PT promotion/);
    expect(last).toMatch(/does NOT apply to Memberships or Duo Memberships/i);
    const after = promptAt('2026-11-02T00:00:00');
    expect(after).not.toMatch(/## PT promotion/);
    expect(after).toMatch(/New purchases no longer come with a PT session/);
    // Late buyers are still waiting for their trainer in early November.
    expect(after).toMatch(/still get their session: if they haven't been connected with a trainer yet, call request_human_handoff/);
    expect(after).toMatch(/Never tell such a guest the offer has ended/);
    expect(after).toMatch(/Passes & Memberships \(since/);
  });
});

describe('the PT promotion as a standard WhatsApp message', () => {
  const PHONE = '31612345678';
  const campaign = CAMPAIGNS[0];
  const IN_WINDOW = at('2026-10-21T10:00:00');

  // Text path by default; the poster test below uses the real file.
  let existsSpy;
  beforeEach(() => {
    jest.clearAllMocks();
    existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    db.getLastMessageAt.mockResolvedValue(null);
    db.getLastReminderAt.mockResolvedValue(null);
    db.claimPromoMessage.mockResolvedValue(true);
    db.getGuestLanguage.mockResolvedValue(null);
  });

  test('a new conversation in the window gets it once, before the bot answers', async () => {
    expect(await maybeSendIntroPromo(PHONE, { text: 'Hi, can I book a massage tomorrow?', now: IN_WINDOW })).toBe(true);
    expect(db.claimPromoMessage).toHaveBeenCalledWith('pt-promo-2026-10', PHONE);
    expect(whatsapp.sendText).toHaveBeenCalledWith(PHONE, campaign.caption.en);
    expect(db.logMessage).toHaveBeenCalledWith(PHONE, 'assistant', campaign.caption.en);
  });

  test('Dutch guests get it in Dutch — from their saved language or their message', async () => {
    await maybeSendIntroPromo(PHONE, { text: 'Hoi, kan ik morgen een massage boeken?', now: IN_WINDOW });
    expect(whatsapp.sendText).toHaveBeenLastCalledWith(PHONE, campaign.caption.nl);
    db.getGuestLanguage.mockResolvedValue('nl');
    await maybeSendIntroPromo(PHONE, { text: 'Hello', now: IN_WINDOW });
    expect(whatsapp.sendText).toHaveBeenLastCalledWith(PHONE, campaign.caption.nl);
  });

  test.each([
    ['the day before the launch', '2026-10-18T23:59:00'],
    ['2 November', '2026-11-02T00:00:00'],
  ])('not sent on %s', async (_label, iso) => {
    expect(await maybeSendIntroPromo(PHONE, { text: 'Hi', now: at(iso) })).toBe(false);
    expect(db.claimPromoMessage).not.toHaveBeenCalled();
    expect(whatsapp.sendText).not.toHaveBeenCalled();
  });

  test('never in the middle of a conversation (a "Confirm" tap must not get a promotion)', async () => {
    db.getLastMessageAt.mockResolvedValue(new Date(IN_WINDOW.getTime() - 2 * 3600 * 1000));
    expect(await maybeSendIntroPromo(PHONE, { text: 'Confirm', now: IN_WINDOW })).toBe(false);
    expect(db.claimPromoMessage).not.toHaveBeenCalled();
  });

  test('a reply to yesterday\'s reminder is mid-conversation too (reminders are not in the chat log)', async () => {
    db.getLastReminderAt.mockResolvedValue(new Date(IN_WINDOW.getTime() - 3 * 3600 * 1000));
    expect(await maybeSendIntroPromo(PHONE, { text: 'Can I move it?', now: IN_WINDOW })).toBe(false);
    expect(db.claimPromoMessage).not.toHaveBeenCalled();
  });

  test('never on a button or list tap — it always answers an earlier bot message', async () => {
    expect(await maybeSendIntroPromo(PHONE, { text: 'Confirm', isTap: true, now: IN_WINDOW })).toBe(false);
    expect(db.claimPromoMessage).not.toHaveBeenCalled();
  });

  test('a guest who already had it (or a failed claim) does not get it again', async () => {
    db.claimPromoMessage.mockResolvedValue(false);
    expect(await maybeSendIntroPromo(PHONE, { text: 'Hi', now: IN_WINDOW })).toBe(false);
    expect(whatsapp.sendText).not.toHaveBeenCalled();
  });

  test('web chat never gets it', async () => {
    expect(await maybeSendIntroPromo('web_abc', { text: 'Hi', now: IN_WINDOW })).toBe(false);
    expect(db.claimPromoMessage).not.toHaveBeenCalled();
  });

  afterEach(() => existsSpy.mockRestore());

  test('the poster in public/ goes out as an image with the text as caption', async () => {
    existsSpy.mockRestore(); // the real public/pt-promo-2026-10.jpg
    await maybeSendIntroPromo(PHONE, { text: 'Hi', now: IN_WINDOW });
    expect(whatsapp.sendImage).toHaveBeenCalledWith(PHONE, expect.stringMatching(/\/public\/pt-promo-2026-10\.jpg$/), campaign.caption.en);
    expect(whatsapp.sendText).not.toHaveBeenCalled();
    expect(db.logMessage).toHaveBeenCalledWith(PHONE, 'assistant', expect.stringMatching(/^📷 PT promotion image\n\n/));
  });

  test('the logged promo is recognisable, so it does not count as an earlier conversation', async () => {
    await maybeSendIntroPromo(PHONE, { text: 'Hi', now: IN_WINDOW });
    expect(isPromoMessage(db.logMessage.mock.calls[0][2])).toBe(true);
    expect(isPromoMessage(`📷 ${campaign.label} image\n\n${campaign.caption.nl}`)).toBe(true);
    expect(isPromoMessage('Hi, can I book a float?')).toBe(false);
  });

  test('a failed send never breaks the conversation', async () => {
    whatsapp.sendText.mockRejectedValueOnce(new Error('WhatsApp down'));
    await expect(maybeSendIntroPromo(PHONE, { text: 'Hi', now: IN_WINDOW })).resolves.toBe(false);
  });

  test('the texts fit a WhatsApp image caption and carry the facts from the launch document', () => {
    for (const lang of ['en', 'nl']) {
      const c = campaign.caption[lang];
      expect(c.length).toBeLessThan(1024);
      expect(c).toMatch(/1 Month Pass\* \(€295\)/);
      expect(c).toMatch(/3 Month Pass\* \(€275 per (month|maand)\)/);
      expect(c).toMatch(/6 Month Pass\* \(€250 per (month|maand)\)/);
      expect(c).toMatch(/1 november/i);
      expect(c).not.toMatch(/Membership/);
    }
  });

  test('language guess', () => {
    expect(looksDutch('Hi, can I book a massage tomorrow?')).toBe(false);
    expect(looksDutch('Hello')).toBe(false);
    expect(looksDutch('Hoi, kan ik morgen boeken?')).toBe(true);
    expect(looksDutch('Goedemorgen')).toBe(true);
    // German and French guests share some words with Dutch
    expect(looksDutch('Hallo, I would like to book a massage for Saturday')).toBe(false);
    expect(looksDutch('Bonjour, je voudrais réserver un massage')).toBe(false);
    expect(looksDutch('Hallo, ich möchte morgen einen Termin')).toBe(false);
    expect(looksDutch('Hallo, ich möchte am Samstag eine Massage buchen. Vielen Dank!')).toBe(false);
    expect(looksDutch('Hi, wat time do you open?')).toBe(false);
    expect(looksDutch('Hoi')).toBe(true);
  });
});

test('the PT poster is in public/ as a WhatsApp-friendly JPEG', () => {
  const file = require('path').join(__dirname, '../public/pt-promo-2026-10.jpg');
  const buf = fs.readFileSync(file);
  expect(buf.slice(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff])); // JPEG
  expect(buf.length).toBeLessThan(5 * 1024 * 1024);                  // WhatsApp image limit
});
