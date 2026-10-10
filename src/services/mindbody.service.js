const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');
const phone = require('../utils/phone');
const { SERVICE_DURATIONS } = require('../config/slot-times');

const BASE_URL = 'https://api.mindbodyonline.com/public/v6';

let userToken = null;
let tokenExpiry = null;

// Axios instance with default headers and timeout
const api = axios.create({
  baseURL: BASE_URL,
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
    'Api-Key': config.MINDBODY_API_KEY,
    SiteId: config.MINDBODY_SITE_ID,
  },
});

// M15: shared phone variant builder — used by both getClientByPhone and getAllClientsByPhone
function buildPhoneVariants(phoneNumber) {
  const normalized = phone.normalize(phoneNumber);
  const bare = normalized.replace(/^\+\d{2}/, '').replace(/^0/, ''); // digits only, no prefix
  return [
    normalized,                                  // +31655505545
    normalized.replace('+', ''),                 // 31655505545
    '0' + normalized.replace(/^\+\d{2}/, ''),    // 0655505545
    bare,                                        // 655505545 ← stored without any prefix
  ];
}

// Token management
async function getToken() {
  if (userToken && tokenExpiry && Date.now() < tokenExpiry) {
    return userToken;
  }
  logger.info('Requesting new Mindbody user token...');
  const res = await api.post('/usertoken/issue', {
    Username: config.MINDBODY_USERNAME,
    Password: config.MINDBODY_PASSWORD,
  });
  userToken = res.data.AccessToken;
  // Refresh 1 hour before expiry (tokens last 24h)
  tokenExpiry = Date.now() + 23 * 60 * 60 * 1000;
  return userToken;
}

async function authHeaders() {
  const token = await getToken();
  return { authorization: token };
}

// M10: retry wrapper — handles 401 (expired token) + transient 5xx/429
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);
async function withRetry(fn, attempt = 1) {
  try {
    return await fn();
  } catch (err) {
    const status = err.response?.status;
    if (status === 401 && attempt === 1) {
      logger.warn('Mindbody token expired, refreshing...');
      userToken = null;
      tokenExpiry = null;
      return withRetry(fn, 2);
    }
    if (TRANSIENT_STATUSES.has(status) && attempt < 3) {
      const delay = attempt * 1000;
      logger.warn(`Mindbody ${status} — retrying in ${delay}ms (attempt ${attempt})`);
      await new Promise(r => setTimeout(r, delay));
      return withRetry(fn, attempt + 1);
    }
    throw err;
  }
}

// ---- Services / Session Types ----

async function getServices() {
  return withRetry(async () => {
    const headers = await authHeaders();
    const res = await api.get('/site/sessiontypes', {
      headers,
      params: { OnlineOnly: true },
    });
    return res.data.SessionTypes || [];
  });
}

// ---- Availability ----

// Mindbody caps list responses (default 100 items, max 200 per request). A
// multi-day availability query over fragmented schedules can exceed that, and
// a truncated response silently reads as "less availability" — the same
// symptom family as the fragmented-windows bug. Page until done, bounded.
const BOOKABLE_PAGE_LIMIT = 200;
const BOOKABLE_MAX_PAGES = 10;

/**
 * Drain a paged endpoint. fetchPage(offset, limit) → { items, total }.
 * Stops on a short page, on reaching the reported total, or at the page cap.
 */
async function fetchAllPages(fetchPage, limit = BOOKABLE_PAGE_LIMIT, maxPages = BOOKABLE_MAX_PAGES) {
  const all = [];
  for (let page = 0; page < maxPages; page++) {
    const { items, total } = await fetchPage(page * limit, limit);
    all.push(...(items || []));
    if (!items || items.length < limit) break;              // short page = done
    if (Number.isFinite(total) && all.length >= total) break; // reported total reached
  }
  return all;
}

async function getBookableItems(sessionTypeId, startDate, endDate) {
  return withRetry(async () => {
    const headers = await authHeaders();
    logger.debug(`Mindbody bookableItems request: sessionType=${sessionTypeId}, start=${startDate}, end=${endDate}`);
    return fetchAllPages(async (offset, limit) => {
      const res = await api.get('/appointment/bookableitems', {
        headers,
        params: {
          SessionTypeIds: [sessionTypeId],
          LocationId: 1,
          StartDate: startDate,
          EndDate: endDate,
          Limit: limit,
          Offset: offset,
        },
      });
      const items = res.data.Availabilities || res.data.AvailableItems || [];
      logger.debug(`Mindbody bookableItems page (offset ${offset}): ${items.length} items`);
      return { items, total: res.data.PaginationResponse?.TotalResults };
    });
  });
}

// ---- Appointments ----

