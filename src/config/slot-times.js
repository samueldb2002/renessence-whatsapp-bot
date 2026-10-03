/**
 * Bookable slot times per Mindbody session type ID.
 *
 * For room treatments these are JOURNEY start times — the time the client
 * books and arrives, exactly as the website/app and the team's "Journey Times"
 * sheet (Canva, Oct 2026) use them. The treatment itself starts 10–15 minutes
 * later. Booking the treatment start instead (a float at 15:00 rather than the
 * 14:45 journey) made guests arrive late and broke the grid shared with the
 * website: a bot booking at 13:30 overlapped the website's 13:15 and 14:45
 * journeys ("Appointment slot already booked").
 */

function generateSlotTimes(startHHMM, endHHMM, intervalMin) {
  const times = [];
  const [sh, sm] = startHHMM.split(':').map(Number);
  const [eh, em] = endHHMM.split(':').map(Number);
  let mins = sh * 60 + sm;
  const endMins = eh * 60 + em;
  while (mins <= endMins) {
    times.push(`${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`);
    mins += intervalMin;
  }
  return times;
}

const OXYGEN_JOURNEYS = generateSlotTimes('07:00', '19:00', 40);
const FINNISH_JOURNEYS = generateSlotTimes('08:15', '17:15', 90);
const HYDROWAVE_JOURNEYS = [...generateSlotTimes('07:00', '20:00', 30), '20:15'];

const SERVICE_SLOT_TIMES = {
  // Float Journey — journeys every 90 min from 07:15 (float itself 15 min later)
  58: generateSlotTimes('07:15', '17:45', 90),
  // ── Active Mindbody session types (replace dead duplicates) ──
  98: generateSlotTimes('07:00', '19:50', 35),  // 3. Small IR Sauna (1p)
  97: generateSlotTimes('07:00', '19:50', 35),  // 5. Large IR Sauna (2p)
  91: FINNISH_JOURNEYS, // 4. Finnish Sauna (3p)
  93: OXYGEN_JOURNEYS, // 4. Hyperbaric Laying (60')
  92: OXYGEN_JOURNEYS, // 3. Hyperbaric Seated (30')
  94: OXYGEN_JOURNEYS, // 5. Hyperbaric Seated (60')
  // Hyperbaric Oxygen (all chambers, 30' and 60') — the 40-minute journey grid
  70: OXYGEN_JOURNEYS,
  71: OXYGEN_JOURNEYS,
  74: OXYGEN_JOURNEYS,
  75: OXYGEN_JOURNEYS,
  // Large IR Sauna 1 (1p + 2p) — every 35 min from 07:00 to 19:50
  65: generateSlotTimes('07:00', '19:50', 35),
  67: generateSlotTimes('07:00', '19:50', 35),
  // Small IR Sauna (68) — every 35 min from 07:00 to 19:50
  68: generateSlotTimes('07:00', '19:50', 35),
  // Large IR Sauna 2 (1p + 2p) — all infrared saunas share the 07:00 grid
  76: generateSlotTimes('07:00', '19:50', 35),
  77: generateSlotTimes('07:00', '19:50', 35),
  // Finnish Sauna (1p / 2p / 3p) — journeys every 90 min from 08:15 to 17:15
  66: FINNISH_JOURNEYS,
  69: FINNISH_JOURNEYS,
  87: FINNISH_JOURNEYS,
  // Red Light Therapy — journeys every 25 min from 07:00 to 19:30
  64: generateSlotTimes('07:00', '19:30', 25),
  // Hydrowave — journeys every 30 min from 07:00 to 20:00, plus a last one at 20:15
  80: HYDROWAVE_JOURNEYS,
  // Gym + Treatment combos — same room/schedule as the base treatment
  99:  FINNISH_JOURNEYS,                           // Heat & Meet (Gym + Finnish Sauna 2p)
  100: generateSlotTimes('07:15', '17:45', 90),  // Lift & Drift (Gym + Float)
  101: HYDROWAVE_JOURNEYS,                         // Move & Massage (Gym + Hydrowave)
  102: OXYGEN_JOURNEYS,                            // Boost & Breathe (Gym + Hyperbaric 30')
  103: generateSlotTimes('07:00', '19:50', 35),  // Sweat & Reset 1p (Gym + Small IR Sauna)
  104: generateSlotTimes('07:00', '19:30', 25),  // Glow & Go (Gym + Red Light)
  105: generateSlotTimes('07:00', '19:50', 35),  // Sweat & Reset 2p (Gym + Large IR Sauna)
  // Traditional treatments (massages, acupuncture, etc.) — every 60 min
  31: generateSlotTimes('09:00', '20:00', 60),
  32: generateSlotTimes('09:00', '20:00', 60),
  35: generateSlotTimes('09:00', '20:00', 60),
  36: generateSlotTimes('09:00', '20:00', 60),
  37: generateSlotTimes('09:00', '20:00', 60),
  38: generateSlotTimes('09:00', '20:00', 60),
  41: generateSlotTimes('09:00', '20:00', 60),
  43: generateSlotTimes('09:00', '20:00', 60),
  44: generateSlotTimes('09:00', '20:00', 60),
  45: generateSlotTimes('09:00', '20:00', 60),
  52: generateSlotTimes('09:00', '20:00', 60),
  63: generateSlotTimes('09:00', '20:00', 60),
  109: ['11:00', '13:00', '15:00'], // Let It Go (Midgie, Tuesdays only) — fixed 90-min slots
};

