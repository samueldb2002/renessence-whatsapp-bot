/**
 * Business facts the team edits in the dashboard ("Bot content"): opening
 * hours, closures and special hours, notices, contact details — plus the
 * bot-wide pause.
 *
 * Until Oct 2026 each of these was a code edit plus a redeploy, and "pushed"
 * and "live" drifted apart for days. Now:
 * - The database is the truth (bot_settings_history, append-only: every save
 *   is a row with who and when; a row can take effect later, which is how a
 *   change is scheduled). Today's knowledge-base values are the fallback, so a
 *   missing or empty database behaves exactly like before.
 * - Every read is synchronous: the prompt builder and the tools are. Rows are
 *   loaded into memory at startup and re-read every minute (a second
 *   container, a scheduled row); a save updates memory at once.
 * - Getters decide what is in force at call time, so a scheduled change
 *   switches on at its exact moment, not at the next reload.
 */
const db = require('../data/database');
const logger = require('../utils/logger');
const config = require('../config');
const kb = require('../data/knowledge-base.json');
const { formatDateISO } = require('../utils/date');

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const EDITABLE_SECTIONS = ['hours', 'closures', 'notices', 'contact'];
const RELOAD_MS = 60 * 1000;

function parseKbHours(text) {
  const m = /^(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/.exec(String(text || '').trim());
  return m ? { open: m[1], close: m[2] } : { closed: true };
}

const DEFAULTS = {
  hours: Object.fromEntries(DAYS.map(d => [d, parseKbHours(kb.opening_hours?.[d])])),
  closures: { items: [] },
  notices: { items: [] },
  // The knowledge base is what the bot has always quoted. SPA_ADDRESS (used
  // only by reminders before) is a fallback; SPA_PHONE is ignored — the
  // .env.example placeholder must never become a number guests are given.
  contact: {
    address: kb.location?.address || config.SPA_ADDRESS || '',
    phone: kb.contact?.phone || '',
    emails: {
      general: kb.contact?.general || 'welcome@renessence.com',
      events: kb.contact?.events_and_space || 'events@renessence.com',
      memberships: kb.contact?.memberships || 'memberships@renessence.com',
      press: kb.contact?.press || 'press@renessence.com',
    },
  },
  bot_pause: { paused: false },
};

// section → rows (current + scheduled), oldest first
let rowsBySection = {};
// The kill switch must work without a database: memory wins until a save lands.
let botPauseOverride = null;
let timer = null;

const clone = (v) => JSON.parse(JSON.stringify(v));
const sortRows = (rows) => rows.sort((a, b) => new Date(a.effective_from) - new Date(b.effective_from) || a.id - b.id);

function currentRow(section, now = new Date()) {
  const rows = rowsBySection[section] || [];
  let found = null;
  for (const r of rows) if (!r.cancelled_at && new Date(r.effective_from) <= now) found = r;
  return found;
}

function get(section, now = new Date()) {
  const row = currentRow(section, now);
  return clone(row ? row.value : DEFAULTS[section]);
}

function remember(row) {
  const rows = (rowsBySection[row.section] || []).filter(r => r.id !== row.id);
  rows.push(row);
  rowsBySection[row.section] = sortRows(rows);
}

/**
 * Rows are validated on save, but the table can also be edited by hand: a row
 * that doesn't pass the same checks is skipped (logged), so the previous valid
 * version — or the default — stays in force instead of a broken prompt.
 */
function storedValueOk(r) {
  const check = r.section === 'bot_pause'
    ? (typeof r.value?.paused === 'boolean' ? {} : { error: 'paused must be true or false' })
    : VALIDATORS[r.section]?.(r.value) || { error: 'unknown section' };
  if (check.error) logger.error(`Settings: ignoring stored ${r.section} row ${r.id} (${check.error})`);
  return !check.error;
}

async function load() {
  const rows = await db.getSettingsRows();
  const next = {};
  for (const r of rows) if (storedValueOk(r)) (next[r.section] = next[r.section] || []).push(r);
  for (const s of Object.keys(next)) sortRows(next[s]);
  rowsBySection = next;
  botPauseOverride = null;
}

async function start() {
  try { await load(); } catch (err) { logger.warn('Settings not loaded, using defaults:', err.message); }
  if (timer) return;
  timer = setInterval(() => {
    load().catch(err => logger.warn('Settings reload failed:', err.message));
  }, RELOAD_MS);
  timer.unref?.();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

// --- validation -------------------------------------------------------------

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T12:00:00`);
  return !Number.isNaN(d.getTime()) && formatDateISO(d) === s;
}

function cleanText(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** Returns { value } (normalised) or { error } — a sentence the team can act on. */
const VALIDATORS = {
  hours(v) {
    if (!v || typeof v !== 'object') return { error: 'Opening hours are missing.' };
    const out = {};
    for (const day of DAYS) {
      const h = v[day];
      if (h && h.closed === true) { out[day] = { closed: true }; continue; }
      if (!h || !TIME.test(h.open) || !TIME.test(h.close)) return { error: `${cap(day)}: enter opening and closing times as HH:MM, or mark the day closed.` };
      if (h.open >= h.close) return { error: `${cap(day)}: the closing time must be after the opening time.` };
      out[day] = { open: h.open, close: h.close };
    }
    return { value: out };
  },

  closures(v) {
    const items = Array.isArray(v?.items) ? v.items : null;
    if (!items) return { error: 'Closures are missing.' };
    if (items.length > 100) return { error: 'At most 100 closures and special-hours days.' };
    const out = [];
    for (const [i, c] of items.entries()) {
      const label = `Line ${i + 1}`;
      const from = c?.from;
      const to = c?.to || from;
      if (!validDate(from) || !validDate(to)) return { error: `${label}: enter the date as YYYY-MM-DD.` };
      if (to < from) return { error: `${label}: the end date is before the start date.` };
      if ((new Date(`${to}T12:00:00`) - new Date(`${from}T12:00:00`)) / 86400000 > 31) return { error: `${label}: a closure can span at most 31 days.` };
      const note = cleanText(c.note, 200);
      if (c.closed === false) {
        if (!TIME.test(c.open) || !TIME.test(c.close)) return { error: `${label}: enter the special opening and closing times as HH:MM.` };
        if (c.open >= c.close) return { error: `${label}: the closing time must be after the opening time.` };
        out.push({ from, to, closed: false, open: c.open, close: c.close, note });
      } else {
        out.push({ from, to, closed: true, note });
      }
    }
    out.sort((a, b) => a.from.localeCompare(b.from));
    return { value: { items: out } };
  },

  notices(v) {
    const items = Array.isArray(v?.items) ? v.items : null;
    if (!items) return { error: 'Notices are missing.' };
    if (items.length > 20) return { error: 'At most 20 notices.' };
    const out = [];
    for (const [i, n] of items.entries()) {
      const label = `Notice ${i + 1}`;
      const text = cleanText(n?.text, 500);
      if (text.length < 3) return { error: `${label}: the text is empty.` };
      if (!validDate(n.until)) return { error: `${label}: give an end date (YYYY-MM-DD) — notices end by themselves.` };
      if (n.from && !validDate(n.from)) return { error: `${label}: the start date must be YYYY-MM-DD.` };
      if (n.from && n.from > n.until) return { error: `${label}: the end date is before the start date.` };
      out.push({ text, ...(n.from ? { from: n.from } : {}), until: n.until });
    }
    return { value: { items: out } };
  },

  contact(v) {
    if (!v || typeof v !== 'object') return { error: 'Contact details are missing.' };
    const address = cleanText(v.address, 200);
    if (address.length < 5) return { error: 'Enter the address.' };
    const phone = cleanText(v.phone, 30);
    if (phone && !/^[+\d][\d\s-]{5,}$/.test(phone)) return { error: 'The phone number can only contain digits, spaces, + and -.' };
    const emails = {};
    for (const key of Object.keys(DEFAULTS.contact.emails)) {
      const e = cleanText(v.emails?.[key], 100);
      if (!EMAIL.test(e)) return { error: `The ${key} email address is not valid.` };
      emails[key] = e;
    }
    return { value: { address, phone, emails } };
  },
};

// --- saving -----------------------------------------------------------------

function cleanBy(by) {
  return typeof by === 'string' ? by.trim().slice(0, 60) : '';
}

/**
 * Save a new version of a section. effectiveFrom (optional) schedules it.
 * Returns { ok: true, row } or { ok: false, error }; a database failure throws.
 */
async function save(section, value, { by, effectiveFrom, note, restoredFrom } = {}) {
  if (!EDITABLE_SECTIONS.includes(section)) return { ok: false, error: `"${section}" can't be edited here.` };
  const who = cleanBy(by);
  if (!who) return { ok: false, error: 'Enter your name, so the history shows who changed what.' };
  const checked = VALIDATORS[section](value);
  if (checked.error) return { ok: false, error: checked.error };

  const now = new Date();
  let when = now;
  if (effectiveFrom) {
    when = new Date(effectiveFrom);
    if (Number.isNaN(when.getTime())) return { ok: false, error: 'The scheduled date and time are not valid.' };
    if (when < new Date(now.getTime() - 60 * 1000)) return { ok: false, error: 'The scheduled time is in the past.' };
    if (when > new Date(now.getTime() + 366 * 86400000)) return { ok: false, error: 'A change can be scheduled at most a year ahead.' };
  }

  const row = await db.insertSettingsRow({ section, value: checked.value, effectiveFrom: when, savedBy: who, note: cleanText(note, 200) || null, restoredFrom: restoredFrom || null });
  remember(row);
  logger.info(`Settings: ${section} saved by ${who}${when > now ? ` (from ${when.toISOString()})` : ''}`);
  return { ok: true, row };
}

async function history(section, limit = 50) {
  return db.getSettingsHistory(section, Math.min(Math.max(Number(limit) || 50, 1), 200));
}

// Amsterdam wall-clock time (the server runs with TZ=Europe/Amsterdam), as the team reads it.
const localStamp = (d) => `${formatDateISO(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** Make an earlier version live again — as a new row, so the history stays complete. */
async function restore(id, by) {
  const old = await db.getSettingsRowById(id);
  if (!old || !EDITABLE_SECTIONS.includes(old.section)) return { ok: false, error: 'That version no longer exists.' };
  return save(old.section, old.value, { by, restoredFrom: old.id, note: `Restored the version saved by ${old.saved_by} on ${localStamp(new Date(old.saved_at))}` });
}

async function cancelScheduled(id, by) {
  const who = cleanBy(by);
  if (!who) return { ok: false, error: 'Enter your name.' };
  const row = await db.cancelSettingsRow(id, who);
  if (!row) return { ok: false, error: 'That change has already started or was cancelled.' };
  remember(row);
  return { ok: true, row };
}

/** Everything the dashboard shows for one section. */
function describe(section, now = new Date()) {
  const row = currentRow(section, now);
  return {
    value: get(section, now),
    default: clone(DEFAULTS[section]),
    updatedAt: row?.saved_at || null,
    updatedBy: row?.saved_by || null,
    scheduled: (rowsBySection[section] || [])
      .filter(r => !r.cancelled_at && new Date(r.effective_from) > now)
      .map(r => ({ id: r.id, effectiveFrom: r.effective_from, savedBy: r.saved_by, savedAt: r.saved_at, value: clone(r.value) })),
  };
}

// --- what the bot reads ---------------------------------------------------

const hours = (now) => get('hours', now);
const contact = (now) => get('contact', now);

/**
 * The closure or special hours for one Amsterdam date ("YYYY-MM-DD"), or null.
 * A closed day wins over special hours when ranges overlap.
 */
function closureFor(dateStr, now = new Date()) {
  const items = get('closures', now).items.filter(c => c.from <= dateStr && dateStr <= c.to);
  return items.find(c => c.closed) || items[0] || null;
}

function upcomingIn(items, now, days = 366) {
  const today = formatDateISO(now);
  const until = formatDateISO(new Date(now.getTime() + days * 86400000));
  return items.filter(c => c.to >= today && c.from <= until);
}

function activeIn(items, now) {
  const today = formatDateISO(now);
  return items.filter(n => (!n.from || n.from <= today) && today <= n.until);
}

const upcomingClosures = (now = new Date(), days = 366) => upcomingIn(get('closures', now).items, now, days);
const activeNotices = (now = new Date()) => activeIn(get('notices', now).items, now);

/** Validate without saving (the dashboard's preview of a draft). */
function validate(section, value) {
  if (!EDITABLE_SECTIONS.includes(section)) return { error: `"${section}" can't be edited here.` };
  return VALIDATORS[section](value);
}

