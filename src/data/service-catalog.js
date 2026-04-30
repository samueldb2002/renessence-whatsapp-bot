/**
 * Renessence Service Catalog
 * Maps customer-facing treatment names to Mindbody session type IDs.
 * WhatsApp lists support max 10 rows per section, max 10 sections.
 * Row titles max 24 chars, descriptions max 72 chars.
 */

const SERVICE_CATALOG = [
  {
    category: 'Tech Treatments',
    services: [
      {
        displayName: 'Float (60 min)',
        description: 'Sensory deprivation float',
        mindbodyIds: [58],
        keywords: ['float', 'floating', 'drijven', 'sensory deprivation'],
      },
      {
        displayName: 'Infrared Sauna (1p)',
        description: '25 min private IR sauna',
        mindbodyIds: [65, 68, 77],
        keywords: ['infrared', 'infrarood', 'ir sauna', 'infrarood sauna', 'sauna'],
      },
      {
        displayName: 'Infrared Sauna (2p)',
        description: '25 min IR sauna together',
        mindbodyIds: [67, 76],
        keywords: ['infrared 2', 'infrarood 2', 'sauna samen', 'sauna duo'],
      },
      {
        displayName: 'Finnish Sauna (2p)',
        description: '60 min Finnish sauna',
        mindbodyIds: [69],
        keywords: ['finnish', 'finse', 'finnish sauna', 'finse sauna'],
      },
      {
        displayName: 'Finnish Sauna (3p)',
        description: '60 min Finnish sauna',
        mindbodyIds: [66],
        keywords: ['finnish 3', 'finse 3', 'finnish sauna 3'],
      },
      {
        displayName: 'Red Light Therapy',
        description: '15 min LED light session',
        mindbodyIds: [64],
        keywords: ['red light', 'rood licht', 'light therapy', 'led'],
      },
      {
        displayName: 'Oxygen Hydroxy (30m)',
        description: 'Hyperbaric oxygen therapy',
        mindbodyIds: [71, 74],
        keywords: ['oxygen 30', 'hydroxy 30', 'zuurstof 30', 'hyperbaric 30'],
      },
      {
        displayName: 'Oxygen Hydroxy (60m)',
        description: 'Hyperbaric oxygen therapy',
        mindbodyIds: [70, 75],
        keywords: ['oxygen', 'hydroxy', 'zuurstof', 'hyperbaric', 'oxygen hydroxy'],
      },
      {
        displayName: 'Hydrowave',
        description: '25 min dry water massage',
        mindbodyIds: [80],
        keywords: ['hydrowave'],
      },
    ],
  },
  {
    category: 'Massages',
    services: [
      {
        displayName: 'Massage (60 min)',
        description: 'Tailored personalised massage',
        mindbodyIds: [31],
        keywords: ['massage', 'massage 60', 'tailored massage'],
      },
      {
        displayName: 'Massage (80 min)',
        description: 'Extended tailored massage',
        mindbodyIds: [32],
        keywords: ['massage 80', 'lange massage', 'extended massage'],
      },
      {
        displayName: 'Prenatal Massage (60m)',
        description: 'Pre/post-partum massage',
        mindbodyIds: [35],
        keywords: ['prenatal', 'zwanger', 'pregnancy'],
      },
      {
        displayName: 'Prenatal Massage (80m)',
        description: 'Extended prenatal massage',
        mindbodyIds: [36],
        keywords: ['prenatal 80', 'zwanger 80'],
      },
      {
        displayName: 'Lymphatic Drain. (60m)',
        description: 'Gentle lymphatic drainage',
        mindbodyIds: [37],
        keywords: ['lymph', 'lymf', 'drainage', 'lymphatic'],
      },
      {
        displayName: 'Lymphatic Drain. (80m)',
        description: 'Extended lymphatic drainage',
        mindbodyIds: [38],
        keywords: ['lymph 80', 'drainage 80', 'lymphatic 80'],
      },
      {
        displayName: 'Renewal Facial (60m)',
        description: 'Orchid stem cell facial',
        mindbodyIds: [41],
        keywords: ['facial', 'gezicht', 'orchid', 'stem cell', 'renewal'],
      },
      {
        displayName: 'Acupuncture (Intake)',
        description: '75 min first session',
        mindbodyIds: [43],
        keywords: ['acupunctuur', 'acupuncture', 'naalden'],
      },
      {
        displayName: 'Acupuncture (Follow-up)',
        description: '60-75 min follow-up',
        mindbodyIds: [44, 52],
        keywords: ['acupunctuur vervolg', 'acupuncture follow'],
      },
      {
        displayName: 'Nervous System (60m)',
        description: 'Nervous system reset',
        mindbodyIds: [45],
        keywords: ['nervous', 'zenuw', 'nervous system'],
      },
    ],
  },
  {
    category: 'Classes',
    services: [
      {
        displayName: 'Yoga',
        description: 'Group yoga class',
        mindbodyIds: [5],
        keywords: ['yoga'],
      },
      {
        displayName: 'Hot Yoga',
        description: 'Heated yoga class',
        mindbodyIds: [6],
        keywords: ['hot yoga', 'bikram'],
      },
      {
        displayName: 'Meditation',
        description: 'Guided meditation',
        mindbodyIds: [7],
        keywords: ['meditatie', 'meditation', 'mindfulness'],
      },
    ],
  },
];

