// Team-editable settings (hours, closures, notices, contact, bot pause).
//
// Until Oct 2026 every one of these was a code edit plus a redeploy, and a
// pushed fix could sit undeployed for days (the dashboard typing fix: 11).
// The team now edits them in the dashboard; the database row is the truth,
// today's knowledge-base values are the fallback, and every read stays
// synchronous because the prompt builder and the tools are synchronous.

const { fakeDb } = require('./helpers/fake-settings-db');

let db;
let settings;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-11-10T10:00:00'));
  jest.resetModules();
  db = fakeDb();
  jest.doMock('../src/data/database', () => db);
  settings = require('../src/services/settings.service');
});

afterEach(() => {
  settings.stop();
  jest.useRealTimers();
});

const by = 'Fabiana';

describe('defaults (no database, nothing saved yet)', () => {
  test('opening hours come from the knowledge base', () => {
    const kb = require('../src/data/knowledge-base.json');
    expect(settings.hours().monday).toEqual({ open: '07:00', close: '21:00' });
    expect(settings.hours().sunday).toEqual({ open: kb.opening_hours.sunday.split(' - ')[0], close: kb.opening_hours.sunday.split(' - ')[1] });
  });

  test('contact defaults to the knowledge-base address and emails', () => {
    expect(settings.contact().address).toBe('George Gershwinlaan 520, 1082 MT Amsterdam');
    expect(settings.contact().emails.general).toBe('welcome@renessence.com');
    expect(settings.contact().emails.events).toBe('events@renessence.com');
  });

  test('no closures, no notices, bot running', () => {
    expect(settings.closureFor('2026-12-25')).toBeNull();
    expect(settings.activeNotices()).toEqual([]);
    expect(settings.isBotPaused()).toBe(false);
  });
});

describe('saving', () => {
  test('a valid change is live immediately and recorded with who made it', async () => {
    const hours = { ...settings.hours(), friday: { open: '07:00', close: '21:00' } };
    const res = await settings.save('hours', hours, { by });
    expect(res.ok).toBe(true);
    expect(settings.hours().friday).toEqual({ open: '07:00', close: '21:00' });
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ section: 'hours', saved_by: by });
  });

  test('a closing time before the opening time is refused with a readable reason, nothing stored', async () => {
    const hours = { ...settings.hours(), friday: { open: '20:00', close: '07:00' } };
    const res = await settings.save('hours', hours, { by });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/friday/i);
    expect(db.rows).toHaveLength(0);
    expect(settings.hours().friday).toEqual({ open: '07:00', close: '20:00' });
  });

  test('a day can be closed every week', async () => {
    const res = await settings.save('hours', { ...settings.hours(), sunday: { closed: true } }, { by });
    expect(res.ok).toBe(true);
    expect(settings.hours().sunday).toEqual({ closed: true });
  });

  test('saving needs a name', async () => {
    const res = await settings.save('notices', { items: [] }, { by: '  ' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/name/i);
  });

  test('unknown sections are refused', async () => {
    const res = await settings.save('prices', {}, { by });
    expect(res.ok).toBe(false);
  });

  test('a notice needs an end date', async () => {
    const res = await settings.save('notices', { items: [{ text: 'Float cabin in maintenance' }] }, { by });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/end date/i);
  });

  test('an invalid email address is refused', async () => {
    const res = await settings.save('contact', { ...settings.contact(), emails: { ...settings.contact().emails, events: 'events at renessence' } }, { by });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/email/i);
  });
});

describe('scheduled changes', () => {
  test('a change scheduled for later is not live yet, and switches on by itself at that time', async () => {
    const hours = { ...settings.hours(), saturday: { open: '08:00', close: '20:00' } };
    const res = await settings.save('hours', hours, { by, effectiveFrom: '2026-12-01T00:00:00' });
    expect(res.ok).toBe(true);
    expect(settings.hours().saturday).toEqual({ open: '09:00', close: '20:00' });
    jest.setSystemTime(new Date('2026-12-01T00:00:01'));
    expect(settings.hours().saturday).toEqual({ open: '08:00', close: '20:00' });
  });

  test('a scheduled change can be cancelled before it starts', async () => {
    const res = await settings.save('hours', { ...settings.hours(), saturday: { closed: true } }, { by, effectiveFrom: '2026-12-01T00:00:00' });
    const cancelled = await settings.cancelScheduled(res.row.id, by);
    expect(cancelled.ok).toBe(true);
    jest.setSystemTime(new Date('2026-12-02T10:00:00'));
    expect(settings.hours().saturday).toEqual({ open: '09:00', close: '20:00' });
  });

  test('a scheduled time in the past is refused', async () => {
    const res = await settings.save('hours', settings.hours(), { by, effectiveFrom: '2026-11-01T00:00:00' });
    expect(res.ok).toBe(false);
  });

  test('changes saved elsewhere (another container, a scheduled row) are picked up by load()', async () => {
    await db.insertSettingsRow({ section: 'notices', value: { items: [{ text: 'Hammam closed this week', until: '2026-11-15' }] }, effectiveFrom: new Date('2026-11-10T09:00:00'), savedBy: by });
    expect(settings.activeNotices()).toEqual([]);
    await settings.load();
    expect(settings.activeNotices().map(n => n.text)).toEqual(['Hammam closed this week']);
  });
});

describe('a broken stored value never reaches the bot', () => {
  // Rows are validated on save, but the table can also be edited by hand.
  test('a malformed row is skipped on load and the previous valid one stays in force', async () => {
    await settings.save('hours', { ...settings.hours(), friday: { open: '07:00', close: '22:00' } }, { by });
    await db.insertSettingsRow({ section: 'hours', value: { v: 2 }, effectiveFrom: new Date(), savedBy: 'manual' });
    await settings.load();
    expect(settings.hours().friday).toEqual({ open: '07:00', close: '22:00' });
  });

  test('with only a malformed row, the defaults are used', async () => {
    await db.insertSettingsRow({ section: 'notices', value: 'nonsense', effectiveFrom: new Date(), savedBy: 'manual' });
    await settings.load();
    expect(settings.activeNotices()).toEqual([]);
  });
});

