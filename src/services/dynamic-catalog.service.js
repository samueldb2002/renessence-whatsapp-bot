/**
 * Renessence Service Catalog
 *
 * Hardcoded list of bookable services, grouped into display groups so the
 * WhatsApp list stays within the 10-row-total limit per list message.
 *
 * To add a service:
 *   1. Add its price to PRICE_MAP in payment.service.js
 *   2. Add its room(s) to RESOURCE_MAP in mindbody.service.js
 *   3. Add its slot times to SERVICE_SLOT_TIMES in slot-times.js
 *   4. Add (or update) a DISPLAY_GROUPS entry below
 *
 * Groups with multiple sessionTypeIds (e.g. "IR Sauna Large 1p" → rooms 65+77)
 * pass all IDs to check_availability; the agent shows the first available slots.
 * Groups marked with `disambiguate` tell the agent to ask a short follow-up
 * question before checking availability.
 */

const { PRICE_MAP } = require('./payment.service');

// ── Display groups ────────────────────────────────────────────────────────────
// id            – WhatsApp list row id  (must start with svc_)
// display       – Row title             (max 24 chars)
// description   – Row description       (max 72 chars)
// sessionTypeIds – Mindbody IDs used for availability + booking
// disambiguate  – optional: 'laying_or_seated' | 'intake_or_followup' | '60_or_80'
const DISPLAY_GROUPS = [

  // ── Tech Treatments (11 rows → split into 2 sections of 10+1) ────────────
  {
    id: 'svc_58',
    category: 'Tech Treatments',
    display: 'Float Journey',
    description: '€80 · 60 min float tank',
    sessionTypeIds: [58],
  },
  {
    id: 'svc_68',
    category: 'Tech Treatments',
    display: 'IR Sauna Small (1p)',
    description: '€30 · 25 min small sauna',
    sessionTypeIds: [68],
  },
  {
    id: 'svc_ir_lg1',
    category: 'Tech Treatments',
    display: 'IR Sauna Large (1p)',
    description: '€35 · 25 min large sauna',
    sessionTypeIds: [65, 77],   // Large IR 1 & 2, same experience different room
  },
  {
    id: 'svc_ir_2p',
    category: 'Tech Treatments',
    display: 'IR Sauna Large (2p)',
    description: '€45 · 25 min for two',
    sessionTypeIds: [67, 76],   // Large IR 1 & 2 for two
  },
  {
    id: 'svc_87',
    category: 'Tech Treatments',
    display: 'Finnish Sauna (1p)',
    description: '€80 · 60 min solo',
    sessionTypeIds: [87],
  },
  {
    id: 'svc_69',
    category: 'Tech Treatments',
    display: 'Finnish Sauna (2p)',
    description: '€80 · 60 min for two',
    sessionTypeIds: [69],
  },
  {
    id: 'svc_66',
    category: 'Tech Treatments',
    display: 'Finnish Sauna (3p)',
    description: '€90 · 60 min for three',
    sessionTypeIds: [66],
  },
  {
    id: 'svc_64',
    category: 'Tech Treatments',
    display: 'Red Light Therapy',
    description: '€45 · 15 min LED session',
    sessionTypeIds: [64],
  },
  {
    id: 'svc_oxy30',
    category: 'Tech Treatments',
    display: 'Oxygen Hydroxy (30m)',
    description: '€50 · hyperbaric oxygen 30 min',
    sessionTypeIds: [71, 74],   // Laying (71) + Seated (74)
    disambiguate: 'laying_or_seated',
  },
  {
    id: 'svc_oxy60',
    category: 'Tech Treatments',
    display: 'Oxygen Hydroxy (60m)',
    description: '€95 · hyperbaric oxygen 60 min',
    sessionTypeIds: [70, 75],   // Laying (70) + Seated (75)
    disambiguate: 'laying_or_seated',
  },
  {
    id: 'svc_80',
    category: 'Tech Treatments',
    display: 'Hydrowave Massage',
    description: '€30 · 25 min dry water massage',
    sessionTypeIds: [80],
  },

  // ── Massages (9 rows) ─────────────────────────────────────────────────────
  {
    id: 'svc_31',
    category: 'Massages',
    display: 'Tailored Massage (60m)',
    description: '€130 · tailored massage',
    sessionTypeIds: [31],
  },
  {
    id: 'svc_32',
    category: 'Massages',
    display: 'Tailored Massage (80m)',
    description: '€170 · extended massage',
    sessionTypeIds: [32],
  },
  {
    id: 'svc_35',
    category: 'Massages',
    display: 'Prenatal Massage (60m)',
    description: '€130 · pre/post-partum',
    sessionTypeIds: [35],
  },
  {
    id: 'svc_36',
    category: 'Massages',
    display: 'Prenatal Massage (80m)',
    description: '€170 · extended prenatal',
    sessionTypeIds: [36],
  },
  {
    id: 'svc_37',
    category: 'Massages',
    display: 'Lymphatic Drain. (60m)',
    description: '€130 · lymphatic drainage',
    sessionTypeIds: [37],
  },
  {
    id: 'svc_38',
    category: 'Massages',
    display: 'Lymphatic Drain. (80m)',
    description: '€170 · extended drainage',
    sessionTypeIds: [38],
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
    disambiguate: 'intake_or_followup',
  },
  {
    id: 'svc_ns',
    category: 'Massages',
    display: 'Nervous System',
    description: '€130–170 · nervous system reset',
    sessionTypeIds: [45, 63],
    disambiguate: '60_or_80',
  },
];