// Resource mapping: session type ID -> possible resource IDs (in order of preference)
const RESOURCE_MAP = {
  // ── Active Mindbody session types (replace dead duplicates) ──
  98: [27],                    // 3. Small IR Sauna (1p) → Small Infrared Sauna 3
  97: [23, 25],                // 5. Large IR Sauna (2p) → Large IR Sauna 1 + 2
  91: [28],                    // 4. Finnish Sauna (3p) → Finnish Sauna
  93: [20, 24],                // 4. Hyperbaric Laying (60') → Laying 1, Laying 2
  92: [22],                    // 3. Hyperbaric Seated (30') → Seated
  94: [22],                    // 5. Hyperbaric Seated (60') → Seated
  58: [26],                    // Float Journey → Floating
  64: [19, 21],                // Red Light Therapy → Red Light Therapy, New Red Light Therapy
  65: [23],                    // Large Infrared Sauna 1 single → Large Infrared Sauna 1
  66: [28],                    // Finnish Sauna 3p → Finnish Sauna
  87: [28],                    // Finnish Sauna 1p → Finnish Sauna
  67: [23],                    // Large Infrared Sauna 1 2p → Large Infrared Sauna 1
  68: [27],                    // Small Infrared Sauna → Small Infrared Sauna 3
  69: [28],                    // Finnish Sauna 2p → Finnish Sauna
  70: [20, 24],                // Hyperbaric Laying 60 → Laying 1, Laying 2
  71: [20, 24],                // Hyperbaric Laying 30 → Laying 1, Laying 2
  74: [22],                    // Hyperbaric Seated 30 → Seated
  75: [22],                    // Hyperbaric Seated 60 → Seated
  76: [25],                    // Large Infrared Sauna 2 2p → Large Infrared Sauna 2
  77: [25],                    // Large Infrared Sauna 2 single → Large Infrared Sauna 2
  78: [29],                    // Creative Space half → Creative Space
  79: [29],                    // Creative Space full → Creative Space
  80: [30],                    // Hydrowave → Innovative Room
  99: [28],                    // Heat & Meet (Gym + Finnish Sauna 2p) → Finnish Sauna
  100: [26],                   // Lift & Drift (Gym + Float) → Floating
  101: [30],                   // Move & Massage (Gym + Hydrowave) → Innovative Room
  102: [20, 24],               // Boost & Breathe (Gym + Hyperbaric 30') → Laying 1, Laying 2
  103: [27],                   // Sweat & Reset 1p (Gym + Small IR Sauna) → Small Infrared Sauna
  104: [19, 21],               // Glow & Go (Gym + Red Light) → Red Light Therapy rooms
  105: [23, 25],               // Sweat & Reset 2p (Gym + Large IR Sauna) → Large IR Sauna 1+2
  31: [3, 4],                  // Tailored Massage 60 → Massage Room 1, 2
  32: [3, 4],                  // Tailored Massage 80 → Massage Room 1, 2
  35: [3, 4],                  // Prenatal Massage 60 → Massage Room 1, 2
  36: [3, 4],                  // Prenatal Massage 80 → Massage Room 1, 2
  37: [3, 4],                  // Lymphatic Drainage 60 → Massage Room 1, 2
  38: [3, 4],                  // Lymphatic Drainage 80 → Massage Room 1, 2
  41: [1],                     // Facial → Treatment Room
  43: [1, 5],                  // Acupuncture First → Treatment Room, Well-being Studio
  44: [1, 5],                  // Acupuncture Follow-up → Treatment Room, Well-being Studio
  45: [1, 5],                  // Nervous System 60 → Treatment Room, Well-being Studio
  63: [1, 5],                  // Nervous System 80 → Treatment Room, Well-being Studio
  52: [1, 5],                  // Acupuncture Follow-up 75 → Treatment Room, Well-being Studio
  109: [1],                    // Let It Go (Midgie) → Treatment Room
};

// ---- Booking (POST /appointment/addappointment) ----
//
// A booking POST is NOT idempotent: if Mindbody created the appointment but the
// answer got lost (timeout, 5xx), retrying — or moving on to the next room or
// therapist — creates a second appointment. So a POST is only repeated when it
// certainly did nothing (401 token expiry, 429 rate limit); any other unclear
// result throws BOOKING_OUTCOME_UNKNOWN and the caller checks Mindbody
// (findClientAppointmentAt) before doing anything else.

function makeBookingError(code, message, details) {
  const err = new Error(message);
  err.code = code;
  if (details) err.details = details;
  return err;
}

/** A definite rejection: a 4xx with Mindbody's own Error body. Nothing was created. */
function isDefiniteRejection(err) {
  const status = err?.response?.status;
  return !!(status && status >= 400 && status < 500 && status !== 401 && status !== 429 && err.response?.data?.Error);
}

function errorText(err) {
  return err?.response?.data?.Error?.Message || err?.message || '';
}

function isStaffRejection(err) {
  return /staff|subscriber|teacher|instructor|therapist/i.test(errorText(err));
}

function isRoomRejection(err) {
  return /resource|room/i.test(errorText(err)) || err?.response?.data?.Error?.Code === 'InvalidResource';
}

async function postAddAppointment(body) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const headers = await authHeaders();
    try {
      const res = await api.post('/appointment/addappointment', body, { headers });
      return res.data.Appointment;
    } catch (err) {
      const status = err.response?.status;
      if (status === 401 && attempt === 1) {
        logger.warn('Mindbody token expired during booking, refreshing...');
        userToken = null;
        tokenExpiry = null;
        continue;
      }
      if (status === 429 && attempt < 3) {
        await new Promise(r => setTimeout(r, attempt * 1000));
        continue;
      }
      if (isDefiniteRejection(err)) throw err;
      // Timeout, no response, 5xx, or an error without Mindbody's body: the
      // appointment may or may not exist now.
      logger.error(`Mindbody addAppointment outcome UNKNOWN (status ${status || 'none'}): ${errorText(err)}`);
      throw makeBookingError('BOOKING_OUTCOME_UNKNOWN', `Mindbody did not confirm the booking (${status || 'no response'}): ${errorText(err)}`, { status });
    }
  }
  throw makeBookingError('BOOKING_OUTCOME_UNKNOWN', 'Mindbody kept rate-limiting the booking request');
}

