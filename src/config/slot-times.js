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

// Actual session duration in minutes (from Mindbody session types, includes setup/transition).
// Used to ensure a slot is only offered if the session fits within the staff's shift.
const SERVICE_DURATIONS = {
  58: 85,   // Float Journey
  64: 20,   // Red Light Therapy
  65: 35,   // Large IR Sauna 1 single
  66: 85,   // Finnish Sauna 3p
  67: 35,   // Large IR Sauna 1 2p
  68: 35,   // Small IR Sauna
  69: 85,   // Finnish Sauna 2p
  70: 70,   // Hyperbaric Laying 60 min
  71: 40,   // Hyperbaric Laying 30 min
  74: 40,   // Hyperbaric Seated 30 min
  75: 70,   // Hyperbaric Seated 60 min
  76: 35,   // Large IR Sauna 2 2p
  77: 35,   // Large IR Sauna 2 single
  80: 25,   // Hydrowave
  87: 85,   // Finnish Sauna 1p
  31: 85,   // Tailored Massage 60 min
  32: 105,  // Tailored Massage 80 min
  35: 85,   // Prenatal Massage 60 min
  36: 105,  // Prenatal Massage 80 min
  37: 85,   // Lymphatic Drainage 60 min
  38: 105,  // Lymphatic Drainage 80 min
  41: 70,   // Facial
  43: 75,   // Acupuncture First
  44: 60,   // Acupuncture Follow-up 60 min
  52: 75,   // Acupuncture Follow-up 75 min
  45: 70,   // Nervous System 60 min
  63: 90,   // Nervous System 80 min
};

module.exports = { generateSlotTimes, SERVICE_SLOT_TIMES, SERVICE_DURATIONS };