/**
 * Find a catalog service by keyword/free text.
 * Uses scoring: longer keyword matches = better match.
 */
function findServiceByText(text) {
  const query = text.toLowerCase().trim();
  const queryWords = query.split(/\s+/);
  let bestMatch = null;
  let bestScore = 0;

  for (const category of SERVICE_CATALOG) {
    for (const service of category.services) {
      // Check keyword matches
      for (const kw of service.keywords) {
        // Direct substring match (query contains keyword or keyword contains query)
        if (query.includes(kw) || kw.includes(query)) {
          const score = kw.length + (kw.includes(query) ? 2 : 0); // bonus for exact match
          if (score > bestScore) {
            bestScore = score;
            bestMatch = service;
          }
        }
        // Also check if any word in the query matches a keyword (for sentences like "ik wil sauna")
        for (const word of queryWords) {
          if (word.length >= 4 && (word === kw || kw.startsWith(word) || word.startsWith(kw))) {
            const score = Math.min(word.length, kw.length);
            if (score > bestScore) {
              bestScore = score;
              bestMatch = service;
            }
          }
        }
      }
      // Check display name match
      const dn = service.displayName.toLowerCase();
      if (dn.includes(query) || query.includes(dn)) {
        const score = dn.length + 2; // bonus for display name match
        if (score > bestScore) {
          bestScore = score;
          bestMatch = service;
        }
      }
      // Also check individual words against display name words
      const dnWords = dn.split(/\s+/);
      for (const word of queryWords) {
        if (word.length >= 4 && dnWords.some(dw => dw.startsWith(word) || word.startsWith(dw))) {
          const score = word.length;
          if (score > bestScore) {
            bestScore = score;
            bestMatch = service;
          }
        }
      }
    }
  }
  return bestMatch;
}

/**
 * Find ALL services that match a generic term (e.g. "sauna" matches 4 sauna types)
 * Returns array of matching services if the query is ambiguous (matches multiple),
 * or null if it's specific enough to match just one.
 */
function findAmbiguousMatches(text) {
  const query = text.toLowerCase().trim();
  const queryWords = query.split(/\s+/);

  // Define ambiguous terms that map to multiple services
  const ambiguousTerms = {
    sauna: (svc) => svc.displayName.toLowerCase().includes('sauna'),
    massage: (svc) => svc.displayName.toLowerCase().includes('massage'),
    hyperbaric: (svc) => svc.displayName.toLowerCase().includes('hyperbaric'),
    oxygen: (svc) => svc.displayName.toLowerCase().includes('hyperbaric') || svc.displayName.toLowerCase().includes('oxygen'),
    acupuncture: (svc) => svc.displayName.toLowerCase().includes('acupuncture'),
    acupunctuur: (svc) => svc.displayName.toLowerCase().includes('acupuncture'),
    yoga: (svc) => svc.displayName.toLowerCase().includes('yoga'),
  };

  // Check if query contains an ambiguous term but NOT a specific variant
  for (const [term, filter] of Object.entries(ambiguousTerms)) {
    if (queryWords.includes(term) || query.includes(term)) {
      // Collect all matching services
      const allServices = SERVICE_CATALOG.flatMap((cat) => cat.services);
      const matches = allServices.filter(filter);

      if (matches.length > 1) {
        // Check if the user was MORE specific (e.g. "finnish sauna" or "infrared sauna")
        // If findServiceByText gives a high-confidence specific match, use that instead
        const specificMatch = findServiceByText(text);
        if (specificMatch) {
          // Check if the specific keywords (not just the generic term) matched
          const specificKeywords = specificMatch.keywords.filter((kw) => kw.length > term.length);
          const hasSpecificMatch = specificKeywords.some((kw) => query.includes(kw));
          if (hasSpecificMatch) {
            return null; // Specific enough, no disambiguation needed
          }
        }
        return matches;
      }
    }
  }
  return null;
}

/**
 * Build WhatsApp list sections from the catalog
 */
function buildWhatsAppSections() {
  return SERVICE_CATALOG.map((cat) => ({
    title: cat.category,
    rows: cat.services.map((s) => ({
      id: `service_${s.mindbodyIds[0]}`,
      title: s.displayName.substring(0, 24),
      description: s.description.substring(0, 72),
    })),
  }));
}

module.exports = {
  SERVICE_CATALOG,
  findServiceByText,
  findAmbiguousMatches,
  buildWhatsAppSections,
};
