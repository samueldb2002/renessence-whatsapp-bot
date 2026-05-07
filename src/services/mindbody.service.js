const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');
const phone = require('../utils/phone');

const BASE_URL = 'https://api.mindbodyonline.com/public/v6';

let userToken = null;
let tokenExpiry = null;

// Axios instance with default headers
const api = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Content-Type': 'application/json',
    'Api-Key': config.MINDBODY_API_KEY,
    SiteId: config.MINDBODY_SITE_ID,
  },
});

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

// Retry wrapper for 401 errors (expired token)
async function withRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.response?.status === 401) {
      logger.warn('Mindbody token expired, refreshing...');
      userToken = null;
      tokenExpiry = null;
      return await fn();
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

async function getBookableItems(sessionTypeId, startDate, endDate) {
  return withRetry(async () => {
    const headers = await authHeaders();
    logger.debug(`Mindbody bookableItems request: sessionType=${sessionTypeId}, start=${startDate}, end=${endDate}`);
    const res = await api.get('/appointment/bookableitems', {
      headers,
      params: {
        SessionTypeIds: [sessionTypeId],
        LocationId: 1,
        StartDate: startDate,
        EndDate: endDate,
      },
    });
    const items = res.data.Availabilities || res.data.AvailableItems || [];
    logger.debug(`Mindbody bookableItems response: ${items.length} items found`);
    return items;
  });
}

// ---- Appointments ----

// Resource mapping: session type ID -> possible resource IDs (in order of preference)
const RESOURCE_MAP = {
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
};

async function addAppointment({ clientId, locationId, sessionTypeId, staffId, startDateTime, notes }) {
  return withRetry(async () => {
    const headers = await authHeaders();

    // If no valid staffId, find an available staff member for this session type
    let resolvedStaffId = staffId;
    if (!resolvedStaffId || resolvedStaffId === 0) {
      logger.info('No staffId provided, looking up available staff...');
      try {
        const staffRes = await api.get('/staff/staff', {
          headers,
          params: { SessionTypeId: sessionTypeId },
        });
        const staffMembers = staffRes.data.StaffMembers || [];
        if (staffMembers.length > 0) {
          resolvedStaffId = staffMembers[0].Id;
          logger.info(`Using staff: ${staffMembers[0].Name} (ID: ${resolvedStaffId})`);
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

    // Get possible resources for this session type
    const possibleResources = RESOURCE_MAP[sessionTypeId] || [];

    // Try booking with each resource until one works
    if (possibleResources.length > 0) {
      let lastError = null;
      for (const resourceId of possibleResources) {
        const body = {
          ClientId: String(clientId),
          LocationId: locationId || 1,
          SessionTypeId: sessionTypeId,
          StaffId: resolvedStaffId,
          StartDateTime: startDateTime,
          ResourceIds: [resourceId],
          ApplyPayment: false,
          SendEmail: false,
          ...(notes ? { Notes: notes } : {}),
        };
        logger.info('Mindbody addAppointment request (resource ' + resourceId + '):', JSON.stringify(body));
        try {
          const res = await api.post('/appointment/addappointment', body, { headers });
          logger.info('Mindbody addAppointment success with resource ' + resourceId);
          return res.data.Appointment;
        } catch (err) {
          const errMsg = err.response?.data?.Error?.Message || err.message;
          logger.warn('Resource ' + resourceId + ' failed: ' + errMsg);
          lastError = err;
          // If it's a resource issue, try next resource
          const errCode = err.response?.data?.Error?.Code || '';
          if (errMsg.toLowerCase().includes('resource') || errCode === 'InvalidResource') {
            continue;
          }
          // For other errors, don't try more resources
          throw err;
        }
      }
      // All resources failed — fall back to booking without a resource
      logger.warn('All resources failed for session type ' + sessionTypeId + ', retrying without resource...');
    }

    // No resource mapping — try without ResourceIds
    const body = {
      ClientId: String(clientId),
      LocationId: locationId || 1,
      SessionTypeId: sessionTypeId,
      StaffId: resolvedStaffId,
      StartDateTime: startDateTime,
      ApplyPayment: false,
      SendEmail: false,
      ...(notes ? { Notes: notes } : {}),
    };
    logger.info('Mindbody addAppointment request (no resource):', JSON.stringify(body));
    try {
      const res = await api.post('/appointment/addappointment', body, { headers });
      logger.info('Mindbody addAppointment success:', JSON.stringify(res.data));
      return res.data.Appointment;
    } catch (err) {
      logger.error('Mindbody addAppointment FULL error response:', JSON.stringify({
        status: err.response?.status,
        statusText: err.response?.statusText,
        data: err.response?.data,
      }));
      throw err;
    }
  });
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
      logger.info('Appointment cancelled, status:', status);
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
    logger.info('Searching Mindbody client by email (SearchText):', email);
    try {
      const res = await api.get('/client/clients', { headers, params: { SearchText: email } });
      const clients = res.data.Clients || [];
      if (clients.length > 0) {
        logger.info('Found client by email SearchText:', clients[0].Id);
        return clients[0];
      }
    } catch (e) {
      logger.warn('Email SearchText failed:', e.message);
    }

    // Attempt 2: Scan upcoming appointments.
    // staffappointments does NOT return Client.Email, so for each candidate we
    // fetch the full client profile and compare emails.
    logger.info('Email SearchText returned nothing — scanning upcoming appointments for:', email);
    const today = new Date().toISOString().split('T')[0];
    const future = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    try {
      const apptRes = await api.get('/appointment/staffappointments', {
        headers,
        params: { StartDate: today, EndDate: future },
      });
      const appointments = apptRes.data.Appointments || [];
      logger.info(`Scanning ${appointments.length} appointments for email ${email}`);

      // Collect unique client IDs from appointments
      const seenIds = new Set();
      for (const appt of appointments) {
        const cid = appt.Client?.Id;
        if (!cid || seenIds.has(cid)) continue;
        seenIds.add(cid);

        // If email is present in the lightweight record, check it directly
        if (appt.Client.Email) {
          if (appt.Client.Email.toLowerCase() === email.toLowerCase()) {
            logger.info('Found client via appt scan (inline email), id:', cid);
            return appt.Client;
          }
          continue; // email present but doesn't match — skip full fetch
        }

        // Email not in lightweight record — fetch full profile
        const full = await fetchClientById(cid);
        if (full?.Email?.toLowerCase() === email.toLowerCase()) {
          logger.info('Found client via appt scan (full profile), id:', cid);
          return full;
        }
      }
    } catch (scanErr) {
      logger.warn('Appointment scan for email failed:', scanErr.message);
    }

    // Attempt 3: Extract name parts from email local part and search by name,
    // then verify email match. Works for patterns like umut.demirtas@yahoo.com.
    logger.info('Appointment scan found nothing — trying name extraction from email:', email);
    try {
      const localPart = email.split('@')[0];
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
          if (c.Email?.toLowerCase() === email.toLowerCase()) {
            logger.info('Found client via name extraction, id:', c.Id);
            return c;
          }
          // Email may be missing in list response — fetch full profile
          if (!c.Email) {
            const full = await fetchClientById(c.Id);
            if (full?.Email?.toLowerCase() === email.toLowerCase()) {
              logger.info('Found client via name extraction + full profile, id:', c.Id);
              return full;
            }
          }
        }
      }
    } catch (nameErr) {
      logger.warn('Name-from-email search failed:', nameErr.message);
    }

    logger.info('Client not found by email after all strategies:', email);
    return null;
  });
}

