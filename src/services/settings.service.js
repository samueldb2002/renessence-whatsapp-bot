/**
 * Business facts the team edits in the dashboard ("Bot content"): opening
 * hours, closures and special hours, notices, contact details, promotions —
 * plus the bot-wide pause.
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
const { DEFAULT_PROMOTIONS } = require('../config/default-promotions');
const { DEFAULT_PRICES, BOOKABLE_PRICE_IDS, SERVICE_NAMES } = require('../config/prices');
const { DEFAULT_MEMBERSHIPS } = require('../config/offering');
const { DEFAULT_PACKAGES } = require('../config/default-packages');
const { TREATMENTS, MENU_ROWS, DEFAULT_TREATMENTS } = require('../config/treatments');
const { DEFAULT_FAQ, LOCKED_FAQ_KEYS, faqKey } = require('../config/faq');

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const EDITABLE_SECTIONS = ['hours', 'closures', 'notices', 'contact', 'promotions', 'prices', 'memberships', 'packages', 'treatments', 'faq', 'behaviour'];
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
  promotions: { items: DEFAULT_PROMOTIONS },
  prices: { cents: Object.fromEntries(BOOKABLE_PRICE_IDS.map(id => [String(id), DEFAULT_PRICES[id]])) },
  memberships: DEFAULT_MEMBERSHIPS,
  packages: { items: DEFAULT_PACKAGES },
  treatments: DEFAULT_TREATMENTS,
  faq: DEFAULT_FAQ,
  // Today's env values, so nothing changes until the team saves this section.
  behaviour: {
    teamThresholdEur: (parseInt(process.env.JOURNEY_TEAM_THRESHOLD_CENTS || '15000', 10) || 15000) / 100,
    escalationEmail: process.env.ESCALATION_EMAIL || 'welcome@renessence.com',
  },
  bot_pause: { paused: false },
};

// section → rows (current + scheduled), oldest first
let rowsBySection = {};
// The kill switch must work without a database: a Stop/Start the database
// refused is held in memory until a later one is stored (or a restart).
let botPauseOverride = null;
// Bumped by every save here, so a reload that read the table before it
// doesn't put the old values back.
let writes = 0;
let timer = null;
// Code outside this module that keeps its own copy of a setting (PRICE_MAP,
// the catalog) — told after every save and every reload.
const listeners = [];

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
  writes++;
  const rows = (rowsBySection[row.section] || []).filter(r => r.id !== row.id);
  rows.push(row);
  rowsBySection[row.section] = sortRows(rows);
  notify();
}

function runListener(fn) {
  try { fn(); } catch (err) { logger.error('Settings: applying a change failed:', err.message); }
}
function notify() { for (const fn of listeners) runListener(fn); }

/**
 * Run fn now and after every change (a save, the minute reload — which is
 * also when a scheduled change switches on). fn reads what it needs with
 * get() and must be cheap when nothing it uses changed.
 */