/**
 * What the bot is told: hours and contact as in force, closures planned for
 * the coming year (guests ask about Christmas in November), notices running today. `draft` replaces one section (preview).
 */
function snapshot(now = new Date(), draft = {}) {
  const value = (s) => (draft[s] !== undefined ? draft[s] : get(s, now));
  return {
    hours: value('hours'),
    contact: value('contact'),
    closures: upcomingIn(value('closures').items, now),
    notices: activeIn(value('notices').items, now),
  };
}

function isBotPaused() {
  if (botPauseOverride !== null) return botPauseOverride;
  return get('bot_pause').paused === true;
}

/** The kill switch: memory first (works with the database down), then stored. */
async function setBotPaused(paused, by) {
  botPauseOverride = !!paused;
  try {
    const row = await db.insertSettingsRow({ section: 'bot_pause', value: { paused: !!paused }, effectiveFrom: new Date(), savedBy: cleanBy(by) || 'dashboard', note: null, restoredFrom: null });
    remember(row);
  } catch (err) {
    logger.error(`Bot pause (${paused ? 'stop' : 'start'}) not stored — it holds until the next restart:`, err.message);
  }
}

module.exports = {
  EDITABLE_SECTIONS,
  DAYS,
  DEFAULTS,
  load,
  start,
  stop,
  get,
  describe,
  validate,
  snapshot,
  save,
  history,
  restore,
  cancelScheduled,
  hours,
  contact,
  closureFor,
  upcomingClosures,
  activeNotices,
  isBotPaused,
  setBotPaused,
};
