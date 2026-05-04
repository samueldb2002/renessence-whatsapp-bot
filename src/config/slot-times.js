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
  // Hyperbaric Oxygen Laying (30 & 60 min) — every 30 min
  70: generateSlotTimes('07:00', '20:00', 30),
  71: generateSlotTimes('07:00', '20:00', 30),
  // Hyperbaric Oxygen Seated (30 & 60 min) — every 30 min
  74: generateSlotTimes('07:00', '20:00', 30),
  75: generateSlotTimes('07:00', '20:00', 30),
  // Infrared Saunas — every 30 min
  65: generateSlotTimes('07:00', '20:00', 30),
  66: generateSlotTimes('07:00', '20:00', 30),
  67: generateSlotTimes('07:00', '20:00', 30),
  68: generateSlotTimes('07:00', '20:00', 30),
  69: generateSlotTimes('07:00', '20:00', 30),
  76: generateSlotTimes('07:00', '20:00', 30),
  77: generateSlotTimes('07:00', '20:00', 30),
  // Finnish Sauna 1p — every 30 min
  87: generateSlotTimes('07:00', '20:00', 30),
  // Red Light Therapy — every 30 min
  64: generateSlotTimes('07:00', '20:00', 30),
  // Hydrowave — every 30 min
  80: generateSlotTimes('07:00', '20:00', 30),
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
};

// Session booking duration in minutes — the ACTUAL session time, NOT including
// Mindbody's setup/transition/processing time. Used to check if a slot fits
// within the staff's available window: slotTime + duration <= windowEnd.
// (Mindbody's total block duration adds ~25 min overhead, but the window check
//  uses the real session time so slots aren't incorrectly filtered out.)
const SERVICE_DURATIONS = {
  58: 60,   // Float Journey (60 min session)
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
};

module.exports = { generateSlotTimes, SERVICE_SLOT_TIMES, SERVICE_DURATIONS };