describe('history and restore', () => {
  test('restoring an earlier version makes it live again as a new history entry', async () => {
    const first = await settings.save('notices', { items: [{ text: 'Notice A', until: '2026-12-31' }] }, { by });
    await settings.save('notices', { items: [{ text: 'Notice B', until: '2026-12-31' }] }, { by: 'Paula' });
    const res = await settings.restore(first.row.id, 'Paula');
    expect(res.ok).toBe(true);
    expect(settings.activeNotices().map(n => n.text)).toEqual(['Notice A']);
    const history = await settings.history('notices');
    expect(history[0]).toMatchObject({ saved_by: 'Paula', restored_from: first.row.id });
    expect(history[0].note).toBe('Restored the version saved by Fabiana on 2026-11-10 10:00');
    expect(history).toHaveLength(3);
  });
});

describe('closures and special hours', () => {
  test('a closed day, a closed range, and a day with special hours', async () => {
    const res = await settings.save('closures', { items: [
      { from: '2026-12-25', to: '2026-12-26', closed: true, note: 'Christmas' },
      { from: '2026-12-31', closed: false, open: '09:00', close: '17:00', note: "New Year's Eve" },
    ] }, { by });
    expect(res.ok).toBe(true);
    expect(settings.closureFor('2026-12-25')).toMatchObject({ closed: true, note: 'Christmas' });
    expect(settings.closureFor('2026-12-26')).toMatchObject({ closed: true });
    expect(settings.closureFor('2026-12-27')).toBeNull();
    expect(settings.closureFor('2026-12-31')).toMatchObject({ closed: false, open: '09:00', close: '17:00' });
  });

  test('special hours must open before they close', async () => {
    const res = await settings.save('closures', { items: [{ from: '2026-12-31', closed: false, open: '17:00', close: '09:00' }] }, { by });
    expect(res.ok).toBe(false);
  });

  test('a range that ends before it starts is refused', async () => {
    const res = await settings.save('closures', { items: [{ from: '2026-12-26', to: '2026-12-25', closed: true }] }, { by });
    expect(res.ok).toBe(false);
  });

  test('upcoming closures list skips the ones already over', async () => {
    await settings.save('closures', { items: [
      { from: '2026-11-01', closed: true, note: 'past' },
      { from: '2026-12-25', closed: true, note: 'Christmas' },
    ] }, { by });
    expect(settings.upcomingClosures().map(c => c.note)).toEqual(['Christmas']);
  });
});

describe('notices', () => {
  test('a notice shows from its start date through its end date, then disappears', async () => {
    await settings.save('notices', { items: [
      { text: 'Float cabin in maintenance', until: '2026-11-12' },
      { text: 'Christmas opening hours online', from: '2026-12-01', until: '2026-12-31' },
    ] }, { by });
    expect(settings.activeNotices().map(n => n.text)).toEqual(['Float cabin in maintenance']);
    jest.setSystemTime(new Date('2026-11-12T23:00:00'));
    expect(settings.activeNotices().map(n => n.text)).toEqual(['Float cabin in maintenance']);
    jest.setSystemTime(new Date('2026-11-13T00:00:01'));
    expect(settings.activeNotices()).toEqual([]);
    jest.setSystemTime(new Date('2026-12-01T09:00:00'));
    expect(settings.activeNotices().map(n => n.text)).toEqual(['Christmas opening hours online']);
  });
});

describe('the bot-wide pause survives a redeploy', () => {
  // It used to be `let botPaused` in dashboard.routes.js: every deploy or
  // restart switched a stopped bot silently back on.
  test('a pause is stored and read back after a restart', async () => {
    await settings.setBotPaused(true, by);
    expect(settings.isBotPaused()).toBe(true);
    jest.resetModules();
    jest.doMock('../src/data/database', () => db);
    const restarted = require('../src/services/settings.service');
    expect(restarted.isBotPaused()).toBe(false);
    await restarted.load();
    expect(restarted.isBotPaused()).toBe(true);
    restarted.stop();
  });

  test('the kill switch still works when the database is down', async () => {
    db.failInserts = true;
    await settings.setBotPaused(true, by);
    expect(settings.isBotPaused()).toBe(true);
  });

  // Security review, Oct 2026: the reload every 60 s reset the in-memory
  // pause, so a Stop the database refused was undone within a minute.
  test('a stop that could not be stored still holds after a reload', async () => {
    db.failInserts = true;
    await settings.setBotPaused(true, by);
    db.failInserts = false;
    await settings.load();
    expect(settings.isBotPaused()).toBe(true);
  });

  test('pressing Start again releases a stop that could not be stored', async () => {
    db.failInserts = true;
    await settings.setBotPaused(true, by);
    db.failInserts = false;
    await settings.setBotPaused(false, by);
    await settings.load();
    expect(settings.isBotPaused()).toBe(false);
  });

  test('a reload that read the table just before a stop does not undo it', async () => {
    const before = await db.getSettingsRows();
    let release;
    const gate = new Promise((r) => { release = r; });
    db.getSettingsRows = async () => { await gate; return before; };
    const reloading = settings.load();
    await settings.setBotPaused(true, by);
    release();
    await reloading;
    expect(settings.isBotPaused()).toBe(true);
  });

  test('the pause is not editable through the settings form', async () => {
    const res = await settings.save('bot_pause', { paused: false }, { by });
    expect(res.ok).toBe(false);
  });
});