/**
 * Book an appointment.
 * @param {object} o
 * @param {boolean} [o.strictRooms] the treatment needs one of its mapped rooms:
 *   never fall back to a booking without a room (that call always fails with
 *   "Resource is required" and hides the real room errors).
 * @param {number}  [o.preferredResourceId] room to try first (e.g. known free)
 * @param {boolean} [o.staffRequested] the guest chose this therapist
 * Throws: a staff rejection unchanged (callers retry other therapists);
 *   code ROOM_UNAVAILABLE when the rooms were the problem;
 *   code BOOKING_OUTCOME_UNKNOWN when Mindbody's answer was unclear.
 */
async function addAppointment({ clientId, locationId, sessionTypeId, staffId, startDateTime, notes, strictRooms = false, preferredResourceId = null, staffRequested = false }) {
  // If no valid staffId, find an available staff member for this session type
  let resolvedStaffId = staffId;
  if (!resolvedStaffId || resolvedStaffId === 0) {
    logger.info('No staffId provided, looking up available staff...');
    // Resolve from who is ACTUALLY free at this time (same source as the
    // offered slots). The old first-configured-staff pick booked slots
    // against therapists who weren't available, so Mindbody rejected slots
    // that were genuinely free (Olivia/Marlies incidents).
    const availableNow = await findAvailableStaffForTime(sessionTypeId, startDateTime, null);
    if (availableNow.length > 0) {
      resolvedStaffId = availableNow[0];
      logger.info(`Using staff available at ${startDateTime}: ID ${resolvedStaffId}`);
    } else {
      try {
        const staffMembers = await withRetry(async () => {
          const headers = await authHeaders();
          const staffRes = await api.get('/staff/staff', { headers, params: { SessionTypeId: sessionTypeId } });
          return staffRes.data.StaffMembers || [];
        });
        if (staffMembers.length > 0) {
          resolvedStaffId = staffMembers[0].Id;
          logger.info(`No time-matched staff found; falling back to first staff for service: ${staffMembers[0].Name} (ID: ${resolvedStaffId})`);
        }
      } catch (staffErr) {
        logger.warn('Could not fetch staff for session type, trying without filter...');
        const allStaff = await getStaff();
        if (allStaff.length > 0) {
          resolvedStaffId = allStaff[0].Id;
          logger.info(`Using first available staff: ${allStaff[0].Name} (ID: ${resolvedStaffId})`);
        }
      }
    }
  }

  const baseBody = {
    ClientId: String(clientId),
    LocationId: locationId || 1,
    SessionTypeId: sessionTypeId,
    StaffId: resolvedStaffId,
    StartDateTime: startDateTime,
    ApplyPayment: false,
    SendEmail: false,
    ...(staffRequested ? { StaffRequested: true } : {}),
    ...(notes ? { Notes: notes } : {}),
  };

  // Rooms this treatment can use, the known-free one first.
  let possibleResources = RESOURCE_MAP[sessionTypeId] || [];
  if (preferredResourceId && possibleResources.includes(Number(preferredResourceId))) {
    possibleResources = [Number(preferredResourceId), ...possibleResources.filter(r => r !== Number(preferredResourceId))];
  }

  if (possibleResources.length > 0) {
    const failures = [];
    for (const resourceId of possibleResources) {
      // M3: log only non-PII identifiers, not full body (which includes ClientId and Notes)
      logger.info(`Mindbody addAppointment request: sessionType=${sessionTypeId} resource=${resourceId} start=${startDateTime}`);
      try {
        const apt = await postAddAppointment({ ...baseBody, ResourceIds: [resourceId] });
        logger.info('Mindbody addAppointment success with resource ' + resourceId);
        if (apt && typeof apt === 'object') apt.__resourceId = resourceId;
        return apt;
      } catch (err) {
        // Unclear outcome: stop right here — another room or therapist could
        // become a second appointment.
        if (err.code === 'BOOKING_OUTCOME_UNKNOWN') throw err;
        logger.warn('Resource ' + resourceId + ' failed: ' + errorText(err));
        failures.push({ resourceId, err });
      }
    }
    const roomFailures = failures.filter(f => isRoomRejection(f.err));
    const staffFailures = failures.filter(f => isStaffRejection(f.err) && !isRoomRejection(f.err));
    // Every room said "this therapist can't": that is a staff problem — throw
    // it unchanged so the caller tries the therapists who are free.
    if (staffFailures.length === failures.length) throw failures[0].err;
    if (strictRooms) {
      if (roomFailures.length > 0) {
        throw makeBookingError('ROOM_UNAVAILABLE',
          `No room free: ${failures.map(f => `room ${f.resourceId}: ${errorText(f.err)}`).join('; ')}`,
          { rooms: failures.map(f => ({ resourceId: f.resourceId, message: errorText(f.err) })) });
      }
      throw failures[failures.length - 1].err;
    }
    // Non-room rejections other than staff stop here, as before.
    if (roomFailures.length === 0) throw failures[failures.length - 1].err;
    // All resources failed — fall back to booking without a resource
    logger.warn('All resources failed for session type ' + sessionTypeId + ', retrying without resource...');
  }

  // No resource mapping (or the legacy fallback) — try without ResourceIds
  logger.info(`Mindbody addAppointment request (no resource): sessionType=${sessionTypeId} start=${startDateTime}`);
  try {
    const apt = await postAddAppointment(baseBody);
    logger.info(`Mindbody addAppointment success: aptId=${apt?.Id} sessionType=${apt?.SessionTypeId}`);
    return apt;
  } catch (err) {
    logger.error('Mindbody addAppointment FULL error response:', JSON.stringify({
      status: err.response?.status,
      statusText: err.response?.statusText,
      data: err.response?.data,
    }));
    throw err;
  }
}

