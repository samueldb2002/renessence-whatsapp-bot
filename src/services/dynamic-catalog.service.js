/**
 * Renessence Service Catalog
 *
 * Services are shown as parent groups in the WhatsApp list (≤10 rows per category).
 * Groups with multiple variants (duration, persons) have subOptions that the agent
 * presents as follow-up buttons after the customer picks the parent.
 *
 * Flow for grouped treatments:
 *   1. Customer picks parent from list (e.g. "Finnish Sauna")
 *   2. Agent shows subOptions as buttons (e.g. 1p / 2p / 3p)
 *   3. Customer picks variant → proceeds to date/time
 *
 * Flow for single treatments (no subOptions):
 *   1. Customer picks from list → proceeds directly to date/time
 *
 * To add a service:
 *   1. Add its price to PRICE_MAP in payment.service.js
 *   2. Add its room(s) to RESOURCE_MAP in mindbody.service.js
 *   3. Add its slot times to SERVICE_SLOT_TIMES in slot-times.js
 *   4. Add (or update) an entry in DISPLAY_GROUPS below
 */

const { PRICE_MAP } = require('./payment.service');
const settings = require('./settings.service');
const { SERVICE_NAMES } = require('../config/prices');
const { TREATMENTS, MENU_ROWS, DAY_NAMES } = require('../config/treatments');

// ── Price helpers ─────────────────────────────────────────────────────────────
// Every € shown in this file is derived from PRICE_MAP — the same map Stripe
// bills from — so a price change lands in one place. Hardcoding them here once
// let the menu quote Prenatal at €110 while checkout charged €130; tests in
// tests/catalog-prices.test.js now pin the two together. The team edits the
// prices in the dashboard: the groups are rebuilt whenever PRICE_MAP changes.

const livePrice = (id) => PRICE_MAP[id];

function centsOf(priceOf, sessionTypeId) {
  const cents = priceOf(sessionTypeId);
  if (cents == null) throw new Error(`dynamic-catalog: no PRICE_MAP entry for session type ${sessionTypeId}`);
  return cents;
}

/** "€130" for one session type (at today's prices, or the given ones). */
function eurWith(priceOf, sessionTypeId) {
  return `€${centsOf(priceOf, sessionTypeId) / 100}`;
}
const eur = (sessionTypeId) => eurWith(livePrice, sessionTypeId);

/** "€130–170" across session types, collapsing to "€130" when they all match. */
function eurRangeWith(priceOf, ...sessionTypeIds) {
  const prices = sessionTypeIds.map(id => centsOf(priceOf, id) / 100);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  return lo === hi ? `€${lo}` : `€${lo}–${hi}`;
}
const eurRange = (...sessionTypeIds) => eurRangeWith(livePrice, ...sessionTypeIds);

// ── Display groups ─────────────────────────────────────────────────────────────
// id             – WhatsApp list row id (svc_* prefix)
// display        – Row title (max 24 chars)
// description    – Row description (max 72 chars)
// sessionTypeIds – All Mindbody IDs in this group (for fallback / info)
// subOptions     – If set: shown as buttons after the parent is selected.
//                  Each sub-option resolves to specific sessionTypeIds.
//                  Max 3 (WhatsApp button limit).
//   subOptions[].id    – button id (svc_* prefix, decoded by decodeInput)
//   subOptions[].label – button title (max 20 chars)
//   subOptions[].sessionTypeIds – IDs used for availability/booking
// isClass        – If true: use check_class_schedule instead of check_availability

/**
 * The display groups at today's prices and with the team's treatment settings
 * (built again whenever either changes), or at draft prices for the
 * dashboard's preview.
 */
