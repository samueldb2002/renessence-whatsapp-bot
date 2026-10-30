/**
 * Treatments as the team manages them in the dashboard ("Bot content" →
 * Treatments): pause one, change the days it runs, and the name and note of
 * the rows in the WhatsApp menu. These are the code values the bot used until
 * then (DAY_RESTRICTIONS in tool-implementations.js, the hand-written step-1
 * menu in system-prompt.js).
 *
 * A treatment is every variant guests choose between (60/80 min, 1–3 people):
 * pausing one pauses all its session types. Adding a brand-new treatment still
 * needs code (rooms, start-time grid, payment model) and a test booking.
 */

const TREATMENTS = [
  { key: 'float', name: 'Float Journey', ids: [58] },
  { key: 'infrared', name: 'Infrared Sauna', ids: [98, 65, 97] },
  { key: 'finnish', name: 'Finnish Sauna', ids: [87, 69, 91] },
  { key: 'redlight', name: 'Red Light Therapy', ids: [64] },
  { key: 'oxygen', name: 'Oxygen Hydroxy', ids: [71, 92, 93, 94] },
  { key: 'hydrowave', name: 'Hydrowave Massage', ids: [80] },
  { key: 'tailored', name: 'Tailored Massage', ids: [31, 32] },
  { key: 'prenatal', name: 'Prenatal Massage', ids: [35, 36] },
  { key: 'lymphatic', name: 'Lymphatic Drainage', ids: [37, 38] },
  { key: 'nsr', name: 'Nervous System Reset', ids: [45, 63] },
  { key: 'letitgo', name: 'Let It Go', ids: [109], times: '11:00, 13:00 or 15:00', withWhom: 'therapist Midgie Sikkelorum, 90 min' },
  { key: 'facial', name: 'Renewal Facial', ids: [41] },
  // Classes follow the Mindbody class schedule: no day setting.
  { key: 'classes', name: 'Studio Classes', ids: [83], noDays: true },
];

// The rows of the first WhatsApp list. The price in front of the note comes
// from the prices of its session types (ids; the Massages row only opens the
// next list).
const MENU_ROWS = [
  { id: 'svc_58', name: 'Float Journey', note: '60 min', ids: [58] },
  { id: 'svc_ir', name: 'Infrared Sauna', note: '25 min', ids: [98, 65, 97] },
  { id: 'svc_finn', name: 'Finnish Sauna Journey', note: '60 min', ids: [87, 69, 91] },
  { id: 'svc_64', name: 'Red Light Therapy', note: '15 min', ids: [64] },
  { id: 'svc_oxy', name: 'Oxygen Hydroxy', note: 'seated or lying', ids: [93, 71, 92, 94] },
  { id: 'svc_80', name: 'Hydrowave Massage', note: '25 min', ids: [80] },
  { id: 'svc_massages', name: 'Massages', note: 'Tailored · Prenatal · Lymphatic · Nervous System · Let It Go', noPrice: true },
  { id: 'svc_41', name: 'Renewal Facial', note: '60 min', ids: [41] },
  { id: 'svc_83', name: 'Studio Classes', note: '60 min · Vinyasa, Pilates & more', ids: [83] },
];

// 0 = Sunday … 6 = Saturday, as Date#getDay. An empty list: every day.
const DEFAULT_DAYS = { nsr: [5], letitgo: [2] };

const DEFAULT_TREATMENTS = {
  items: Object.fromEntries(TREATMENTS.map(t => [t.key, { paused: false, days: DEFAULT_DAYS[t.key] || [] }])),
  menu: Object.fromEntries(MENU_ROWS.map(r => [r.id, { name: r.name, note: r.note }])),
};

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

module.exports = { TREATMENTS, MENU_ROWS, DEFAULT_TREATMENTS, DAY_NAMES };