/**
 * The client's live appointment at this start (and session type), straight
 * from Mindbody — how a booking with an unclear outcome is settled. Throws on
 * an API error (the caller must then treat the outcome as still unknown).
 */
async function findClientAppointmentAt(clientId, startDateTime, sessionTypeId = null) {
  if (!clientId || !startDateTime) return null;
  const day = String(startDateTime).slice(0, 10);
  const apts = await getStaffAppointments(day, day, clientId);
  const key = String(startDateTime).slice(0, 16);
  return (apts || []).find(a =>
    String(a.StartDateTime || '').slice(0, 16) === key
    && (!sessionTypeId || Number(a.SessionTypeId) === Number(sessionTypeId))
    // Cancelled, LateCancelled and NoShow (how this site records cancels) are
    // not a booking — adopting one would confirm a booking that doesn't exist.
    && !isCancelEffectiveStatus(a.Status)
  ) || null;
}

// ---- Room occupancy (read-only) ----
// bookableitems only says when a THERAPIST is free; a massage offered at a time
// when both massage rooms are taken failed in Mindbody ("Resource is
// required"). The day's appointments carry the rooms they use, so occupancy
// can be read before a time is offered or paid for.
const occupancyCache = new Map(); // date -> { at, value }
const OCCUPANCY_TTL_MS = 60 * 1000;

/**
 * { known, busy } for one day. busy: Map(resourceId -> [{start, end}] in ms).
 * known=false when Mindbody's answer doesn't show rooms at all (then nothing
 * can be concluded). Throws on an API error.
 */
async function getRoomOccupancy(date) {
  const day = String(date).slice(0, 10);
  const cached = occupancyCache.get(day);
  if (cached && Date.now() - cached.at < OCCUPANCY_TTL_MS) return cached.value;
  const apts = await withRetry(async () => {
    const headers = await authHeaders();
    return fetchAllPages(async (offset, limit) => {
      const res = await api.get('/appointment/staffappointments', {
        headers,
        params: { StartDate: day, EndDate: day, Limit: limit, Offset: offset },
      });
      return { items: res.data.Appointments || [], total: res.data.PaginationResponse?.TotalResults };
    });
  });
  const busy = new Map();
  let sawRoomField = false;
  for (const a of apts) {
    if (Array.isArray(a.Resources)) sawRoomField = true;
    // Cancelled appointments free their room; everything else (incl. NoShow,
    // which this site uses for released bookings) is treated as occupying it.
    if (/cancel/i.test(String(a.Status || ''))) continue;
    const start = new Date(a.StartDateTime).getTime();
    const end = new Date(a.EndDateTime).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    for (const r of (a.Resources || [])) {
      const id = Number(r?.Id);
      if (!id) continue;
      if (!busy.has(id)) busy.set(id, []);
      busy.get(id).push({ start, end });
    }
  }
  const value = { known: apts.length === 0 || sawRoomField, busy };
  occupancyCache.set(day, { at: Date.now(), value });
  return value;
}

/** Forget cached occupancy (after the bot itself booked something). */
function invalidateRoomOccupancy(date) {
  if (date) occupancyCache.delete(String(date).slice(0, 10));
  else occupancyCache.clear();
}

/**
 * Which staff can ACTUALLY take this session type at this exact start time?
 * Answers from /appointment/bookableitems — the same source the offered slots
 * came from — so booking uses the therapist whose window produced the slot.
 *
 * This exists because the old fallback picked staffMembers[0] (the first staff
 * configured for the service) with no regard for availability: a slot offered
 * from Esmeralda's window then got booked against a different therapist,
 * Mindbody rejected it, and the bot told the customer the slot was "just
 * taken" while it was still free.
 *
 * Returns distinct staff IDs whose window covers the start time (excluding
 * excludeStaffId), best candidates first: windows that also fit the full
 * session duration rank above bare containment.
 */
async function findAvailableStaffForTime(sessionTypeId, startDateTime, excludeStaffId, { throwOnError = false } = {}) {
  const date = String(startDateTime).slice(0, 10);
  const t = new Date(startDateTime).getTime();
  const durationMs = (SERVICE_DURATIONS[sessionTypeId] || 60) * 60000;
  let items = [];
  try {
    // via module.exports so tests can stub the lookup; same function in prod
    items = await module.exports.getBookableItems(sessionTypeId, date, date);
  } catch (err) {
    logger.warn('findAvailableStaffForTime: bookableitems lookup failed:', err.message);
    // Pay-first must tell "nobody is free" apart from "Mindbody didn't answer".
    if (throwOnError) throw err;
    return [];
  }
  const fits = [];
  const covers = [];
  for (const it of items) {
    const staffId = it.Staff?.Id;
    if (!staffId || String(staffId) === String(excludeStaffId || '')) continue;
    const ws = new Date(it.StartDateTime).getTime();
    const we = new Date(it.EndDateTime).getTime();
    if (!(ws <= t && t < we)) continue;
    (t + durationMs <= we ? fits : covers).push(staffId);
  }
  return [...new Set([...fits, ...covers])];
}

/**
 * Does this post-cancel Status mean the appointment is no longer active?
 * Cancelled/LateCancelled/EarlyCancelled: yes. NoShow: yes — this site returns
 * it for cancels that do land (see cancelAppointment), though the calendar
 * entry may remain as a billable no-show, so callers pass that on to the team.
 * Anything still-active or missing: no.
 */
function isCancelEffectiveStatus(status) {
  if (!status) return false;
  const s = String(status).trim();
  return /cancel/i.test(s) || /^no[\s-]?show$/i.test(s);
}