function buildGroups(priceOf = livePrice, treatments = settings.get('treatments')) {
  const eur = (id) => eurWith(priceOf, id);
  const eurRange = (...ids) => eurRangeWith(priceOf, ...ids);
  const letItGoDays = treatments.items.letitgo?.days || [];
  const groups = [

    // ── Tech Treatments (6 rows) ──────────────────────────────────────────────
    {
      id: 'svc_58',
      category: 'Tech Treatments',
      display: 'Float Journey',
      description: `${eur(58)} · 60 min`,
      sessionTypeIds: [58],
    },
    {
      id: 'svc_ir',
      category: 'Tech Treatments',
      display: 'Infrared Sauna',
      description: `${eurRange(98, 65, 97)} · 25 min`,
      sessionTypeIds: [65, 98, 97],
      subOptions: [
        { id: 'svc_98',     label: `Small (1p) – ${eur(98)}`, desc: 'Small IR sauna, 1 person',         sessionTypeIds: [98] },
        { id: 'svc_ir_lg1', label: `Large (1p) – ${eur(65)}`, desc: 'Large IR sauna, 1 person',         sessionTypeIds: [65] },
        { id: 'svc_ir_2p',  label: `Large (2p) – ${eur(97)}`, desc: 'Large IR sauna, 2 people',         sessionTypeIds: [97] },
      ],
    },
    {
      id: 'svc_finn',
      category: 'Tech Treatments',
      display: 'Finnish Sauna',
      description: `${eurRange(87, 69, 91)} · 60 min`,
      sessionTypeIds: [87, 69, 91],
      subOptions: [
        { id: 'svc_87', label: `1 persoon – ${eur(87)}`, desc: 'Finnish Sauna, 1 person',          sessionTypeIds: [87] },
        { id: 'svc_69', label: `2 personen – ${eur(69)}`, desc: 'Finnish Sauna, 2 people',          sessionTypeIds: [69] },
        { id: 'svc_91', label: `3 personen – ${eur(91)}`, desc: 'Finnish Sauna, 3 people',          sessionTypeIds: [91] },
      ],
    },
    {
      id: 'svc_64',
      category: 'Tech Treatments',
      display: 'Red Light Therapy',
      description: `${eur(64)} · 15 min`,
      sessionTypeIds: [64],
    },
    {
      id: 'svc_oxy',
      category: 'Tech Treatments',
      display: 'Oxygen Hydroxy',
      description: `${eurRange(93, 71, 92, 94)} · hyperbaric oxygen`,
      sessionTypeIds: [93, 71, 92, 94],
      subOptions: [
        { id: 'svc_oxy_seated',  label: 'Seated',          desc: 'Zittend · 30 of 60 min',          sessionTypeIds: [92, 94] },
        { id: 'svc_oxy_liggend', label: 'Liggend',         desc: 'Liggend · 30 of 60 min',          sessionTypeIds: [71, 93] },
      ],
    },
    {
      id: 'svc_80',
      category: 'Tech Treatments',
      display: 'Hydrowave Massage',
      description: `${eur(80)} · 25 min`,
      sessionTypeIds: [80],
    },

    // Hidden: Oxygen position → duration choice.
    // Uses the active Mindbody session types (92/94 seated, 71/93 lying).
    {
      id: 'svc_oxy_seated',
      category: '_hidden',
      display: 'Oxygen Hydroxy Seated',
      description: `${eurRange(92, 94)} · zittend`,
      sessionTypeIds: [92, 94],
      subOptions: [
        { id: 'svc_92', label: `30 min – ${eur(92)}`, desc: 'Seated hyperbaric, 30 min', sessionTypeIds: [92] },
        { id: 'svc_94', label: `60 min – ${eur(94)}`, desc: 'Seated hyperbaric, 60 min', sessionTypeIds: [94] },
      ],
    },
    {
      id: 'svc_oxy_liggend',
      category: '_hidden',
      display: 'Oxygen Hydroxy Liggend',
      description: `${eurRange(71, 93)} · liggend`,
      sessionTypeIds: [71, 93],
      subOptions: [
        { id: 'svc_71', label: `30 min – ${eur(71)}`, desc: 'Lying hyperbaric, 30 min', sessionTypeIds: [71] },
        { id: 'svc_93', label: `60 min – ${eur(93)}`, desc: 'Lying hyperbaric, 60 min', sessionTypeIds: [93] },
      ],
    },
    // Gym combos ("Summer Specials") — PAUSED Sep 2026 (team stopped them for
    // now). Hidden entries kept so old bookings and stale list-taps still
    // resolve to the right name; the booking tools hard-reject these IDs.
    {
      id: 'svc_oxy_bb',
      category: '_hidden',
      display: 'Boost & Breathe',
      description: 'Paused (Summer Special)',
      sessionTypeIds: [102],
    },
    { id: 'svc_100', category: '_hidden', display: 'Lift & Drift',   description: 'Paused (Summer Special)', sessionTypeIds: [100] },
    { id: 'svc_103', category: '_hidden', display: 'Sweat & Reset',  description: 'Paused (Summer Special)', sessionTypeIds: [103] },
    { id: 'svc_105', category: '_hidden', display: 'Sweat & Reset',  description: 'Paused (Summer Special)', sessionTypeIds: [105] },
    { id: 'svc_99',  category: '_hidden', display: 'Heat & Meet',    description: 'Paused (Summer Special)', sessionTypeIds: [99] },
    { id: 'svc_104', category: '_hidden', display: 'Glow & Go',      description: 'Paused (Summer Special)', sessionTypeIds: [104] },
    { id: 'svc_101', category: '_hidden', display: 'Move & Massage', description: 'Paused (Summer Special)', sessionTypeIds: [101] },

    // ── Treatments (3 rows) ───────────────────────────────────────────────────
    // Massages: combined row → 4 type options shown as LIST → duration buttons
    {
      id: 'svc_massages',
      category: 'Treatments',
      display: 'Massages',
      description: 'Tailored · Prenatal · Lymphatic · Nervous System',
      sessionTypeIds: [31, 32, 35, 36, 37, 38, 45, 63],
      subOptions: [
        { id: 'svc_tm',  label: 'Tailored Massage',    sessionTypeIds: [31, 32] },
        { id: 'svc_pm',  label: 'Prenatal Massage',    sessionTypeIds: [35, 36] },
        { id: 'svc_ld',  label: 'Lymphatic Drainage',  sessionTypeIds: [37, 38] },
        { id: 'svc_ns',  label: 'Nervous System Reset', sessionTypeIds: [45, 63] },
        { id: 'svc_109', label: 'Let It Go',           desc: `${eur(109)} · 90 min · psycho-energetic (${letItGoDays.length ? `${letItGoDays.map(d => DAY_NAMES[d].slice(0, 3)).join('/')}, ` : ''}Midgie)`, sessionTypeIds: [109] },
      ],
    },
    // Hidden entries — used for sub-option lookup when a massage type is selected
    {
      id: 'svc_tm',
      category: '_hidden',
      display: 'Tailored Massage',
      description: `${eurRange(31, 32)} · personalised massage`,
      sessionTypeIds: [31, 32],
      subOptions: [
        { id: 'svc_31', label: `60 min – ${eur(31)}`, sessionTypeIds: [31] },
        { id: 'svc_32', label: `80 min – ${eur(32)}`, sessionTypeIds: [32] },
      ],
    },
    {
      id: 'svc_pm',
      category: '_hidden',
      display: 'Prenatal Massage',
      description: `${eurRange(35, 36)} · pre/post-partum`,
      sessionTypeIds: [35, 36],
      subOptions: [
        { id: 'svc_35', label: `60 min – ${eur(35)}`, sessionTypeIds: [35] },
        { id: 'svc_36', label: `80 min – ${eur(36)}`, sessionTypeIds: [36] },
      ],
    },
    {
      id: 'svc_ld',
      category: '_hidden',
      display: 'Lymphatic Drainage',
      description: `${eurRange(37, 38)} · lymphatic drainage`,
      sessionTypeIds: [37, 38],
      subOptions: [
        { id: 'svc_37', label: `60 min – ${eur(37)}`, sessionTypeIds: [37] },
        { id: 'svc_38', label: `80 min – ${eur(38)}`, sessionTypeIds: [38] },
      ],
    },
    {
      id: 'svc_41',
      category: 'Treatments',
      display: 'Renewal Facial',
      description: `${eur(41)} · orchid stem cell facial`,
      sessionTypeIds: [41],
    },
    {
      id: 'svc_acu',
      category: '_hidden', // DISCONTINUED (Sep 2026): acupuncture removed from the offer; kept so old bookings still resolve name/price
      display: 'Acupuncture',
      description: 'No longer offered',
      sessionTypeIds: [43, 44, 52],
    },
    {
      id: 'svc_109',
      category: '_hidden', // reached via the Massages sub-options; kept so name/price resolve
      display: 'Let It Go',
      description: `${eur(109)} · 90 min · psycho-energetic therapy${letItGoDays.length ? ` (${letItGoDays.map(d => `${DAY_NAMES[d]}s`).join(', ')})` : ''}`,
      sessionTypeIds: [109],
    },
    {
      id: 'svc_ns',
      category: '_hidden', // reached via svc_massages sub-options
      display: 'Nervous System Reset',
      description: `${eurRange(45, 63)} · nervous system reset`,
      sessionTypeIds: [45, 63],
      subOptions: [
        { id: 'svc_45', label: `60 min – ${eur(45)}`, sessionTypeIds: [45] },
        { id: 'svc_63', label: `80 min – ${eur(63)}`, sessionTypeIds: [63] },
      ],
    },

    // ── Classes (1 row) ───────────────────────────────────────────────────────
    {
      id: 'svc_83',
      category: 'Classes',
      display: 'Studio Classes',
      description: `${eur(83)} · 60 min · Vinyasa, Pilates & more`,
      sessionTypeIds: [83],
      isClass: true,
    },
  ];
  return withTreatmentSettings(groups, treatments, eurRange);
}

