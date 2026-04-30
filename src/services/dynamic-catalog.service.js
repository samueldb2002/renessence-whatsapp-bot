/**
 * Dynamic Service Catalog
 *
 * Fetches the current bookable session types from Mindbody, merges with local
 * price and category config, and caches results for 1 hour.
 *
 * Services are only shown to customers when:
 *   1. Mindbody returns them as online-bookable
 *   2. They have a price configured in PRICE_MAP
 *
 * To add a new service: configure its price in payment.service.js (PRICE_MAP),
 * its room in mindbody.service.js (RESOURCE_MAP), and its slot times in
 * slot-times.js. The service will then appear automatically after the next
 * catalog refresh (≤1 hour).
 *
 * To remove a service: deactivate/remove it in Mindbody — it will disappear
 * automatically on the next refresh.
 */

const mindbodyService = require('./mindbody.service');
const { PRICE_MAP } = require('./payment.service');
const logger = require('../utils/logger');

// ---- Category assignment -----------------------------------------------
// Maps Mindbody session type ID → display category.
// IDs not listed here default to 'Other' if they have a price.
const ID_TO_CATEGORY = {
  // Tech Treatments
  58: 'Tech Treatments',   // Float Journey
  64: 'Tech Treatments',   // Red Light Therapy
  65: 'Tech Treatments',   // Large Infrared Sauna 1 (1p)
  66: 'Tech Treatments',   // Finnish Sauna (3p)
  67: 'Tech Treatments',   // Large Infrared Sauna 1 (2p)
  68: 'Tech Treatments',   // Small Infrared Sauna (1p)
  69: 'Tech Treatments',   // Finnish Sauna (2p)
  70: 'Tech Treatments',   // Hyperbaric Oxygen Laying (60m)
  71: 'Tech Treatments',   // Hyperbaric Oxygen Laying (30m)
  74: 'Tech Treatments',   // Hyperbaric Oxygen Seated (30m)
  75: 'Tech Treatments',   // Hyperbaric Oxygen Seated (60m)
  76: 'Tech Treatments',   // Large Infrared Sauna 2 (2p)
  77: 'Tech Treatments',   // Large Infrared Sauna 2 (1p)
  80: 'Tech Treatments',   // Hydrowave
  87: 'Tech Treatments',   // Finnish Sauna (1p)
  // Massages & Treatments
  30: 'Massages',          // LED Light Face Therapy (Add-on)
  31: 'Massages',          // Tailored Massage (60min)
  32: 'Massages',          // Tailored Massage (80min)
  35: 'Massages',          // Prenatal Massage (60min)
  36: 'Massages',          // Prenatal Massage (80min)
  37: 'Massages',          // Lymphatic Drainage (60min)
  38: 'Massages',          // Lymphatic Drainage (80min)
  41: 'Massages',          // Orchid Stem Cell Facial (60min)
  43: 'Massages',          // Acupuncture (Intake 75min)
  44: 'Massages',          // Acupuncture (Follow-up 60min)
  45: 'Massages',          // Nervous System Treatment (60min)
  52: 'Massages',          // Acupuncture (Follow-up 75min)
  63: 'Massages',          // Nervous System Treatment (80min)
};

// Display order of categories
const CATEGORY_ORDER = ['Tech Treatments', 'Massages', 'Other'];

// ---- Cache ------------------------------------------------------------------
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let _cache = null;
let _lastFetch = 0;

// ---- Core fetch -------------------------------------------------------------

/**
 * Returns the active catalog, fetching from Mindbody if the cache is stale.
 * Falls back to stale cache on error.
 *
 * @param {boolean} forceRefresh
 * @returns {Promise<{ services, grouped, byId, fetchedAt }>}
 */