async function getClientByPhone(phoneNumber, email) {
  return withRetry(async () => {
    const headers = await authHeaders();

    // Skip phone lookup if no phone provided — go straight to email
    if (!phoneNumber) {
      if (email) {
        return searchClientByEmail(email);
      }
      return null;
    }

    const normalized = phone.normalize(phoneNumber);
    const bare = normalized.replace(/^\+\d{2}/, '').replace(/^0/, '');

    // Try multiple phone formats since Mindbody may store differently
    const phoneVariants = [
      normalized,                                  // +31655505545
      normalized.replace('+', ''),                 // 31655505545
      '0' + normalized.replace(/^\+\d{2}/, ''),    // 0655505545
      bare,                                        // 655505545  ← stored without any prefix
    ];

    for (const variant of phoneVariants) {
      logger.info('Searching Mindbody client by phone:', variant);
      const res = await api.get('/client/clients', {
        headers,
        params: { SearchText: variant },
      });
      const clients = res.data.Clients || [];
      if (clients.length > 0) {
        logger.info('Found client by phone:', clients[0].Id);
        return clients[0];
      }
    }

    // If not found by phone and email provided, use the robust email search
    if (email) {
      logger.info('Not found by phone, trying email search...');
      return searchClientByEmail(email);
    }

    logger.info('Client not found in Mindbody');
    return null;
  });
}

async function getAllClientsByPhone(phoneNumber) {
  return withRetry(async () => {
    const headers = await authHeaders();
    const normalized = phone.normalize(phoneNumber);
    // Mindbody stores numbers in many formats — cover all common variants:
    // +31631789654 | 31631789654 | 0631789654 | 631789654
    const bare = normalized.replace(/^\+\d{2}/, '').replace(/^0/, ''); // digits only, no prefix
    const phoneVariants = [
      normalized,                                    // +31631789654
      normalized.replace('+', ''),                   // 31631789654
      '0' + normalized.replace(/^\+\d{2}/, ''),      // 0631789654
      bare,                                          // 631789654  ← Mindbody sometimes stores without any prefix
    ];

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
    logger.info('Mindbody addClient request:', JSON.stringify(body));
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
  getServices,
  getBookableItems,
  addAppointment,
  cancelAppointment,
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
