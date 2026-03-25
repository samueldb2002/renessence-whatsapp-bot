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
  80: [5],                     // Hydrowave → Well-being Studio
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

async function addAppointment({ clientId, locationId, sessionTypeId, staffId, startDateTime }) {
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
          // If it's a resource availability issue, try next resource
          if (errMsg.includes('resource') || errMsg.includes('Resource')) {
            continue;
          }
          // For other errors, don't try more resources
          throw err;
        }
      }
      // All resources failed
      logger.error('All resources failed for session type ' + sessionTypeId);
      throw lastError;
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

async function getClientByPhone(phoneNumber, email) {
  return withRetry(async () => {
    const headers = await authHeaders();
    const normalized = phone.normalize(phoneNumber);

    // Try multiple phone formats since Mindbody may store differently
    const phoneVariants = [
      normalized,                           // +31655505545
      normalized.replace('+', ''),          // 31655505545
      '0' + normalized.replace(/^\+\d{2}/, ''), // 0655505545
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

    // If not found by phone and email provided, search by email
    if (email) {
      logger.info('Not found by phone, searching by email:', email);
      const res2 = await api.get('/client/clients', {
        headers,
        params: { SearchText: email },
      });
      const clients2 = res2.data.Clients || [];
      if (clients2.length > 0) {
        logger.info('Found client by email:', clients2[0].Id);
        return clients2[0];
      }
    }

    logger.info('Client not found in Mindbody');
    return null;
  });
}

async function getAllClientsByPhone(phoneNumber) {
  return withRetry(async () => {
    const headers = await authHeaders();
    const normalized = phone.normalize(phoneNumber);
    const phoneVariants = [
      normalized,
      normalized.replace('+', ''),
      '0' + normalized.replace(/^\+\d{2}/, ''),
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

module.exports = {
  getServices,
  getBookableItems,
  addAppointment,
  cancelAppointment,
  getStaffAppointments,
  getUpcomingAppointments,
  getClientByPhone,
  getAllClientsByPhone,
  addClient,
  getStaff,
};