async function getActiveCatalog(forceRefresh = false) {
  if (!forceRefresh && _cache && (Date.now() - _lastFetch) < CACHE_TTL_MS) {
    return _cache;
  }

  try {
    const sessionTypes = await mindbodyService.getServices();

    // Filter to services with a configured price
    const services = sessionTypes
      .filter(st => PRICE_MAP[st.Id] != null)
      .map(st => ({
        id: st.Id,
        name: st.Name,
        duration: st.DefaultTimeLength,
        priceCents: PRICE_MAP[st.Id],
        price: PRICE_MAP[st.Id] / 100,
        category: ID_TO_CATEGORY[st.Id] || 'Other',
      }));

    // Group by category in defined order
    const grouped = {};
    for (const cat of CATEGORY_ORDER) grouped[cat] = [];
    for (const svc of services) {
      if (!grouped[svc.category]) grouped[svc.category] = [];
      grouped[svc.category].push(svc);
    }
    // Drop empty categories
    for (const cat of Object.keys(grouped)) {
      if (grouped[cat].length === 0) delete grouped[cat];
    }

    // Quick ID lookup map
    const byId = {};
    for (const svc of services) byId[svc.id] = svc;

    // Log Mindbody services that have no price config (potential new additions)
    const unconfigured = sessionTypes.filter(st => PRICE_MAP[st.Id] == null);
    if (unconfigured.length > 0) {
      logger.info(
        'Mindbody session types without price config (not shown to customers): ' +
        unconfigured.map(s => `${s.Id}: ${s.Name}`).join(', ')
      );
    }

    _cache = { services, grouped, byId, fetchedAt: new Date().toISOString() };
    _lastFetch = Date.now();

    logger.info(
      `Dynamic catalog loaded: ${services.length} services across ` +
      `${Object.keys(grouped).length} categories (fetched at ${_cache.fetchedAt})`
    );
    return _cache;

  } catch (err) {
    logger.error('Failed to load dynamic catalog from Mindbody:', err.message);
    if (_cache) {
      const ageMin = Math.round((Date.now() - _lastFetch) / 60000);
      logger.warn(`Returning stale catalog (age: ${ageMin} min)`);
      return _cache;
    }
    throw err;
  }
}

// ---- Formatters -------------------------------------------------------------

/**
 * Returns a text block listing all services per category, for use in the
 * AI system prompt.
 */
function buildSystemPromptText(catalog) {
  if (!catalog) return '(Service catalog temporarily unavailable)';
  const lines = [];
  for (const [category, services] of Object.entries(catalog.grouped)) {
    lines.push(`\n**${category}:**`);
    for (const svc of services) {
      lines.push(`- ${svc.name} | ID: ${svc.id} | €${svc.price} | ${svc.duration} min`);
    }
  }
  return lines.join('\n').trim();
}

/**
 * Builds WhatsApp list sections for ONE category.
 * Splits into chunks of ≤10 rows to respect WhatsApp limits.
 *
 * @param {object} catalog  - result of getActiveCatalog()
 * @param {string} category - e.g. 'Tech Treatments'
 * @returns {Array}         - WhatsApp list sections
 */
function buildCategoryWhatsAppSections(catalog, category) {
  if (!catalog || !catalog.grouped[category]) return [];
  const services = catalog.grouped[category];
  const sections = [];

  for (let i = 0; i < services.length; i += 10) {
    const chunk = services.slice(i, i + 10);
    const isFirst = sections.length === 0;
    const title = isFirst ? category : `${category} (${sections.length + 1})`;
    sections.push({
      title: title.substring(0, 24),
      rows: chunk.map(svc => ({
        id: `svc_${svc.id}`,
        title: svc.name.substring(0, 24),
        description: `€${svc.price} · ${svc.duration} min`.substring(0, 72),
      })),
    });
  }
  return sections;
}

/**
 * Returns available category names (for building category buttons).
 */
function getCategories(catalog) {
  return catalog ? Object.keys(catalog.grouped) : [];
}

module.exports = {
  getActiveCatalog,
  buildSystemPromptText,
  buildCategoryWhatsAppSections,
  getCategories,
  ID_TO_CATEGORY,
};