/**
 * The team's treatment settings on top of the groups: a paused treatment's
 * options leave the menu (a group with nothing left is hidden — it still
 * resolves names for old bookings), and the first list's rows take the
 * team's name and note, with the price in front.
 */
function withTreatmentSettings(groups, treatments, eurRange) {
  const paused = new Set(TREATMENTS.filter(t => treatments.items[t.key]?.paused).flatMap(t => t.ids));
  for (const grp of groups) {
    const row = MENU_ROWS.find(r => r.id === grp.id);
    const menu = row && treatments.menu[grp.id];
    if (menu) {
      grp.display = menu.name;
      grp.description = row.noPrice ? menu.note : [eurRange(...grp.sessionTypeIds), menu.note].filter(Boolean).join(' · ');
    }
    if (grp.subOptions) grp.subOptions = grp.subOptions.filter(sub => !sub.sessionTypeIds.every(id => paused.has(id)));
    const nothingLeft = grp.subOptions ? grp.subOptions.length === 0 : grp.sessionTypeIds.every(id => paused.has(id));
    if (nothingLeft) grp.category = '_hidden';
  }
  return groups;
}

// Display order of categories — _hidden entries are indexed but not displayed
const CATEGORY_ORDER = ['Tech Treatments', 'Treatments', 'Classes'];