async function cancelAppointment(appointmentId) {
  return withRetry(async () => {
    const headers = await authHeaders();
    logger.info('Cancelling Mindbody appointment:', appointmentId);
    try {
      const res = await api.post('/appointment/updateappointment', {
        AppointmentId: appointmentId,
        Execute: 'Cancel',
      }, { headers });
      const status = res.data?.Appointment?.Status;
      logger.info('Cancel appointment response status:', status);
      // Which response statuses mean the cancel took effect? Production evidence
      // on THIS site: Execute:'Cancel' routinely returns Status "NoShow" for
      // cancels that genuinely land (the appointment vanishes from active
      // bookings; a retry gets "Appointment Id not found"). Rejecting NoShow
      // made the bot tell a customer the cancellation failed while it had in
      // fact succeeded, and fired a needless team escalation. So NoShow counts
      // as effective — but callers surface it to the team (the calendar entry
      // may still sit there as a billable no-show, the Angy incident). Only a
      // still-ACTIVE status (Booked/Confirmed/Arrived/Completed) or a missing
      // status means the cancel did not take effect.
      if (!isCancelEffectiveStatus(status)) {
        throw new Error(`Cancellation did not take effect — Mindbody returned status "${status || 'unknown'}" for appointment ${appointmentId}`);
      }
      return res.data.Appointment;
    } catch (err) {
      logger.error('Cancel appointment error:', JSON.stringify({
        status: err.response?.status,
        data: err.response?.data,
      }));
      throw err;
    }
  });
}

/**
 * Rewrite an appointment's note.
 *
 * Used when a treatment that is normally settled at reception gets prepaid as
 * part of a journey over the prepay threshold: its note still reads
 * "UNPAID — pay on location", which would have the front desk charge a guest
 * who already paid. Same endpoint cancelAppointment uses, without Execute.
 *
 * Best-effort by design — the caller must never let a note failure affect the
 * payment flow.
 */
async function updateAppointmentNotes(appointmentId, notes) {
  return withRetry(async () => {
    const headers = await authHeaders();
    const res = await api.post('/appointment/updateappointment', {
      AppointmentId: appointmentId,
      Notes: notes,
    }, { headers });
    logger.info('Mindbody appointment note updated:', appointmentId);
    return res.data?.Appointment;
  });
}

async function getStaffAppointments(startDate, endDate, clientId, staffId) {
  return withRetry(async () => {
    const headers = await authHeaders();
    const params = { StartDate: startDate, EndDate: endDate };
    if (clientId) params.ClientId = clientId;
    if (staffId) params.StaffIds = String(staffId);
    const res = await api.get('/appointment/staffappointments', {
      headers,
      params,
    });
    return res.data.Appointments || [];
  });
}

async function getUpcomingAppointments(fromDate, toDate) {
  const start = fromDate.toISOString().split('T')[0];
  const end = toDate.toISOString().split('T')[0];
  return getStaffAppointments(start, end);
}

// ---- Clients ----

async function searchClientByName(name) {
  return withRetry(async () => {
    const headers = await authHeaders();

    const trySearch = async (text) => {
      logger.info('Searching Mindbody client by name/text:', text);
      const res = await api.get('/client/clients', {
        headers,
        params: { SearchText: text },
      });
      const clients = res.data.Clients || [];
      if (clients.length > 0) {
        logger.info('Found client by name search:', clients[0].Id);
        return clients[0];
      }
      return null;
    };

    // Try full name first
    let client = await trySearch(name);
    if (client) return client;

    // Try individual name parts (e.g. "Demirtas" alone may find "Umut Demirtas")
    const parts = name.trim().split(/\s+/).filter(p => p.length >= 3);
    for (const part of parts) {
      client = await trySearch(part);
      if (client) return client;
    }

    return null;
  });
}

/**
 * Search for a client by email address.
 * Mindbody's SearchText does NOT reliably index email, so we use multiple
 * fallback strategies to find the client.
 */