// Session booking duration in minutes — the ACTUAL session time, NOT including
// Mindbody's setup/transition/processing time. Used to check if a slot fits
// within the staff's available window: slotTime + duration <= windowEnd.
// (Mindbody's total block duration adds ~25 min overhead, but the window check
//  uses the real session time so slots aren't incorrectly filtered out.)
const SERVICE_DURATIONS = {
  58: 60,   // Float Journey (60 min session)
  // ── Active Mindbody session types (replace dead duplicates) ──
  98: 25,   // 3. Small IR Sauna (1p)
  97: 25,   // 5. Large IR Sauna (2p)
  91: 60,   // 4. Finnish Sauna (3p)
  93: 60,   // 4. Hyperbaric Laying (60')
  92: 30,   // 3. Hyperbaric Seated (30')
  94: 60,   // 5. Hyperbaric Seated (60')
  64: 15,   // Red Light Therapy (15 min)
  65: 25,   // Large IR Sauna 1 single (25 min)
  66: 60,   // Finnish Sauna 3p (60 min)
  67: 25,   // Large IR Sauna 1 2p (25 min)
  68: 25,   // Small IR Sauna (25 min)
  69: 60,   // Finnish Sauna 2p (60 min)
  70: 60,   // Hyperbaric Laying 60 min
  71: 30,   // Hyperbaric Laying 30 min
  74: 30,   // Hyperbaric Seated 30 min
  75: 60,   // Hyperbaric Seated 60 min
  76: 25,   // Large IR Sauna 2 2p (25 min)
  77: 25,   // Large IR Sauna 2 single (25 min)
  80: 25,   // Hydrowave (25 min)
  87: 60,   // Finnish Sauna 1p (60 min)
  99: 60,   // Heat & Meet (Gym + Finnish Sauna 2p) — 60 min session
  100: 60,  // Lift & Drift (Gym + Float) — 60 min session
  101: 25,  // Move & Massage (Gym + Hydrowave) — 25 min session
  102: 30,  // Boost & Breathe (Gym + Hyperbaric 30') — 30 min session
  103: 25,  // Sweat & Reset 1p (Gym + Small IR Sauna) — 25 min session
  104: 15,  // Glow & Go (Gym + Red Light) — 15 min session
  105: 25,  // Sweat & Reset 2p (Gym + Large IR Sauna) — 25 min session
  31: 60,   // Tailored Massage 60 min
  32: 80,   // Tailored Massage 80 min
  35: 60,   // Prenatal Massage 60 min
  36: 80,   // Prenatal Massage 80 min
  37: 60,   // Lymphatic Drainage 60 min
  38: 80,   // Lymphatic Drainage 80 min
  41: 60,   // Facial (60 min)
  43: 75,   // Acupuncture First (75 min)
  44: 60,   // Acupuncture Follow-up (60 min)
  52: 75,   // Acupuncture Follow-up (75 min)
  45: 60,   // Nervous System 60 min
  63: 80,   // Nervous System 80 min
  109: 90,  // Let It Go (90 min)
};

// How long one journey occupies the room in Mindbody, from the booked journey
// start — per the team's "Journey Times" sheet and confirmed against live
// Mindbody data (consecutive website bookings 14:45→16:10, 15:10→15:40, …).
// A slot is only offered when this whole block fits the free window; checking
// the shorter treatment time offered starts that collide with the next
// website booking. Services not listed fall back to SERVICE_DURATIONS.
const BOOKING_BLOCK_MINUTES = {
  58: 85, 100: 85,                         // Float
  66: 85, 69: 85, 87: 85, 91: 85, 99: 85,  // Finnish Sauna
  65: 30, 67: 30, 68: 30, 76: 30, 77: 30, 97: 30, 98: 30, 103: 30, 105: 30, // Infrared Sauna
  80: 25, 101: 25,                         // Hydrowave
  64: 20, 104: 20,                         // Red Light
  92: 35, 71: 35, 74: 35, 102: 35,         // Oxygen Hydroxy 30'
};

/** Minutes a slot must fit within a free window: the full Mindbody block when known. */
function fitMinutes(sessionTypeId) {
  return Math.max(SERVICE_DURATIONS[sessionTypeId] || 60, BOOKING_BLOCK_MINUTES[sessionTypeId] || 0);
}

// Room / resource-based services: their bookable start times are ONLY the fixed
// grid above, regardless of where a Mindbody availability window happens to
// start. An off-grid window start (e.g. a 17:55 leftover gap after a booking)
// is NOT a real bookable slot for a room and Mindbody rejects it at booking
// time. For these, availability must ALWAYS snap to the grid — never offer the
// raw window start. Per-therapist services (massages, facial, acupuncture,
// nervous system) are deliberately EXCLUDED: for them a window that starts
// off-grid (e.g. a therapist free from 12:50) IS a genuine bookable slot, so
// they keep the narrow-window behaviour.
const FIXED_GRID_SERVICES = new Set([
  58, 100,                       // Float / Lift & Drift
  64, 104,                       // Red Light / Glow & Go
  80, 101,                       // Hydrowave / Move & Massage
  65, 67, 68, 76, 77, 97, 98, 103, 105, // Infrared Sauna (+ Sweat & Reset)
  66, 69, 87, 91, 99,            // Finnish Sauna (+ Heat & Meet)
  70, 71, 74, 75, 92, 93, 94, 102, // Hyperbaric Oxygen (+ Boost & Breathe)
  109,                           // Let It Go (fixed 11:00/13:00/15:00)
]);

module.exports = { generateSlotTimes, SERVICE_SLOT_TIMES, SERVICE_DURATIONS, BOOKING_BLOCK_MINUTES, FIXED_GRID_SERVICES, fitMinutes };