// ── Lookup structures ─────────────────────────────────────────────────────────
// Other modules keep a reference to CATALOG (and DISPLAY_GROUPS), so a rebuild
// replaces their contents in place instead of creating new objects.
const DISPLAY_GROUPS = [];
const CATALOG = { groups: DISPLAY_GROUPS, grouped: {}, byGroupId: {}, bySessionTypeId: {} };
let version = 0;

function refill(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}

function rebuild() {
  const groups = buildGroups();
  const grouped = {};
  for (const cat of CATEGORY_ORDER) grouped[cat] = [];
  for (const grp of groups) (grouped[grp.category] = grouped[grp.category] || []).push(grp);

  // byGroupId: covers parent IDs + sub-option IDs
  const byGroupId = {};
  const bySessionTypeId = {};
  for (const grp of groups) {
    byGroupId[grp.id] = grp;
    for (const id of grp.sessionTypeIds) {
      if (!bySessionTypeId[id]) bySessionTypeId[id] = grp;
    }
    // Also index sub-options so decodeInput can resolve them
    if (grp.subOptions) {
      for (const sub of grp.subOptions) {
        byGroupId[sub.id] = { ...grp, _subOption: sub };
      }
    }
  }

  DISPLAY_GROUPS.splice(0, DISPLAY_GROUPS.length, ...groups);
  refill(CATALOG.grouped, grouped);
  refill(CATALOG.byGroupId, byGroupId);
  refill(CATALOG.bySessionTypeId, bySessionTypeId);
  version++;
}