async function searchClientByEmail(email) {
  return withRetry(async () => {
    const headers = await authHeaders();

    // Normalize once: trim surrounding whitespace / stray newlines and lower-case.
    // Customers often paste an email across two lines or with a trailing space.
    const target = (email || '').trim().toLowerCase();
    if (!target) return null;
    const emailMatches = (e) => !!e && e.trim().toLowerCase() === target;

    // Helper: fetch full client profile by ID (to get Email field)
    const fetchClientById = async (clientId) => {
      try {
        const r = await api.get('/client/clients', {
          headers,
          params: { ClientIds: [String(clientId)] },
        });
        return (r.data.Clients || [])[0] || null;
      } catch (_) { return null; }
    };

    // Attempt 1: SearchText (occasionally works for email)
    logger.info('Searching Mindbody client by email (SearchText):', target);
    try {
      const res = await api.get('/client/clients', { headers, params: { SearchText: target } });
      const clients = res.data.Clients || [];
      // Prefer an exact email match within the results; fall back to first only
      // if Mindbody returned a single client.
      const exact = clients.find(c => emailMatches(c.Email));
      if (exact) {
        logger.info('Found client by email SearchText (exact):', exact.Id);
        return exact;
      }
      if (clients.length === 1 && !clients[0].Email) {
        const full = await fetchClientById(clients[0].Id);
        if (emailMatches(full?.Email)) {
          logger.info('Found client by email SearchText (single, verified):', clients[0].Id);
          return full;
        }
      }
    } catch (e) {
      logger.warn('Email SearchText failed:', e.message);
    }

    // Attempt 2: Scan appointments (past 30 days + next 60 days).
    // staffappointments does NOT return Client.Email inline, so for each unique
    // client ID we fetch the full profile and compare emails.
    // We scan backwards too because the appointment might be today (already past)
    // or recently booked.
    logger.info('Email SearchText returned nothing — scanning appointments for:', target);
    const scanStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const scanEnd = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    try {
      // PAGINATE: /appointment/staffappointments returns only ~100 rows by
      // default. On a busy site the customer's appointment can fall outside the
      // first page, so we page through up to PAGE_CAP*LIMIT appointments.
      const LIMIT = 200;
      const PAGE_CAP = 10; // up to 2000 appointments scanned
      const seenIds = new Set();
      let fullFetches = 0;
      const MAX_FULL_FETCHES = 60; // bound profile lookups to avoid rate limits

      for (let page = 0; page < PAGE_CAP; page++) {
        const apptRes = await api.get('/appointment/staffappointments', {
          headers,
          params: { StartDate: scanStart, EndDate: scanEnd, Limit: LIMIT, Offset: page * LIMIT },
        });
        const appointments = apptRes.data.Appointments || [];
        logger.info(`Scanning appointments for email ${target}: page ${page + 1}, ${appointments.length} rows`);
        if (appointments.length === 0) break;

        for (const appt of appointments) {
          const cid = appt.Client?.Id;
          if (!cid || seenIds.has(cid)) continue;
          seenIds.add(cid);

          // If email is present in the lightweight record, check it directly
          if (appt.Client.Email) {
            if (emailMatches(appt.Client.Email)) {
              logger.info('Found client via appt scan (inline email), id:', cid);
              return appt.Client;
            }
            continue; // email present but doesn't match — skip full fetch
          }

          // Email not in lightweight record — fetch full profile (bounded)
          if (fullFetches >= MAX_FULL_FETCHES) continue;
          fullFetches++;
          const full = await fetchClientById(cid);
          if (emailMatches(full?.Email)) {
            logger.info('Found client via appt scan (full profile), id:', cid);
            return full;
          }
        }

        // Stop early once Mindbody returns a short (final) page
        const total = apptRes.data.PaginationResponse?.TotalResults;
        if (appointments.length < LIMIT) break;
        if (total != null && (page + 1) * LIMIT >= total) break;
      }
    } catch (scanErr) {
      logger.warn('Appointment scan for email failed:', scanErr.message);
    }

    // Attempt 3: Extract name parts from email local part and search by name,
    // then verify email match. Works for patterns like umut.demirtas@yahoo.com.
    logger.info('Appointment scan found nothing — trying name extraction from email:', target);
    try {
      const localPart = target.split('@')[0];
      // Split on dots, underscores, hyphens, digits
      const parts = localPart.split(/[._\-0-9]+/).filter(p => p.length >= 3);
      // Also try the full local part in case it's one combined word (e.g. mariekekrake)
      const candidates = [...new Set([localPart, ...parts])];
      for (const term of candidates) {
        const r = await api.get('/client/clients', {
          headers,
          params: { SearchText: term },
        });
        const results = r.data.Clients || [];
        logger.info(`Name-from-email search "${term}": ${results.length} result(s)`);
        // Find a result whose email matches
        for (const c of results) {
          if (emailMatches(c.Email)) {
            logger.info('Found client via name extraction, id:', c.Id);
            return c;
          }
          // Email may be missing in list response — fetch full profile
          if (!c.Email) {
            const full = await fetchClientById(c.Id);
            if (emailMatches(full?.Email)) {
              logger.info('Found client via name extraction + full profile, id:', c.Id);
              return full;
            }
          }
        }
      }
    } catch (nameErr) {
      logger.warn('Name-from-email search failed:', nameErr.message);
    }

    logger.info('Client not found by email after all strategies:', target);
    return null;
  });
}

async function getClientByPhone(phoneNumber, email) {
  // Skip phone lookup if no phone provided — go straight to email
  if (!phoneNumber) {
    return email ? searchClientByEmail(email) : null;
  }

  // Collect EVERY profile on this number before choosing. Returning the first
  // hit booked a member under a bare duplicate profile (same number, short
  // name, no pass) — her One Month Pass didn't apply and the team had to
  // cancel and rebook each visit by hand.
  const clients = await getAllClientsByPhone(phoneNumber);
  if (clients.length === 1) {
    logger.info('Found client by phone:', clients[0].Id);
    return clients[0];
  }
  if (clients.length > 1) {
    // Only choose between profiles of the SAME person (a duplicate sign-up).
    // Different people can share a number (a couple, a parent and child):
    // preferring the one with a pass would book someone else under that
    // person's membership. Those keep the old behaviour and go to the team.
    const samePerson = allSamePerson(clients);
    const best = samePerson ? await pickBestClient(clients) : clients[0];
    logger.info(`Phone lookup matched ${clients.length} Mindbody profiles (${samePerson ? 'same person' : 'different people'}) — using client ${best.Id}`);
    notifyDuplicateProfiles(phoneNumber, clients, best, samePerson).catch(err => logger.warn('Duplicate-profile notice failed:', err.message));
    return best;
  }

  // If not found by phone and email provided, use the robust email search
  if (email) {
    logger.info('Not found by phone, trying email search...');
    return searchClientByEmail(email);
  }

  logger.info('Client not found in Mindbody');
  return null;
}

/**
 * Do two Mindbody profiles look like the same person? The first names must be
 * equal, or one must be just the initial of the other ("M" / "Michelle"); AND
 * one surname must be a prefix of the other ("Peri" / "Periquet"). Household
 * members are different people even when they share a surname, a number or an
 * e-mail address — "Maria"/"Mark", and also "Paul"/"Paula" or "Jan"/
 * "Jan-Willem", where one full name is a prefix of the other.
 * Deliberately conservative: when in doubt, they are different people.
 */
