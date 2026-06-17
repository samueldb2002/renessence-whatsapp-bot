/**
 * Bookable slot times per Mindbody session type ID.
 * These match the "Active Appointment Times" in Mindbody
 * (Settings → Appointments → Scheduling Increments).
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

const SERVICE_SLOT_TIMES = {
  // Float Journey — every 90 min from 07:30
  58: ['07:30', '09:00', '10:30', '12:00', '13:30', '15:00', '16:30', '18:00', '19:30'],
  // ── Active Mindbody session types (replace dead duplicates) ──
  98: generateSlotTimes('07:00', '19:50', 35),  // 3. Small IR Sauna (1p)
  97: generateSlotTimes('07:00', '19:50', 35),  // 5. Large IR Sauna (2p)
  91: generateSlotTimes('08:15', '18:45', 90),  // 4. Finnish Sauna (3p)
  93: generateSlotTimes('07:10', '18:50', 70),  // 4. Hyperbaric Laying (60')
  92: generateSlotTimes('07:00', '19:50', 110), // 3. Hyperbaric Seated (30')
  94: generateSlotTimes('07:40', '18:40', 110), // 5. Hyperbaric Seated (60')
  // Hyperbaric Laying 60' — every 70 min (60 min session + 10 min turnover)
  70: generateSlotTimes('07:10', '18:50', 70),
  // Hyperbaric Laying 30' — every 40 min (30 min session + 10 min turnover)
  71: generateSlotTimes('07:00', '19:40', 40),
  // Hyperbaric Seated 30' — every 110 min (shared room with 60' sessions)
  74: generateSlotTimes('07:00', '19:50', 110),
  // Hyperbaric Seated 60' — every 110 min, offset by 40 min
  75: generateSlotTimes('07:40', '18:40', 110),
  // Large IR Sauna 1 (1p + 2p) — every 35 min from 07:00 to 19:50
  65: generateSlotTimes('07:00', '19:50', 35),
  67: generateSlotTimes('07:00', '19:50', 35),
  // Small IR Sauna (68) — every 35 min from 07:00 to 19:50
  68: generateSlotTimes('07:00', '19:50', 35),
  // Large IR Sauna 2 (1p + 2p) — every 35 min from 07:10 to 20:00
  76: generateSlotTimes('07:10', '20:00', 35),
  77: generateSlotTimes('07:10', '20:00', 35),
  // Finnish Sauna (1p / 2p / 3p) — every 90 min from 08:15 to 18:45
  66: generateSlotTimes('08:15', '18:45', 90),
  69: generateSlotTimes('08:15', '18:45', 90),
  87: generateSlotTimes('08:15', '18:45', 90),
  // Red Light Therapy — every 25 min from 07:00 to 20:20
  64: generateSlotTimes('07:00', '20:20', 25),
  // Hydrowave — every 30 min from 07:00 to 20:30
  80: generateSlotTimes('07:00', '20:30', 30),
  // Gym + Treatment combos — same room/schedule as the base treatment
  99:  generateSlotTimes('08:15', '18:45', 90),  // Heat & Meet (Gym + Finnish Sauna 2p)
  100: ['07:30', '09:00', '10:30', '12:00', '13:30', '15:00', '16:30', '18:00', '19:30'], // Lift & Drift (Gym + Float)
  101: generateSlotTimes('07:00', '20:30', 30),  // Move & Massage (Gym + Hydrowave)
  102: generateSlotTimes('07:00', '19:40', 40),  // Boost & Breathe (Gym + Hyperbaric 30')
  103: generateSlotTimes('07:00', '19:50', 35),  // Sweat & Reset 1p (Gym + Small IR Sauna)
  104: generateSlotTimes('07:00', '20:20', 25),  // Glow & Go (Gym + Red Light)
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
  109: generateSlotTimes('09:00', '20:00', 60), // Let It Go (Midgie, Tuesdays) — therapist-scheduled
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

module.exports = { generateSlotTimes, SERVICE_SLOT_TIMES, SERVICE_DURATIONS };