// After every settings change (a save, the minute reload): rebuild when the
// prices or the treatment settings differ. payment.service applies the team's prices to PRICE_MAP first
// (it registered earlier, when this module required it).
let builtFor = null;
settings.onChange(() => {
  const key = JSON.stringify([PRICE_MAP, settings.get('treatments')]);
  if (key === builtFor) return;
  rebuild();
  builtFor = key;
});

// ── Public API ────────────────────────────────────────────────────────────────

function getCatalog() { return CATALOG; }
/** Bumped on every rebuild, so cached prompt text can tell it is stale. */
const getVersion = () => version;
async function getActiveCatalog() { return CATALOG; }

/**
 * Text block for the AI system prompt.
 */
function buildSystemPromptText(catalog) {
  const cat = catalog || CATALOG;
  const lines = [];
  for (const [category, groups] of Object.entries(cat.grouped)) {
    lines.push(`\n**${category}:**`);
    for (const grp of groups) {
      if (grp.subOptions) {
        const opts = grp.subOptions.map(s => `${s.label} [id:${s.id}, ids:${s.sessionTypeIds.join(',')}]`).join(' | ');
        lines.push(`- "${grp.display}" [id:${grp.id}] → subOptions: ${opts}`);
      } else {
        const ids = grp.sessionTypeIds.join(',');
        lines.push(`- "${grp.display}" [id:${grp.id}, sessionTypeIds:${ids}] | ${grp.description}${grp.isClass ? ' [CLASS]' : ''}`);
      }
    }
  }
  return lines.join('\n').trim();
}

/**
 * WhatsApp list sections for ONE category (≤10 rows per section).
 */
function buildCategoryWhatsAppSections(catalog, category) {
  const cat = catalog || CATALOG;
  const groups = cat.grouped[category];
  if (!groups || groups.length === 0) return [];
  const sections = [];
  for (let i = 0; i < groups.length; i += 10) {
    const chunk = groups.slice(i, i + 10);
    const title = sections.length === 0 ? category : `${category} (${sections.length + 1})`;
    sections.push({
      title: title.substring(0, 24),
      rows: chunk.map(grp => ({
        id: grp.id,
        title: grp.display.substring(0, 24),
        description: grp.description.substring(0, 72),
      })),
    });
  }
  return sections;
}

/** The WhatsApp menu as text at draft prices or treatment settings: what the dashboard shows before a change is saved. */
function menuPreview(priceOf = livePrice, treatments = settings.get('treatments')) {
  const lines = [];
  const groups = buildGroups(priceOf, treatments);
  for (const category of CATEGORY_ORDER) {
    lines.push(`${category}:`);
    for (const grp of groups.filter(g => g.category === category)) {
      lines.push(`- ${grp.display}: ${grp.description}`);
      for (const sub of grp.subOptions || []) {
        lines.push(`    · ${sub.label}${sub.desc ? ` (${sub.desc})` : ''}`);
        // A massage type opens its own list of durations and prices.
        const next = groups.find(g => g.id === sub.id && g.subOptions);
        for (const opt of next?.subOptions || []) lines.push(`        · ${opt.label}`);
      }
    }
  }
  return lines.join('\n');
}

function getCategories(catalog) {
  return Object.keys((catalog || CATALOG).grouped);
}

/**
 * Looks up the display name for a Mindbody session type ID.
 */
// The exact treatment for each bookable session type (config/prices.js): the
// group names are shared ("Oxygen Hydroxy" covers seated AND lying).
function getServiceName(sessionTypeId) {
  if (SERVICE_NAMES[sessionTypeId]) return SERVICE_NAMES[sessionTypeId];
  const grp = CATALOG.bySessionTypeId[sessionTypeId];
  if (grp) return grp.display;
  return `Service ${sessionTypeId}`;
}

module.exports = {
  getCatalog,
  getVersion,
  eur,
  eurRange,
  menuPreview,
  getActiveCatalog,
  buildSystemPromptText,
  buildCategoryWhatsAppSections,
  getCategories,
  getServiceName,
  DISPLAY_GROUPS,
  CATALOG,
};