function looksLikeSamePerson(a, b) {
  if (a === b || String(a.Id) === String(b.Id)) return true;
  // Every letter of every script counts (Đức must not shrink to "c" and pass
  // as an initial); NFC so a name stored with separate accent marks compares
  // the same as one typed with combined letters.
  const letters = (s) => String(s || '').normalize('NFC').toLowerCase().replace(/[^\p{L}]/gu, '');
  const fa = letters(a.FirstName), fb = letters(b.FirstName);
  const la = letters(a.LastName), lb = letters(b.LastName);
  if (!fa || !fb) return false;
  const initialOf = (short, long) => short.length === 1 && long.startsWith(short);
  if (!(fa === fb || initialOf(fa, fb) || initialOf(fb, fa))) return false;
  if (la.length < 3 || lb.length < 3) return false;
  return la.startsWith(lb) || lb.startsWith(la);
}

/** Every pair must look alike — an initial-only "M Jansen" must not tie Maria and Mark together. */
function allSamePerson(clients) {
  return clients.every((a, i) => clients.every((b, j) => j <= i || looksLikeSamePerson(a, b)));
}

/**
 * Order profiles that share a phone number, best first: an active membership
 * or pass wins (that is where bookings must land for the pass to apply), then
 * an active, non-prospect profile, then the OLDEST profile — the original one,
 * not a duplicate created later. Pure, so it can be tested without Mindbody.
 */
function rankClients(clients, hasPassById = {}) {
  const age = (c) => {
    const t = Date.parse(c.CreationDate || '');
    if (!Number.isNaN(t)) return t;
    const n = Number(c.UniqueId ?? c.Id);
    return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
  };
  const score = (c) =>
    (hasPassById[String(c.Id)] ? 100 : 0) +
    (c.Active === false ? 0 : 10) +
    (c.IsProspect ? 0 : 5);
  return [...clients].sort((a, b) => (score(b) - score(a)) || (age(a) - age(b)));
}

/** Does this profile hold an active membership or pass? Best-effort: unknown → false. */
async function clientHasActivePass(clientId) {
  const headers = await authHeaders();
  const probes = [
    api.get('/client/activeclientmemberships', { headers, params: { ClientId: clientId } })
      .then(r => (r.data?.ClientMemberships || []).length > 0),
    api.get('/client/clientservices', { headers, params: { ClientId: clientId, ShowActiveOnly: true } })
      .then(r => (r.data?.ClientServices || []).some(sv => sv.Current !== false && (sv.Remaining == null || sv.Remaining > 0))),
  ].map(p => p.catch(err => { logger.warn(`Pass lookup for client ${clientId} failed:`, err.response?.status || err.message); return false; }));
  return (await Promise.all(probes)).some(Boolean);
}

async function pickBestClient(clients) {
  const candidates = clients.slice(0, 5); // a phone with more profiles than this is a data problem, not a choice
  const hasPassById = {};
  await Promise.all(candidates.map(async c => {
    hasPassById[String(c.Id)] = await clientHasActivePass(c.Id).catch(() => false);
  }));
  return rankClients(candidates, hasPassById)[0];
}

/**
 * Tell the team once a week per number that it has duplicate profiles, and
 * which one the bot books under — merging them in Mindbody is the real fix.
 * Lazy requires: this module sits below the database and email layers.
 */
async function notifyDuplicateProfiles(phoneNumber, clients, chosen, samePerson) {
  const db = require('../data/database');
  const emailService = require('./email.service');
  if (await db.hasRecentTeamNotification(phoneNumber, 'duplicate_profiles', 7 * 24 * 60)) return;
  const name = (c) => `${c.FirstName || ''} ${c.LastName || ''}`.trim() || 'unnamed';
  const list = clients.map(c => `${name(c)} (ID ${c.Id})`).join('; ');
  const message = samePerson
    ? `This WhatsApp number belongs to ${clients.length} Mindbody profiles that look like the same person: ${list}. The bot now books under ${name(chosen)} (ID ${chosen.Id}) — the one with an active membership/pass, or else the oldest. Please merge the duplicates in Mindbody so passes, history and bookings live on one profile.`
    : `This WhatsApp number is on ${clients.length} Mindbody profiles of what look like different people: ${list}. The bot books under ${name(chosen)} (ID ${chosen.Id}), the first match. If that is wrong, please give each person their own number in Mindbody.`;
  await db.logEscalation(phoneNumber, name(chosen), 'duplicate_profiles', message);
  await emailService.sendEscalationEmail({
    customerName: name(chosen),
    customerPhone: phone.toWhatsAppFormat(phoneNumber),
    customerEmail: null,
    message: `🧩 SHARED / DUPLICATE MINDBODY PROFILES — ${message}`,
  });
}

async function getAllClientsByPhone(phoneNumber) {
  return withRetry(async () => {
    const headers = await authHeaders();
    // M15: use shared helper — consistent with getClientByPhone
    const phoneVariants = buildPhoneVariants(phoneNumber);

    const allClients = [];
    const seenIds = new Set();
    for (const variant of phoneVariants) {
      const res = await api.get('/client/clients', {
        headers,
        params: { SearchText: variant },
      });
      for (const c of (res.data.Clients || [])) {
        if (!seenIds.has(c.Id)) {
          seenIds.add(c.Id);
          allClients.push(c);
        }
      }
    }
    logger.info('Found', allClients.length, 'client(s) for phone', phoneNumber);
    return allClients;
  });
}

