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

const DISPLAY_GROUPS = [

  // ── Tech Treatments (6 rows) ──────────────────────────────────────────────
  {
    id: 'svc_58',
    category: 'Tech Treatments',
    display: 'Float Journey',
    description: '€80 · 60 min float tank',
    sessionTypeIds: [58],
  },
  {
    id: 'svc_ir',
    category: 'Tech Treatments',
    display: 'Infrared Sauna',
    description: '€30–45 · 25 min',
    sessionTypeIds: [65, 67, 68, 76, 77],
    subOptions: [
      { id: 'svc_68',     label: 'Small (1p) – €30',  sessionTypeIds: [68] },
      { id: 'svc_ir_lg1', label: 'Large (1p) – €35',  sessionTypeIds: [65, 77] },
      { id: 'svc_ir_2p',  label: 'Large (2p) – €45',  sessionTypeIds: [67, 76] },
    ],
  },
  {
    id: 'svc_finn',
    category: 'Tech Treatments',
    display: 'Finnish Sauna',
    description: '€80–90 · 60 min',
    sessionTypeIds: [87, 69, 66],
    subOptions: [
      { id: 'svc_87', label: '1 persoon – €80',  sessionTypeIds: [87] },
      { id: 'svc_69', label: '2 personen – €80', sessionTypeIds: [69] },
      { id: 'svc_66', label: '3 personen – €90', sessionTypeIds: [66] },
    ],
  },
  {
    id: 'svc_64',
    category: 'Tech Treatments',
    display: 'Red Light Therapy',
    description: '€45 · 15 min LED session',
    sessionTypeIds: [64],
  },
  {
    id: 'svc_oxy',
    category: 'Tech Treatments',
    display: 'Oxygen Hydroxy',
    description: '€50–95 · hyperbaric oxygen',
    sessionTypeIds: [70, 71, 74, 75],
    subOptions: [
      { id: 'svc_oxy30', label: '30 min – €50', sessionTypeIds: [71, 74] },
      { id: 'svc_oxy60', label: '60 min – €95', sessionTypeIds: [70, 75] },
    ],
  },
  {
    id: 'svc_80',
    category: 'Tech Treatments',
    display: 'Hydrowave Massage',
    description: '€30 · 25 min dry water massage',
    sessionTypeIds: [80],
  },

  // ── Massages (6 rows) ─────────────────────────────────────────────────────
  {
    id: 'svc_tm',
    category: 'Massages',
    display: 'Tailored Massage',
    description: '€130–170 · personalised massage',
    sessionTypeIds: [31, 32],
    subOptions: [
      { id: 'svc_31', label: '60 min – €130', sessionTypeIds: [31] },
      { id: 'svc_32', label: '80 min – €170', sessionTypeIds: [32] },
    ],
  },
  {
    id: 'svc_pm',
    category: 'Massages',
    display: 'Prenatal Massage',
    description: '€130–170 · pre/post-partum',
    sessionTypeIds: [35, 36],
    subOptions: [
      { id: 'svc_35', label: '60 min – €130', sessionTypeIds: [35] },
      { id: 'svc_36', label: '80 min – €170', sessionTypeIds: [36] },
    ],
  },
  {
    id: 'svc_ld',
    category: 'Massages',
    display: 'Lymphatic Drainage',
    description: '€130–170 · lymphatic drainage',
    sessionTypeIds: [37, 38],
    subOptions: [
      { id: 'svc_37', label: '60 min – €130', sessionTypeIds: [37] },
      { id: 'svc_38', label: '80 min – €170', sessionTypeIds: [38] },
    ],
  },
  {
    id: 'svc_41',
    category: 'Massages',
    display: 'Renewal Facial (60m)',
    description: '€165 · orchid stem cell facial',
    sessionTypeIds: [41],
  },
  {
    id: 'svc_acu',
    category: 'Massages',
    display: 'Acupuncture',
    description: '€120–150 · intake or follow-up',
    sessionTypeIds: [43, 44, 52],
    subOptions: [
      { id: 'svc_43',     label: 'Intake – €150',    sessionTypeIds: [43] },
      { id: 'svc_acu_fu', label: 'Follow-up – €120', sessionTypeIds: [44, 52] },
    ],
  },
  {
    id: 'svc_ns',
    category: 'Massages',
    display: 'Nervous System',
    description: '€130–170 · nervous system reset',
    sessionTypeIds: [45, 63],
    subOptions: [
      { id: 'svc_45', label: '60 min – €130', sessionTypeIds: [45] },
      { id: 'svc_63', label: '80 min – €170', sessionTypeIds: [63] },
    ],
  },

  // ── Classes (1 row) ───────────────────────────────────────────────────────
  {
    id: 'svc_83',
    category: 'Classes',
    display: 'Studio Classes',
    description: '€22 · 60 min · Vinyasa, Pilates & more',
    sessionTypeIds: [83],
    isClass: true,
  },
];

// Display order of categories
const CATEGORY_ORDER = ['Tech Treatments', 'Massages', 'Classes'];

// ── Build lookup structures at startup ────────────────────────────────────────
const _grouped = {};
for (const cat of CATEGORY_ORDER) _grouped[cat] = [];
for (const grp of DISPLAY_GROUPS) {
  if (!_grouped[grp.category]) _grouped[grp.category] = [];
  _grouped[grp.category].push(grp);
}

// byGroupId: covers parent IDs + sub-option IDs
const _byGroupId = {};
const _bySessionTypeId = {};

for (const grp of DISPLAY_GROUPS) {
  _byGroupId[grp.id] = grp;
  for (const id of grp.sessionTypeIds) {
    if (!_bySessionTypeId[id]) _bySessionTypeId[id] = grp;
  }
  // Also index sub-options so decodeInput can resolve them
  if (grp.subOptions) {
    for (const sub of grp.subOptions) {
      _byGroupId[sub.id] = { ...grp, _subOption: sub };
    }
  }
}

const CATALOG = {
  groups: DISPLAY_GROUPS,
  grouped: _grouped,
  byGroupId: _byGroupId,
  bySessionTypeId: _bySessionTypeId,
};

// ── Public API ────────────────────────────────────────────────────────────────

function getCatalog() { return CATALOG; }
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

function getCategories(catalog) {
  return Object.keys((catalog || CATALOG).grouped);
}

/**
 * Looks up the display name for a Mindbody session type ID.
 */
function getServiceName(sessionTypeId) {
  const grp = _bySessionTypeId[sessionTypeId];
  if (grp) return grp.display;
  return `Service ${sessionTypeId}`;
}

module.exports = {
  getCatalog,
  getActiveCatalog,
  buildSystemPromptText,
  buildCategoryWhatsAppSections,
  getCategories,
  getServiceName,
  DISPLAY_GROUPS,
  CATALOG,
};
