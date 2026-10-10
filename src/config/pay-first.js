/**
 * Pay-first treatments (owner decision, Oct 2026): these are only booked in
 * Mindbody AFTER Stripe confirms the payment. Before that, nothing is held in
 * Mindbody — so an unpaid booking can never reach a therapist's calendar and
 * never has to be released (releases showed up as "No Show" on this site).
 *
 * The therapist treatments: massages, the facial, Nervous System Reset and
 * Let It Go (the latter two live under "Massages" in the menu).
 */
const PAY_FIRST_SERVICES = new Set([
  31, 32, // Tailored Massage 60 / 80
  35, 36, // Prenatal Massage 60 / 80
  37, 38, // Lymphatic Drainage 60 / 80
  41,     // Renewal Facial
  45, 63, // Nervous System Reset 60 / 80
  109,    // Let It Go
]);

// The exact treatment, for the Stripe line, the confirmation and the team
// (the catalog's group name is just "Massages" for every massage and NSR).
const PAY_FIRST_SERVICE_NAMES = {
  31: 'Tailored Massage 60 min', 32: 'Tailored Massage 80 min',
  35: 'Prenatal Massage 60 min', 36: 'Prenatal Massage 80 min',
  37: 'Lymphatic Drainage 60 min', 38: 'Lymphatic Drainage 80 min',
  41: 'Renewal Facial',
  45: 'Nervous System Reset 60 min', 63: 'Nervous System Reset 80 min',
  109: 'Let It Go',
};

function isPayFirst(sessionTypeId) {
  return PAY_FIRST_SERVICES.has(Number(sessionTypeId));
}

// How long each of these occupies its ROOM in Mindbody, per Renessence's own
// Mindbody booking widget (treatment + turnover). Used ONLY for room-overlap
// checks (occupancy, holds, blocklist) — never to decide whether a therapist's
// window fits a slot: Mindbody plans therapist time on the session itself, and
// using these there hid real bookable times (commit ce438bc).
const ROOM_BLOCK_MINUTES = {
  31: 85, 35: 85, 37: 85,   // 60-min massages
  32: 105, 36: 105, 38: 105, // 80-min massages
  41: 70,                    // facial
  45: 70, 63: 90,            // Nervous System Reset 60 / 80
  109: 90,                   // Let It Go
};

function roomBlockMinutes(sessionTypeId) {
  return ROOM_BLOCK_MINUTES[Number(sessionTypeId)] || 90;
}

// Notice needed before a pay-first treatment: times are only OFFERED from
// now + OFFER_LEAD, and a payment link is only CREATED for a start at least
// BOOK_LEAD away (the link lives 31 minutes; the rest is travel/prep margin).
const PAY_FIRST_OFFER_LEAD_MINUTES = 60;
const PAY_FIRST_BOOK_LEAD_MINUTES = 45;
// After payment, a start closer than this is not booked automatically.
const PAY_FIRST_FINALIZE_MIN_LEAD_MINUTES = 5;

// Stripe's minimum session life is 30 minutes; this is the only clock (it
// survives restarts — the in-memory timers do not).
const PAY_FIRST_LINK_MINUTES = 31;
// One reminder, if the guest has not paid or written since the link.
const PAY_FIRST_REMINDER_MINUTES = 15;

module.exports = {
  PAY_FIRST_SERVICES,
  PAY_FIRST_SERVICE_NAMES,
  isPayFirst,
  ROOM_BLOCK_MINUTES,
  roomBlockMinutes,
  PAY_FIRST_OFFER_LEAD_MINUTES,
  PAY_FIRST_BOOK_LEAD_MINUTES,
  PAY_FIRST_FINALIZE_MIN_LEAD_MINUTES,
  PAY_FIRST_LINK_MINUTES,
  PAY_FIRST_REMINDER_MINUTES,
};