// Display order of categories
const CATEGORY_ORDER = ['Tech Treatments', 'Massages'];

// ── Build grouped structure once at startup ───────────────────────────────────
const _grouped = {};
for (const cat of CATEGORY_ORDER) _grouped[cat] = [];
for (const grp of DISPLAY_GROUPS) {
  if (!_grouped[grp.category]) _grouped[grp.category] = [];
  _grouped[grp.category].push(grp);
}

// Quick ID lookup maps
const _byGroupId = {};
const _bySessionTypeId = {};
for (const grp of DISPLAY_GROUPS) {
  _byGroupId[grp.id] = grp;
  for (const id of grp.sessionTypeIds) _bySessionTypeId[id] = grp;
}

// Static catalog object (synchronous — no async fetch)
const CATALOG = {
  groups: DISPLAY_GROUPS,
  grouped: _grouped,
  byGroupId: _byGroupId,
  bySessionTypeId: _bySessionTypeId,
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the catalog (synchronous, always available).
 */
function getCatalog() {
  return CATALOG;
}

/**
 * Async wrapper kept for compatibility — returns the static catalog immediately.
 */
async function getActiveCatalog() {
  return CATALOG;
}

/**
 * Returns a text block listing all services, for use in the AI system prompt.
 */
function buildSystemPromptText(catalog) {
  const cat = catalog || CATALOG;
  const lines = [];
  for (const [category, groups] of Object.entries(cat.grouped)) {
    lines.push(`\n**${category}:**`);
    for (const grp of groups) {
      const ids = grp.sessionTypeIds.join(', ');
      const disambig = grp.disambiguate ? ` [ask: ${grp.disambiguate.replace(/_/g, ' ')}]` : '';
      lines.push(`- "${grp.display}" | list_id: ${grp.id} | sessionTypeIds: [${ids}]${disambig} | ${grp.description}`);
    }
  }
  return lines.join('\n').trim();
}

/**
 * Builds WhatsApp list sections for ONE category.
 * Splits into chunks of ≤10 rows (WhatsApp hard limit: 10 rows total).
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

/**
 * Returns the available category names (for building category buttons).
 */
function getCategories(catalog) {
  return Object.keys((catalog || CATALOG).grouped);
}

/**
 * Looks up the service name for a given Mindbody session type ID.
 * Returns the display group name if found, or "Service {id}" as fallback.
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