function onChange(fn) {
  listeners.push(fn);
  runListener(fn);
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
  const seen = writes;
  const rows = await db.getSettingsRows();
  // A save landed while reading: memory is already newer; the next reload catches up.
  if (writes !== seen) return;
  const next = {};
  for (const r of rows) if (storedValueOk(r)) (next[r.section] = next[r.section] || []).push(r);
  for (const s of Object.keys(next)) sortRows(next[s]);
  rowsBySection = next;
  notify();
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
const PROMO_ID = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/;
// A poster uploaded on the dashboard (campaign_images) or a file in public/.
const OUR_IMAGE = /^\/public\/(campaign\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9-]+)\.(jpg|png)$/;
const WHATSAPP_CAPTION_MAX = 1024;
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

  prices(v) {
    const cents = v?.cents;
    if (!cents || typeof cents !== 'object') return { error: 'Prices are missing.' };
    const unknown = Object.keys(cents).find(id => !BOOKABLE_PRICE_IDS.includes(Number(id)));
    if (unknown) return { error: `Session type ${unknown} is not a bookable treatment.` };
    const out = {};
    for (const id of BOOKABLE_PRICE_IDS) {
      const c = cents[id];
      const name = SERVICE_NAMES[id] || `Session type ${id}`;
      if (c == null || c === '') return { error: `${name}: enter a price.` };
      if (!Number.isInteger(c) || c % 100 !== 0) return { error: `${name}: prices are whole euros.` };
      if (c < 100 || c > 100000) return { error: `${name}: the price must be between €1 and €1000.` };
      out[id] = c;
    }
    return { value: { cents: out } };
  },

  memberships(v) {
    if (!v || typeof v !== 'object' || !Array.isArray(v.groups)) return { error: 'Passes & Memberships are missing.' };
    const included = cleanText(v.included, 600);
    if (included.length < 10) return { error: 'Describe what every Pass and Membership includes.' };
    if (!v.groups.length || v.groups.length > 8) return { error: 'Keep between 1 and 8 groups.' };
    const groups = [];
    for (const [gi, g] of v.groups.entries()) {
      const name = cleanText(g?.name, 60);
      if (name.length < 2) return { error: `Group ${gi + 1}: give it a name.` };
      const items = Array.isArray(g.items) ? g.items : [];
      if (!items.length || items.length > 10) return { error: `${name}: add at least one product (at most 10).` };
      const out = [];
      for (const [ii, it] of items.entries()) {
        const itemName = cleanText(it?.name, 60);
        if (itemName.length < 2) return { error: `${name}, product ${ii + 1}: give it a name.` };
        if (!Number.isInteger(it.priceEur) || it.priceEur < 1 || it.priceEur > 10000) return { error: `${itemName}: the price must be whole euros between €1 and €10000.` };
        out.push({ name: itemName, priceEur: it.priceEur, perMonth: it.perMonth === true, terms: cleanText(it.terms, 300) });
      }
      groups.push({ name, note: cleanText(g.note, 300), items: out });
    }
    return { value: { included, groups } };
  },

  packages(v) {
    const items = Array.isArray(v?.items) ? v.items : null;
    if (!items) return { error: 'Packages are missing.' };
    if (items.length > 20) return { error: 'At most 20 packages.' };
    const out = [];
    for (const [i, p] of items.entries()) {
      const name = cleanText(p?.name, 80);
      if (name.length < 2) return { error: `Package ${i + 1}: give it a name.` };
      const text = cleanText(p.text, 1000);
      if (text.length < 10) return { error: `${name}: describe what's in it and what it costs.` };
      out.push({ name, text });
    }
    return { value: { items: out } };
  },

  treatments(v) {
    if (!v || typeof v !== 'object' || !v.items || !v.menu) return { error: 'Treatments are missing.' };
    const unknown = Object.keys(v.items).find(k => !TREATMENTS.some(t => t.key === k))
      || Object.keys(v.menu).find(id => !MENU_ROWS.some(r => r.id === id));
    if (unknown) return { error: `"${unknown}" is not a treatment the bot knows.` };
    const items = {};
    for (const t of TREATMENTS) {
      const it = v.items[t.key] || {};
      let days = Array.isArray(it.days) ? [...new Set(it.days)] : [];
      if (days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) return { error: `${t.name}: pick the days from Monday to Sunday.` };
      if (t.noDays && days.length) return { error: `${t.name}: classes follow the class schedule, so their days can't be set here.` };
      if (days.length === 7) days = []; // every day
      items[t.key] = { paused: it.paused === true, days: days.sort() };
    }
    const menu = {};
    for (const r of MENU_ROWS) {
      const name = cleanText(v.menu[r.id]?.name, 100);
      if (name.length < 2 || name.length > 24) return { error: `${r.name}: the menu name must be 2 to 24 characters (WhatsApp's limit).` };
      // The price goes in front ("€1000–1000 · " at most), within WhatsApp's 72.
      const max = r.noPrice ? 72 : 59;
      const note = cleanText(v.menu[r.id]?.note, 200);
      if (note.length > max) return { error: `${name}: the note can be at most ${max} characters — with the price in front WhatsApp shows 72.` };
      menu[r.id] = { name, note };
    }
    return { value: { items, menu } };
  },

  faq(v) {
    const items = Array.isArray(v?.items) ? v.items : null;
    if (!items) return { error: 'The FAQ is missing.' };
    if (items.length > 60) return { error: 'At most 60 topics.' };
    const out = [];
    const keys = new Set();
    for (const [i, it] of items.entries()) {
      const topic = cleanText(it?.topic, 80);
      if (topic.length < 2) return { error: `Topic ${i + 1}: give it a name.` };
      // A new topic gets its key from its name; an existing one keeps its key.
      const key = typeof it.key === 'string' && it.key.trim() ? it.key.trim() : faqKey(topic);
      if (!/^[a-z0-9_]{2,50}$/.test(key)) return { error: `${topic}: use letters or digits in the topic name.` };
      if (LOCKED_FAQ_KEYS.includes(key)) return { error: `${topic}: this answer follows the bot's own rules (cancellations, memberships) and can't be edited here.` };
      if (keys.has(key)) return { error: `${topic}: this topic is in the list twice.` };
      keys.add(key);
      const answer = cleanText(it.answer, 1500);
      if (answer.length < 5) return { error: `${topic}: write the answer.` };
      out.push({ key, topic, answer });
    }
    return { value: { items: out } };
  },

  behaviour(v) {
    if (!v || typeof v !== 'object') return { error: 'Settings are missing.' };
    const t = v.teamThresholdEur;
    if (!Number.isInteger(t) || t < 50 || t > 2000) return { error: 'Orders for the team: enter whole euros between €50 and €2000.' };
    const escalationEmail = cleanText(v.escalationEmail, 100);
    if (!EMAIL.test(escalationEmail)) return { error: 'The team email address is not valid.' };
    return { value: { teamThresholdEur: t, escalationEmail } };
  },

  promotions(v) {
    const items = Array.isArray(v?.items) ? v.items : null;
    if (!items) return { error: 'Promotions are missing.' };
    if (items.length > 30) return { error: 'At most 30 promotions — remove old ones.' };
    const out = [];
    const ids = new Set();
    for (const [i, p] of items.entries()) {
      const name = cleanText(p?.name, 60);
      if (!name) return { error: `Promotion ${i + 1}: give it a name.` };
      const id = typeof p.id === 'string' ? p.id.trim() : '';
      if (!PROMO_ID.test(id)) return { error: `${name}: the id must be 3–60 lowercase letters, digits and dashes.` };
      if (ids.has(id)) return { error: `${name}: the id "${id}" is used twice.` };
      ids.add(id);
      if (!validDate(p.from) || !validDate(p.until)) return { error: `${name}: enter the dates as YYYY-MM-DD.` };
      if (p.until < p.from) return { error: `${name}: the end date is before the start date.` };
      const botInfo = cleanText(p.botInfo, 3000);
      if (botInfo.length < 20) return { error: `${name}: describe what the bot should know (at least a sentence).` };

      let afterEnd = null;
      const afterText = cleanText(p.afterEnd?.text, 1000);
      if (afterText) {
        if (!validDate(p.afterEnd.until) || p.afterEnd.until <= p.until) {
          return { error: `${name}: what the bot says after it ends needs an end date after the promotion's end.` };
        }
        afterEnd = { text: afterText, until: p.afterEnd.until };
      }

      const intro = { enabled: p.intro?.enabled === true, en: cleanText(p.intro?.en, 2000), nl: cleanText(p.intro?.nl, 2000), image: p.intro?.image || null };
      if (intro.image !== null && !OUR_IMAGE.test(intro.image)) return { error: `${name}: upload the poster here; other links can't be used.` };
      if (intro.enabled && !intro.en) return { error: `${name}: write the English intro message.` };
      if (intro.enabled && !intro.nl) return { error: `${name}: write the Dutch intro message.` };
      for (const [lang, label] of [['en', 'English'], ['nl', 'Dutch']]) {
        if (intro[lang].length > WHATSAPP_CAPTION_MAX) return { error: `${name}: the ${label} intro is ${intro[lang].length} characters; WhatsApp allows ${WHATSAPP_CAPTION_MAX} under a poster.` };
      }
      out.push({ id, name, from: p.from, until: p.until, botInfo, onlyWhenAsked: p.onlyWhenAsked === true, afterEnd, intro });
    }
    // A new conversation gets at most one intro before its answer.
    const sending = out.filter(p => p.intro.enabled);
    for (const [i, a] of sending.entries()) {
      for (const b of sending.slice(i + 1)) {
        if (a.from <= b.until && b.from <= a.until) {
          return { error: `${a.name} and ${b.name} both send an intro message on overlapping dates. Only one promotion at a time can — switch one off or move its dates.` };
        }
      }
    }
    out.sort((a, b) => a.from.localeCompare(b.from));
    return { value: { items: out } };
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

// What the dashboard needs to label a section's fields (names of session
// types, which treatments exist, …); fixed in code, not edited.
const META = {
  prices: () => ({
    names: Object.fromEntries(BOOKABLE_PRICE_IDS.map(id => [id, SERVICE_NAMES[id] || `Session type ${id}`])),
    groups: [...TREATMENTS.map(t => ({ name: t.name, ids: t.ids })), { name: 'Add-ons', ids: [30] }],
  }),
  treatments: () => ({ treatments: TREATMENTS, menuRows: MENU_ROWS }),
  behaviour: () => ({ paymentWindowMinutes: Math.max(31, parseInt(process.env.PAYMENT_TIMEOUT_MINUTES || '31', 10) || 31) }),
};

/** Everything the dashboard shows for one section. */
function describe(section, now = new Date()) {
  const row = currentRow(section, now);
  return {
    value: get(section, now),
    default: clone(DEFAULTS[section]),
    ...(META[section] ? { meta: META[section]() } : {}),
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

/** Promotions running today, and ended ones whose after-end text still applies. */
function promotionsIn(items, now) {
  const today = formatDateISO(now);
  return {
    running: items.filter(p => p.from <= today && today <= p.until),
    ended: items.filter(p => p.until < today && p.afterEnd && today <= p.afterEnd.until),
  };
}

/** The promotion whose intro message goes to new conversations today, or null (validation allows one). */
const introPromotion = (now = new Date()) => promotionsIn(get('promotions', now).items, now).running.find(p => p.intro.enabled) || null;

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
    promotions: promotionsIn(value('promotions').items, now),
  };
}

/** Whether the team ever saved this section (in force now), as opposed to running on the code defaults. */
const hasSaved = (section, now = new Date()) => !!currentRow(section, now);

/** The paused treatment a session type belongs to, or null. */
function pausedTreatment(sessionTypeId, now = new Date()) {
  const items = get('treatments', now).items;
  return TREATMENTS.find(t => t.ids.includes(Number(sessionTypeId)) && items[t.key]?.paused) || null;
}

/** Weekdays (0 = Sunday) a session type can be booked on, or null for every day. */
function daysFor(sessionTypeId, now = new Date()) {
  const t = TREATMENTS.find(x => x.ids.includes(Number(sessionTypeId)));
  const days = t ? get('treatments', now).items[t.key]?.days : null;
  return days && days.length ? days : null;
}

/** Where team emails go (escalations, cancellations, gift-card and reschedule requests). */
const teamInbox = () => get('behaviour').escalationEmail;

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
    botPauseOverride = null;
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
  onChange,
  get,
  hasSaved,
  teamInbox,
  pausedTreatment,
  daysFor,
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
  introPromotion,
  isBotPaused,
  setBotPaused,
};
