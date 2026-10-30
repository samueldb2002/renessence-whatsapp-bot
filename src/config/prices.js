/**
 * Prices per Mindbody session type, in euro cents — the code values. The team
 * can change the bookable ones in the dashboard ("Bot content" → Prices); the
 * saved prices then replace these in payment.service.js's PRICE_MAP, which
 * Stripe bills from and every € the bot shows is derived from.
 */

const DEFAULT_PRICES = {
  // Gym + Treatment combos - €50
  99:  5000,  // Heat & Meet (Gym + Finnish Sauna 2p)
  100: 5000,  // Lift & Drift (Gym + Float)
  101: 5000,  // Move & Massage (Gym + Hydrowave)
  102: 5000,  // Boost & Breathe (Gym + Hyperbaric 30 min)
  103: 5000,  // Sweat & Reset 1p (Gym + IR Sauna)
  104: 5000,  // Glow & Go (Gym + Red Light)
  105: 5000,  // Sweat & Reset 2p (Gym + IR Sauna)
  // Tech Treatments
  58: 8000,   // Float Journey (60 min) - €80
  // Oxygen Hydroxy — active session types
  71: 5000,   // 2. Hyperbaric Oxygen Hydroxy Laying (30 min) - €50
  93: 9500,   // 4. Hyperbaric Oxygen Hydroxy Laying (60 min) - €95
  92: 5000,   // 3. Hyperbaric Oxygen Hydroxy Seated (30 min) - €50
  94: 9500,   // 5. Hyperbaric Oxygen Hydroxy Seated (60 min) - €95
  // Infrared Sauna — active session types
  98: 3000,   // 3. Small Infrared Sauna Journey (1 person) - €30
  65: 3500,   // 4. Large Infrared Sauna Journey (1 person) - €35
  97: 4500,   // 5. Large Infrared Sauna Journey (2 people) - €45
  // Finnish Sauna — active session types
  87: 8000,   // 2. Finnish Sauna (1 person) - €80
  69: 8000,   // 3. Finnish Sauna (2 people) - €80
  91: 9000,   // 4. Finnish Sauna (3 people) - €90
  // Legacy/inactive session types kept for old bookings/lookups
  70: 9500, 74: 5000, 75: 9500, 68: 3000, 77: 3500, 67: 4500, 76: 4500, 66: 9000,
  64: 4500,   // Red Light Therapy (15 min) - €45
  80: 3500,   // Hydrowave (25 min) - €35 (was €30 until 22 Sep 2026)
  83: 2200,   // Studio Classes (60 min) - €22
  // Traditional Treatments
  43: 15000,  // Acupuncture First Session (75min) - €150
  44: 12000,  // Acupuncture Follow-up (60min) - €120
  52: 15000,  // Acupuncture Follow-up (75min) - €150
  41: 16500,  // Orchid Stem Cell Renewal Facial (60min) - €165
  37: 13000,  // Lymphatic Drainage Massage (60min) - €130
  38: 17000,  // Lymphatic Drainage Massage (80min) - €170
  31: 13000,  // Tailored Massage (60min) - €130
  32: 17000,  // Tailored Massage (80min) - €170
  30: 3000,   // LED Light Face Therapy (Add-on) - €30
  35: 13000,  // Prenatal Massage (60min) - €130
  36: 17000,  // Prenatal Massage (80min) - €170
  45: 13000,  // Nervous System Treatment (60min) - €130
  63: 17000,  // Nervous System Treatment (80min) - €170
  109: 18000, // Let It Go — psycho-energetic therapy (90 min) - €180
};

// What the team can change: the session types guests can book today. Legacy
// types (kept for old bookings), acupuncture and the paused gym combos keep
// their code price.
const BOOKABLE_PRICE_IDS = [
  58, 98, 65, 97, 87, 69, 91, 64, 71, 92, 93, 94, 80, // tech treatments
  31, 32, 35, 36, 37, 38, 45, 63, 109, 41, 30,         // massages, therapy, facial, LED add-on
  83,                                                  // studio classes
];

// The exact treatment for each bookable session type. The group names are
// shared ("Oxygen Hydroxy" covers seated AND lying), so the model once booked
// a seated session while telling the guest "lying pod" — it couldn't see the
// difference. Slots, booking results, the team and Stripe all use these.
const SERVICE_NAMES = {
  58: 'Float Journey',
  71: 'Oxygen Hydroxy (lying, 30 min)', 93: 'Oxygen Hydroxy (lying, 60 min)',
  92: 'Oxygen Hydroxy (seated, 30 min)', 94: 'Oxygen Hydroxy (seated, 60 min)',
  98: 'Infrared Sauna (small, 1 person)', 65: 'Infrared Sauna (large, 1 person)', 97: 'Infrared Sauna (large, 2 people)',
  87: 'Finnish Sauna (1 person)', 69: 'Finnish Sauna (2 people)', 91: 'Finnish Sauna (3 people)',
  64: 'Red Light Therapy', 80: 'Hydrowave Massage', 83: 'Studio Class',
  31: 'Tailored Massage 60 min', 32: 'Tailored Massage 80 min',
  35: 'Prenatal Massage 60 min', 36: 'Prenatal Massage 80 min',
  37: 'Lymphatic Drainage 60 min', 38: 'Lymphatic Drainage 80 min',
  41: 'Renewal Facial', 30: 'LED Light Face Therapy',
  45: 'Nervous System Reset 60 min', 63: 'Nervous System Reset 80 min',
  109: 'Let It Go',
};

module.exports = { DEFAULT_PRICES, BOOKABLE_PRICE_IDS, SERVICE_NAMES };