async function addClient({ firstName, lastName, email, mobilePhone, city }) {
  return withRetry(async () => {
    const headers = await authHeaders();
    const body = {
      FirstName: firstName,
      LastName: lastName || '',
      Email: email,
      MobilePhone: phone.normalize(mobilePhone),
      City: city || 'Amsterdam',
      State: 'NH',
      Country: 'NL',
      Gender: 'None',
    };
    // M3: don't log PII (name, email, phone) — log only that a client is being created
    logger.info('Mindbody addClient request: creating new client');
    try {
      const res = await api.post('/client/addclient', body, { headers });
      return res.data.Client;
    } catch (err) {
      logger.error('Mindbody addClient error:', JSON.stringify({
        status: err.response?.status,
        data: err.response?.data,
      }));
      throw err;
    }
  });
}

// ---- Staff ----

async function getStaff() {
  return withRetry(async () => {
    const headers = await authHeaders();
    const res = await api.get('/staff/staff', { headers });
    return res.data.StaffMembers || [];
  });
}

async function getResources() {
  return withRetry(async () => {
    const headers = await authHeaders();
    const res = await api.get('/site/resources', { headers, params: { LocationId: 1 } });
    return res.data;
  });
}

async function getActiveTimes() {
  return withRetry(async () => {
    const headers = await authHeaders();
    const res = await api.get('/site/activetimes', {
      headers,
      params: { ScheduleType: 'Appointment' },
    });
    return res.data;
  });
}

// ---- Group Classes ----

/**
 * Get upcoming group class instances for given session type IDs.
 */
async function getClasses(sessionTypeIds, startDate, endDate) {
  return withRetry(async () => {
    const headers = await authHeaders();
    logger.debug(`Mindbody getClasses: sessionTypes=${sessionTypeIds}, ${startDate} → ${endDate}`);
    const res = await api.get('/class/classes', {
      headers,
      params: {
        SessionTypeIds: sessionTypeIds,
        LocationIds: [1],
        StartDateTime: startDate,
        EndDateTime: endDate,
        HideNotAvailableForBooking: true,
      },
    });
    const classes = res.data.Classes || [];
    logger.debug(`Mindbody getClasses: ${classes.length} classes found`);
    return classes;
  });
}

/**
 * Add a client to a group class (enrol).
 */
/**
 * Was this cancellation error a benign "already gone", or a real failure?
 *
 * The old callers substring-matched ('cancel'|'already'|'status'|'not found'),
 * which classified an axios "Request failed with status code 500" — and even
 * cancelAppointment's own deliberate "Cancellation did not take effect" hard
 * failure — as benign, so genuine release failures were swallowed at INFO
 * level and rows were marked expired while their appointments lived on
 * (round-4 verify finding). Benign now means an explicit already-gone signal
 * and nothing else.
 */
function isBenignCancelError(err) {
  const raw = String(err?.response?.data?.Error?.Message || err?.message || '').toLowerCase();
  if (raw.includes('did not take effect')) return false; // our own hard failure — never benign
  if (/status code \d/.test(raw)) return false;          // raw HTTP failure text
  return /already/.test(raw) || /not ?found/.test(raw) || /does not exist/.test(raw);
}

/**
 * Remove a client from a class — the class-side counterpart of
 * cancelAppointment. Unpaid CLASS bookings could never be auto-released
 * before: the expiry paths fed the class id to the appointment API.
 */
async function removeClientFromClass(clientId, classId) {
  return withRetry(async () => {
    const headers = await authHeaders();
    const body = { ClientId: String(clientId), ClassId: parseInt(classId, 10), SendEmail: false };
    logger.info('Mindbody removeClientFromClass:', JSON.stringify(body));
    try {
      const res = await api.post('/class/removeclientfromclass', body, { headers });
      logger.info('removeClientFromClass success');
      return res.data;
    } catch (err) {
      logger.error('removeClientFromClass error:', JSON.stringify({
        status: err.response?.status,
        data: err.response?.data,
      }));
      throw err;
    }
  });
}

async function addClientToClass(clientId, classId) {
  return withRetry(async () => {
    const headers = await authHeaders();
    const body = {
      ClientId: String(clientId),
      ClassId: classId,
      SendEmail: false,
    };
    logger.info('Mindbody addClientToClass:', JSON.stringify(body));
    try {
      const res = await api.post('/class/addclienttoclass', body, { headers });
      logger.info('addClientToClass success');
      return res.data.ClassVisit || res.data;
    } catch (err) {
      logger.error('addClientToClass error:', JSON.stringify({
        status: err.response?.status,
        data: err.response?.data,
      }));
      throw err;
    }
  });
}

module.exports = {
  RESOURCE_MAP,
  getServices,
  findClientAppointmentAt,
  getRoomOccupancy,
  invalidateRoomOccupancy,
  isStaffRejection,
  isRoomRejection,
  getBookableItems,
  fetchAllPages,
  addAppointment,
  cancelAppointment,
  isBenignCancelError,
  isCancelEffectiveStatus,
  rankClients,
  looksLikeSamePerson,
  allSamePerson,
  findAvailableStaffForTime,
  removeClientFromClass,
  updateAppointmentNotes,
  getStaffAppointments,
  getUpcomingAppointments,
  getClientByPhone,
  getAllClientsByPhone,
  searchClientByName,
  searchClientByEmail,
  addClient,
  getStaff,
  getActiveTimes,
  getResources,
  getClasses,
  addClientToClass,
};
