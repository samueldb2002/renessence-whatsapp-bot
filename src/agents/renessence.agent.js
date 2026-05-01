/**
 * Renessence AI Agent
 * Uses OpenAI function calling to handle the entire conversation.
 * The AI decides what to do, which tools to call, and generates all responses.
 */

const OpenAI = require('openai');
const config = require('../config');
const conversationService = require('../services/conversation.service');
const mindbodyService = require('../services/mindbody.service');
const paymentService = require('../services/payment.service');
const whatsappService = require('../services/whatsapp.service');
const emailService = require('../services/email.service');
const db = require('../data/database');
const logger = require('../utils/logger');
const { formatDutchDate, formatDutchTime, formatDateISO, addDays } = require('../utils/date');
const { SERVICE_SLOT_TIMES } = require('../config/slot-times');
const dynamicCatalogService = require('../services/dynamic-catalog.service');

// Static catalog (synchronous — loaded at startup)
const _catalog = dynamicCatalogService.getCatalog();

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

// ---- Tool definitions ----

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'check_availability',
      description: 'Check available booking slots for a treatment. Call this when the user wants to book and has indicated a date or time preference.',
      parameters: {
        type: 'object',
        properties: {
          session_type_ids: {
            type: 'array',
            items: { type: 'integer' },
            description: 'Mindbody session type ID(s) for the treatment. Use all IDs for that treatment from the service catalog.',
          },
          start_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
          end_date: { type: 'string', description: 'End date YYYY-MM-DD. Same as start_date for a single day.' },
        },
        required: ['session_type_ids', 'start_date', 'end_date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lookup_client',
      description: 'Check if this customer already has an account in Mindbody (by phone number). Call this before asking for name/email.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'book_appointment',
      description: 'Book an appointment after the customer has confirmed. Requires session type, datetime, and client details.',
      parameters: {
        type: 'object',
        properties: {
          session_type_id: { type: 'integer', description: 'Mindbody session type ID' },
          start_date_time: { type: 'string', description: 'ISO 8601 datetime, e.g. 2026-05-01T09:00:00' },
          staff_id: { type: 'integer', description: 'Staff ID from the slot (0 if unknown)' },
          client_name: { type: 'string', description: 'Full name. Only needed for new customers.' },
          client_email: { type: 'string', description: 'Email address. Only needed for new customers.' },
        },
        required: ['session_type_id', 'start_date_time'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_appointments',
      description: "Get the customer's upcoming appointments from Mindbody.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_appointments',
      description: 'Cancel one or more appointments.',
      parameters: {
        type: 'object',
        properties: {
          appointment_ids: {
            type: 'array',
            items: { type: 'integer' },
            description: 'List of appointment IDs to cancel.',
          },
        },
        required: ['appointment_ids'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_class_schedule',
      description: 'Get upcoming group class sessions (Vinyasa Flow, Pilates, etc.). Use this instead of check_availability when the customer wants to book a studio class.',
      parameters: {
        type: 'object',
        properties: {
          session_type_ids: {
            type: 'array',
            items: { type: 'integer' },
            description: 'Session type IDs for the class (e.g. [83] for Studio Classes).',
          },
          start_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
          end_date: { type: 'string', description: 'End date YYYY-MM-DD' },
        },
        required: ['session_type_ids', 'start_date', 'end_date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'book_class',
      description: 'Enrol a customer into a group class. Use this instead of book_appointment for studio classes.',
      parameters: {
        type: 'object',
        properties: {
          class_id: { type: 'integer', description: 'Mindbody ClassId from check_class_schedule result.' },
          session_type_id: { type: 'integer', description: 'Session type ID (e.g. 83).' },
          class_name: { type: 'string', description: 'Human-readable class name (e.g. "Vinyasa Flow").' },
          class_date_time: { type: 'string', description: 'ISO datetime of the class, e.g. 2026-05-01T09:00:00.' },
          client_name: { type: 'string', description: 'Full name. Only needed for new customers.' },
          client_email: { type: 'string', description: 'Email. Only needed for new customers.' },
        },
        required: ['class_id', 'session_type_id', 'class_name', 'class_date_time'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_human_handoff',
      description: 'Escalate to a human team member when the customer needs help the bot cannot provide.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why the customer needs human help.' },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'respond',
      description: 'Send the final response to the customer. ALWAYS call this to end your turn — never output plain text.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'The message text to send.' },
          ui_type: {
            type: 'string',
            enum: ['none', 'buttons', 'list', 'cta_button'],
            description: 'Type of interactive WhatsApp element to attach.',
          },
          buttons: {
            type: 'array',
            description: 'For ui_type "buttons". Max 3. Title max 20 chars.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
              },
            },
          },
          list_button_label: { type: 'string', description: 'For ui_type "list". The button label (e.g. "View times").' },
          list_sections: {
            type: 'array',
            description: 'For ui_type "list". Max 10 rows total. Row title max 24 chars, description max 72 chars.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                rows: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      title: { type: 'string' },
                      description: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
          cta_label: { type: 'string', description: 'For ui_type "cta_button". Button label.' },
          cta_url: { type: 'string', description: 'For ui_type "cta_button". The URL.' },
          detected_language: {
            type: 'string',
            enum: ['en', 'nl'],
            description: 'The language of this conversation.',
          },
        },
        required: ['message', 'ui_type'],
      },
    },
  },
];

// ---- System prompt ----

function buildSystemPrompt(from, name) {
  const today = new Date().toISOString().split('T')[0];
  const tomorrow = formatDateISO(addDays(new Date(), 1));
  const nextWeekStart = formatDateISO(addDays(new Date(), (8 - new Date().getDay()) % 7 || 7));

  let knowledgeBase = {};
  try { knowledgeBase = require('../data/knowledge-base.json'); } catch {}

  const catalogText = dynamicCatalogService.buildSystemPromptText(_catalog);

  // Build category button list from catalog categories
  const categories = dynamicCatalogService.getCategories(_catalog);
  const categoryButtons = categories.map(cat => {
    const id = cat === 'Tech Treatments' ? 'cat_tech' : cat === 'Massages' ? 'cat_massages' : `cat_${cat.toLowerCase().replace(/\s+/g, '_')}`;
    return `{"id":"${id}","title":"${cat.substring(0, 20)}"}`;
  }).join(', ');

  return `You are the WhatsApp assistant for Renessence, a premium wellness centre in Amsterdam.

Customer: ${name || 'Unknown'} | Phone: ${from}
Today: ${today} | Tomorrow: ${tomorrow} | Next Monday: ${nextWeekStart}

## CRITICAL
You MUST always end your turn by calling the \`respond\` tool. Never output plain text without it.

## Language
- Default: English
- If the customer writes Dutch → respond in Dutch for the rest of the conversation
- Always set detected_language in the respond call

## Style
- Warm, professional, concise — this is WhatsApp, not email
- Maximum 2-3 sentences per message
- Don't use emojis unless the customer does

## First message / greeting
When someone greets you or sends a first message without a clear intent, respond with a short warm welcome as plain text (ui_type: "none"). NO buttons. Just say hello and ask how you can help.
Example: "Hello [name]! Welcome to Renessence 🌿 How can I help you today?"

Only show interactive buttons/lists when the user has a specific intent.

## Booking flow
1. If the treatment is NOT specified, show the category buttons (NEVER ask in plain text):
   respond({ "message": "Which type of treatment are you looking for?", "ui_type": "buttons", "buttons": [${categoryButtons}] })

2. If a category is selected, show that category's services as a list.
   Use the parent group entries from the **Service Catalog** below — one row per group:
   - Row id: the group id (e.g. svc_58, svc_finn, svc_ir)
   - Row title: group display name (max 24 chars)
   - Row description: group description (max 72 chars)
   Example:
   respond({ "message": "Choose a treatment:", "ui_type": "list", "list_button_label": "View treatments",
     "list_sections": [{"title": "Tech Treatments", "rows": [{"id":"svc_58","title":"Float Journey","description":"€80 · 60 min float tank"},{"id":"svc_finn","title":"Finnish Sauna","description":"€80–90 · 60 min"}, ...]}] })

3. When a parent group is selected (user message contains "[subOptions]" or the group has subOptions in the catalog):
   Show the sub-options as buttons so the customer picks the exact variant:
   respond({ "message": "Finnish Sauna — how many people?", "ui_type": "buttons",
     "buttons": [{"id":"svc_87","title":"1 persoon – €80"},{"id":"svc_69","title":"2 personen – €80"},{"id":"svc_66","title":"3 personen – €90"}] })
   Use the exact id and label from the subOptions in the catalog.
   If the group has NO subOptions → skip this step and proceed directly to step 4.

4. When the final variant is chosen (user message contains "sessionTypeIds="), ask for preferred date:
   respond({ "message": "When would you like [treatment]?", "ui_type": "buttons",
     "buttons": [{"id":"date_today","title":"Today"},{"id":"date_tomorrow","title":"Tomorrow"},{"id":"date_week","title":"This week"}] })

5. Call check_availability with the correct session_type_ids and date range
6. Show available slots as a list (see STRICT RULE below)
7. When customer selects a slot, call lookup_client
8. If known: show confirmation summary with their name and Confirm/Cancel buttons
9. If new: ask for full name and email, then show confirmation with Confirm/Cancel buttons
10. When confirmed: call book_appointment
11. If requiresPayment: respond with cta_button (payment link)

When the user selects a date button (id="date_today", "date_tomorrow", "date_week"), interpret it and call check_availability with the appropriate dates.
When the user selects a sub-option (message contains "sessionTypeIds="), use those IDs for check_availability.

## Cancellation flow
1. Call get_appointments to see what's scheduled
2. If multiple appointments, ask which to cancel (show list or buttons)
3. Late cancellation warning: ONLY warn about the 100% charge if isWithin24h = true AND isPaid = true.
   If isPaid = false (customer hasn't paid yet), they can always cancel for free — no warning needed.
4. Call cancel_appointments with the appointment ID(s)
5. Confirm cancellation

## WhatsApp UI rules
- Buttons: max 3, title max 20 chars each — use for yes/no and main menu
- List: max 10 rows per section, title max 24 chars, description max 72 chars — use for time slots and service choices
- CTA button: payment links only

## Therapist selection (massages & treatments only)
After calling check_availability for a massage or treatment, the result includes a "staff" array listing available therapists.
- If staff has 2+ members: ask the customer if they have a preference BEFORE showing time slots:
  respond({ "message": "Do you have a preference for a therapist?", "ui_type": "buttons",
    "buttons": [{"id":"staff_5","title":"Lisa"},{"id":"staff_any","title":"First Available"},{"id":"staff_7","title":"Emma"}] })
  Place "First Available" (id: "staff_any") in the MIDDLE between the therapist buttons.
  Use the actual names and IDs from the staff array. Button id format: "staff_{id}" or "staff_any".
- If staff_any / First Available: show all slots (include therapist name in description)
- If a specific therapist is chosen: only show that therapist's slots
- For tech treatments (sauna, float, oxygen etc.): skip this step — no therapist needed

## STRICT RULE: showing time slots
NEVER put time slots in the message text. ALWAYS use ui_type "list" with list_sections.

After calling check_availability, you get back a "slots" array like:
[
  { "id": "slot_2026-05-01T09:00:00_5_31", "timeLabel": "09:00", "dateLabel": "1 mei", "serviceName": "Tailored Massage", "staffName": "Lisa" },
  { "id": "slot_2026-05-01T10:00:00_7_31", "timeLabel": "10:00", "dateLabel": "1 mei", "serviceName": "Tailored Massage", "staffName": "Emma" }
]

For slots WITH a therapist (massages/treatments): include staffName in the description.
For slots WITHOUT a therapist (tech treatments): just use dateLabel.

You MUST call respond like this:
{
  "message": "Here are the available times for Tailored Massage on 1 mei:",
  "ui_type": "list",
  "list_button_label": "View times",
  "list_sections": [
    {
      "title": "Available",
      "rows": [
        { "id": "slot_2026-05-01T09:00:00_5_31", "title": "09:00", "description": "1 mei · Lisa" },
        { "id": "slot_2026-05-01T10:00:00_7_31", "title": "10:00", "description": "1 mei · Emma" }
      ]
    }
  ],
  "detected_language": "en"
}

If check_availability returns no slots, respond with ui_type "none" and offer alternative dates.

## Studio Class booking flow
Studio Classes (svc_83, sessionTypeId 83) are GROUP classes — use this different flow:
1. Ask for preferred week using date buttons (same as appointment flow)
2. Call check_class_schedule (NOT check_availability) with session_type_ids=[83] and the date range
3. Show the returned classes as a list:
   - Row id: "class_{classId}" (e.g. class_456)
   - Row title: class name (e.g. "Vinyasa Flow") — max 24 chars
   - Row description: "dateLabel · timeLabel · X spots left" — max 72 chars
4. When customer selects a class (id starts with "class_"), call lookup_client
5. Show confirmation with class name, date, time and Confirm/Cancel buttons
6. When confirmed: call book_class (NOT book_appointment)
7. Send payment link (€22) via cta_button

## Special redirects (always redirect, never book via bot)
- Memberships / credits / strippenkaart → book via https://renessence.com
- Gift cards / cadeaubonnen → redeem at https://renessence.com
- Double massage / duo massage / koppelmassage → https://form.jotform.com/Renessence/double-massage-form-request
- Creative Space / vergaderruimte → https://form.jotform.com/Renessence/creative-business-space-booking

## Service catalog
${catalogText}

## Knowledge base
${JSON.stringify(knowledgeBase)}`;
}

// ---- Tool implementations ----

function getServiceName(sessionTypeId) {
  return dynamicCatalogService.getServiceName(sessionTypeId);
}

async function toolCheckAvailability(from, { session_type_ids, start_date, end_date }) {
  let allItems = [];
  for (const id of session_type_ids) {
    try {
      const items = await mindbodyService.getBookableItems(id, start_date, end_date);
      allItems = allItems.concat(items);
    } catch (err) {
      logger.warn(`check_availability failed for id ${id}:`, err.message);
    }
  }

  if (allItems.length === 0) return { slots: [], staff: [] };

  const now = new Date();
  const slots = [];
  const staffMap = {};

  for (const item of allItems) {
    const windowStart = new Date(item.StartDateTime);
    // BookableEndDateTime = last valid START time (Mindbody already subtracts session duration)
    // So we compare slotTime <= windowEnd, NOT slotEnd <= windowEnd
    const windowEnd = new Date(item.BookableEndDateTime || item.EndDateTime);
    const staffId = item.Staff?.Id || 0;
    const staffName = item.Staff?.Name || null;
    const sessionTypeId = item.SessionType?.Id || 0;
    const windowDateStr = item.StartDateTime.split('T')[0];
    const validTimes = SERVICE_SLOT_TIMES[sessionTypeId];

    if (staffId && staffName) staffMap[staffId] = staffName;

    if (validTimes) {
      for (const timeStr of validTimes) {
        const slotTime = new Date(`${windowDateStr}T${timeStr}:00`);
        // Fix: slotTime must be within the bookable window (not slotEnd)
        if (slotTime > now && slotTime >= windowStart && slotTime <= windowEnd) {
          const dateTime = `${windowDateStr}T${timeStr}:00`;
          slots.push({
            id: `slot_${dateTime}_${staffId}_${sessionTypeId}`,
            dateTime,
            dateLabel: formatDutchDate(dateTime),
            timeLabel: timeStr,
            staffId,
            staffName,
            sessionTypeId,
            serviceName: getServiceName(sessionTypeId),
          });
        }
      }
    } else {
      // Fallback: every 60 min rounded to half hour
      let t = new Date(windowStart);
      const m = t.getMinutes();
      if (m > 0 && m <= 30) t.setMinutes(30, 0, 0);
      else if (m > 30) t.setHours(t.getHours() + 1, 0, 0, 0);

      while (t <= windowEnd) {
        if (t > now) {
          const pad = n => String(n).padStart(2, '0');
          const dateTime = `${t.getFullYear()}-${pad(t.getMonth()+1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}:00`;
          slots.push({
            id: `slot_${dateTime}_${staffId}_${sessionTypeId}`,
            dateTime,
            dateLabel: formatDutchDate(dateTime),
            timeLabel: `${pad(t.getHours())}:${pad(t.getMinutes())}`,
            staffId,
            staffName,
            sessionTypeId,
            serviceName: getServiceName(sessionTypeId),
          });
        }
        t = new Date(t.getTime() + 60 * 60000);
      }
    }
  }

  // Deduplicate by dateTime + staffId + sessionTypeId
  const seen = new Set();
  const unique = slots.filter(s => {
    const key = `${s.dateTime}_${s.staffId}_${s.sessionTypeId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => a.dateTime.localeCompare(b.dateTime));

  // Unique staff available
  const staff = Object.entries(staffMap).map(([id, name]) => ({ id: Number(id), name }));

  return { slots: unique.slice(0, 10), staff };
}

async function toolLookupClient(from) {
  try {
    const client = await mindbodyService.getClientByPhone(from, null);
    if (client) {
      return {
        found: true,
        name: `${client.FirstName} ${client.LastName}`.trim(),
        email: client.Email || null,
        clientId: String(client.Id),
      };
    }
    return { found: false };
  } catch (err) {
    logger.warn('lookup_client error:', err.message);
    return { found: false };
  }
}

async function toolBookAppointment(from, { session_type_id, start_date_time, staff_id, client_name, client_email }) {
  // 1. Find or create client
  let client = await mindbodyService.getClientByPhone(from, client_email || null);
  if (!client) {
    if (!client_name || !client_email) {
      return { error: 'client_info_required', message: 'Need full name and email to create account.' };
    }
    const parts = client_name.trim().split(' ');
    const firstName = parts[0];
    const lastName = parts.slice(1).join(' ') || 'WhatsApp';
    try {
      client = await mindbodyService.addClient({ firstName, lastName, email: client_email, mobilePhone: from, city: 'Amsterdam' });
    } catch (addErr) {
      if (addErr.response?.data?.Error?.Code === 'InvalidClientCreation') {
        client = await mindbodyService.getClientByPhone(from, client_email);
        if (!client) throw addErr;
      } else throw addErr;
    }
  }

  // 2. Book appointment
  const appointment = await mindbodyService.addAppointment({
    clientId: client.Id,
    sessionTypeId: session_type_id,
    staffId: staff_id || 0,
    startDateTime: start_date_time,
  });

  const serviceName = getServiceName(session_type_id);
  const dateLabel = formatDutchDate(start_date_time);
  const timeLabel = formatDutchTime(start_date_time);
  const lang = conversationService.get(from)?.lang || 'en';
  const atWord = lang === 'nl' ? 'om' : 'at';
  const dateTimeLabel = `${dateLabel} ${atWord} ${timeLabel}`;

  // 3. Log to DB
  const bookingEventId = await db.logBookingEvent({
    phone: from,
    customerName: client_name || `${client.FirstName} ${client.LastName}`.trim(),
    sessionTypeId: session_type_id,
    serviceName,
    status: 'confirmed',
    amountCents: paymentService.getPriceInCents(session_type_id),
  });
  if (bookingEventId) {
    await db.updateBookingEvent(bookingEventId, {
      appointmentDate: start_date_time,
      mindbodyAppointmentId: appointment.Id,
    });
  }

  // 4. Payment link if required
  const priceCents = paymentService.getPriceInCents(session_type_id);
  if (priceCents) {
    try {
      const payment = await paymentService.createPaymentLink({
        appointmentId: appointment.Id,
        clientId: client.Id,
        from,
        serviceName,
        dateTime: dateTimeLabel,
        amount: priceCents,
        customerEmail: client.Email || client_email,
        customerName: client_name || `${client.FirstName} ${client.LastName}`.trim(),
      });
      if (bookingEventId) {
        db.updateBookingEvent(bookingEventId, { stripeSessionId: payment.sessionId, status: 'payment_sent' });
      }
      return {
        success: true,
        appointmentId: appointment.Id,
        serviceName,
        dateLabel,
        timeLabel,
        dateTimeLabel,
        requiresPayment: true,
        paymentUrl: payment.paymentUrl,
      };
    } catch (payErr) {
      logger.error('Payment link error:', payErr.message);
      return { success: true, appointmentId: appointment.Id, serviceName, dateLabel, timeLabel, requiresPayment: false, paymentError: true };
    }
  }

  return { success: true, appointmentId: appointment.Id, serviceName, dateLabel, timeLabel, requiresPayment: false };
}

async function toolGetAppointments(from) {
  const clients = await mindbodyService.getAllClientsByPhone(from);
  if (!clients || clients.length === 0) return { appointments: [] };

  const today = formatDateISO(new Date());
  const futureDate = formatDateISO(addDays(new Date(), 90));

  let all = [];
  for (const client of clients) {
    const appts = await mindbodyService.getStaffAppointments(today, futureDate, client.Id);
    all = all.concat(appts);
  }
  all.sort((a, b) => new Date(a.StartDateTime) - new Date(b.StartDateTime));

  const appointments = await Promise.all(all.slice(0, 10).map(async apt => {
    // Look up payment status from DB
    let isPaid = false;
    try {
      const row = await db.query(
        `SELECT status FROM booking_events WHERE mindbody_appointment_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [String(apt.Id)]
      );
      const status = row.rows?.[0]?.status;
      isPaid = status === 'paid';
    } catch (_) {}

    return {
      id: apt.Id,
      serviceName: apt.SessionType?.Name || 'Treatment',
      dateLabel: formatDutchDate(apt.StartDateTime),
      timeLabel: formatDutchTime(apt.StartDateTime),
      dateTime: apt.StartDateTime,
      isWithin24h: (new Date(apt.StartDateTime) - new Date()) < 24 * 60 * 60 * 1000,
      isPaid,
    };
  }));

  return { appointments };
}

async function toolCancelAppointments(from, { appointment_ids }) {
  const cancelled = [];
  const failed = [];
  for (const id of appointment_ids) {
    try {
      await mindbodyService.cancelAppointment(id);
      cancelled.push(id);
      db.query(
        `UPDATE booking_events SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = 'customer' WHERE mindbody_appointment_id = $1`,
        [id]
      ).catch(err => logger.error('DB cancel log:', err.message));
    } catch (err) {
      logger.error(`Cancel ${id} error:`, err.message);
      failed.push(id);
    }
  }
  return { cancelled, failed };
}

async function toolCheckClassSchedule(from, { session_type_ids, start_date, end_date }) {
  try {
    const classes = await mindbodyService.getClasses(session_type_ids, start_date, end_date);
    const now = new Date();

    const result = classes
      .filter(c => {
        if (c.IsCanceled) return false;
        if (new Date(c.StartDateTime) <= now) return false;
        const maxCap = c.MaxCapacity || 0;
        const booked = c.TotalBooked || 0;
        if (maxCap > 0 && booked >= maxCap) return false;
        return true;
      })
      .slice(0, 10)
      .map(c => ({
        id: `class_${c.Id}`,
        classId: c.Id,
        name: c.ClassDescription?.Name || 'Studio Class',
        dateLabel: formatDutchDate(c.StartDateTime),
        timeLabel: formatDutchTime(c.StartDateTime),
        dateTime: c.StartDateTime,
        sessionTypeId: c.ClassDescription?.SessionType?.Id || session_type_ids[0],
        spotsLeft: c.MaxCapacity ? c.MaxCapacity - (c.TotalBooked || 0) : null,
      }));

    return { classes: result };
  } catch (err) {
    logger.warn('check_class_schedule error:', err.message);
    return { classes: [], error: err.message };
  }
}

async function toolBookClass(from, { class_id, session_type_id, class_name, class_date_time, client_name, client_email }) {
  // 1. Find or create client
  let client = await mindbodyService.getClientByPhone(from, client_email || null);
  if (!client) {
    if (!client_name || !client_email) {
      return { error: 'client_info_required', message: 'Need full name and email to create account.' };
    }
    const parts = client_name.trim().split(' ');
    const firstName = parts[0];
    const lastName = parts.slice(1).join(' ') || 'WhatsApp';
    try {
      client = await mindbodyService.addClient({ firstName, lastName, email: client_email, mobilePhone: from, city: 'Amsterdam' });
    } catch (addErr) {
      if (addErr.response?.data?.Error?.Code === 'InvalidClientCreation') {
        client = await mindbodyService.getClientByPhone(from, client_email);
        if (!client) throw addErr;
      } else throw addErr;
    }
  }

  // 2. Enrol in class
  const visit = await mindbodyService.addClientToClass(client.Id, class_id);

  const dateLabel = formatDutchDate(class_date_time);
  const timeLabel = formatDutchTime(class_date_time);
  const lang = conversationService.get(from)?.lang || 'en';
  const atWord = lang === 'nl' ? 'om' : 'at';
  const dateTimeLabel = `${dateLabel} ${atWord} ${timeLabel}`;

  // 3. Log to DB
  const priceCents = paymentService.getPriceInCents(session_type_id);
  const bookingEventId = await db.logBookingEvent({
    phone: from,
    customerName: client_name || `${client.FirstName} ${client.LastName}`.trim(),
    sessionTypeId: session_type_id,
    serviceName: class_name,
    status: 'confirmed',
    amountCents: priceCents,
  });
  if (bookingEventId) {
    await db.updateBookingEvent(bookingEventId, {
      appointmentDate: class_date_time,
      mindbodyAppointmentId: class_id,
    });
  }

  // 4. Payment link
  if (priceCents) {
    try {
      const payment = await paymentService.createPaymentLink({
        appointmentId: class_id,
        clientId: client.Id,
        from,
        serviceName: class_name,
        dateTime: dateTimeLabel,
        amount: priceCents,
        customerEmail: client.Email || client_email,
        customerName: client_name || `${client.FirstName} ${client.LastName}`.trim(),
      });
      if (bookingEventId) {
        db.updateBookingEvent(bookingEventId, { stripeSessionId: payment.sessionId, status: 'payment_sent' });
      }
      return { success: true, classId: class_id, className: class_name, dateLabel, timeLabel, dateTimeLabel, requiresPayment: true, paymentUrl: payment.paymentUrl };
    } catch (payErr) {
      logger.error('Class payment link error:', payErr.message);
      return { success: true, classId: class_id, className: class_name, dateLabel, timeLabel, requiresPayment: false, paymentError: true };
    }
  }

  return { success: true, classId: class_id, className: class_name, dateLabel, timeLabel, requiresPayment: false };
}

async function toolHumanHandoff(from, name, { reason }) {
  const conv = conversationService.get(from);
  const customerName = conv?.userName || name || 'Unknown';
  db.logEscalation(from, customerName, 'human_handoff', reason);
  db.markConversationEscalated(from);
  emailService.sendEscalationEmail({ customerName, customerPhone: from, message: reason })
    .catch(err => logger.error('Escalation email error:', err.message));
  return { sent: true };
}

// ---- Respond tool ----

async function executeRespond(from, args) {
  const { message, ui_type, buttons, list_sections, list_button_label, cta_label, cta_url, detected_language } = args;

  if (detected_language) {
    conversationService.update(from, { lang: detected_language });
  }

  try {
    switch (ui_type) {
      case 'buttons': {
        const validButtons = (buttons || []).filter(b => b.id && b.title).map(b => ({
          id: b.id,
          title: String(b.title).substring(0, 20),
        }));
        if (validButtons.length === 0) {
          await whatsappService.sendText(from, message);
        } else {
          await whatsappService.sendButtons(from, message, validButtons);
        }
        break;
      }
      case 'list': {
        const validSections = (list_sections || [])
          .map(s => ({
            title: String(s.title || 'Options').substring(0, 24),
            rows: (s.rows || []).filter(r => r.id && r.title).map(r => ({
              id: r.id,
              title: String(r.title).substring(0, 24),
              description: String(r.description || '').substring(0, 72),
            })),
          }))
          .filter(s => s.rows.length > 0);

        if (validSections.length === 0) {
          // AI forgot list_sections — send plain text
          logger.warn('respond list called with no valid sections, sending text');
          await whatsappService.sendText(from, message);
        } else {
          try {
            await whatsappService.sendList(from, message, (list_button_label || 'View').substring(0, 20), validSections);
          } catch (listErr) {
            // List failed — build readable text fallback that includes the options
            logger.error('sendList failed, using text fallback:', listErr.response?.data || listErr.message);
            const allRows = validSections.flatMap(s => s.rows);
            const optionLines = allRows.map(r => `• ${r.title}${r.description ? ` — ${r.description}` : ''}`).join('\n');
            const lang = conversationService.get(from)?.lang || 'en';
            const replyHint = lang === 'nl' ? 'Typ de gewenste tijd:' : 'Type the time you want:';
            await whatsappService.sendText(from, `${message}\n\n${optionLines}\n\n${replyHint}`).catch(() => {});
          }
        }
        break;
      }
      case 'cta_button':
        await whatsappService.sendCTAButton(from, message, (cta_label || 'Open').substring(0, 20), cta_url);
        break;
      default:
        await whatsappService.sendText(from, message);
    }
  } catch (sendErr) {
    logger.error('executeRespond fatal error:', sendErr.message);
    await whatsappService.sendText(from, message).catch(() => {});
  }

  conversationService.addMessage(from, 'assistant', message);
}

// ---- Main agent runner ----

async function run(from, name, userMessage) {
  // Ensure conversation state
  if (!conversationService.get(from)) {
    conversationService.set(from, { userName: name, lang: 'en' });
  } else {
    conversationService.update(from, { userName: name });
  }

  // Add user message to history
  conversationService.addMessage(from, 'user', userMessage);

  // Build message array for OpenAI
  const history = conversationService.getMessages(from);
  const messages = [
    { role: 'system', content: buildSystemPrompt(from, name) },
    ...history,
  ];

  const MAX_ITERATIONS = 6;
  let terminated = false;

  for (let i = 0; i < MAX_ITERATIONS && !terminated; i++) {
    let response;
    try {
      response = await openai.chat.completions.create({
        model: config.OPENAI_MODEL || 'gpt-4o',
        messages,
        tools: TOOLS,
        tool_choice: 'required',
        max_tokens: 1024,
      });
    } catch (err) {
      logger.error('OpenAI agent call error:', err.message);
      const lang = conversationService.get(from)?.lang || 'en';
      await whatsappService.sendText(from, lang === 'nl'
        ? 'Er ging iets mis. Probeer het opnieuw.'
        : 'Something went wrong. Please try again.');
      return;
    }

    const assistantMsg = response.choices[0].message;
    messages.push(assistantMsg);

    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      // Shouldn't happen with tool_choice: required, but handle it
      if (assistantMsg.content) {
        await whatsappService.sendText(from, assistantMsg.content);
        conversationService.addMessage(from, 'assistant', assistantMsg.content);
      }
      break;
    }

    // Split tool calls: data/action tools vs respond
    const respondCall = assistantMsg.tool_calls.find(tc => tc.function.name === 'respond');
    const otherCalls = assistantMsg.tool_calls.filter(tc => tc.function.name !== 'respond');

    // Execute data/action tools in parallel
    if (otherCalls.length > 0) {
      const results = await Promise.all(otherCalls.map(async tc => {
        const args = JSON.parse(tc.function.arguments);
        logger.info(`Agent tool: ${tc.function.name}`, JSON.stringify(args).substring(0, 200));
        let result;
        try {
          switch (tc.function.name) {
            case 'check_availability':
              result = await toolCheckAvailability(from, args);
              break;
            case 'lookup_client':
              result = await toolLookupClient(from);
              break;
            case 'book_appointment':
              result = await toolBookAppointment(from, args);
              break;
            case 'get_appointments':
              result = await toolGetAppointments(from);
              break;
            case 'cancel_appointments':
              result = await toolCancelAppointments(from, args);
              break;
            case 'check_class_schedule':
              result = await toolCheckClassSchedule(from, args);
              break;
            case 'book_class':
              result = await toolBookClass(from, args);
              break;
            case 'request_human_handoff':
              result = await toolHumanHandoff(from, name, args);
              break;
            default:
              result = { error: `Unknown tool: ${tc.function.name}` };
          }
        } catch (err) {
          logger.error(`Tool ${tc.function.name} threw:`, err.message);
          result = { error: err.message };
        }
        return { id: tc.id, result };
      }));

      for (const { id, result } of results) {
        messages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(result) });
      }
    }

    // Execute respond (terminal)
    if (respondCall) {
      const args = JSON.parse(respondCall.function.arguments);
      logger.info('Agent respond:', args.ui_type, args.message?.substring(0, 80));
      await executeRespond(from, args);
      messages.push({ role: 'tool', tool_call_id: respondCall.id, content: JSON.stringify({ sent: true }) });
      terminated = true;
    }
  }

  if (!terminated) {
    logger.error('Agent loop exhausted without respond for', from);
    const lang = conversationService.get(from)?.lang || 'en';
    await whatsappService.sendText(from, lang === 'nl'
      ? 'Er ging iets mis. Probeer het opnieuw.'
      : 'Something went wrong. Please try again.');
  }
}

// ---- Input decoder (button/list IDs → readable text for the AI) ----

function decodeInput(buttonReply, listReply) {
  const id = buttonReply?.id || listReply?.id;
  const title = buttonReply?.title || listReply?.title || '';

  if (!id) return null;

  // Group class selection: class_456
  if (id.startsWith('class_')) {
    const classId = id.slice(6);
    return `${title} [classId=${classId}]`;
  }

  // Slot selection: slot_2026-05-01T09:00:00_5_58
  if (id.startsWith('slot_')) {
    const withoutPrefix = id.slice(5); // "2026-05-01T09:00:00_5_58"
    const last = withoutPrefix.lastIndexOf('_');
    const secondLast = withoutPrefix.lastIndexOf('_', last - 1);
    const dateTime = withoutPrefix.substring(0, secondLast);
    const staffId = withoutPrefix.substring(secondLast + 1, last);
    const sessionTypeId = withoutPrefix.substring(last + 1);
    return `${title} [slot: dateTime=${dateTime} staffId=${staffId} sessionTypeId=${sessionTypeId}]`;
  }

  // Service / sub-option selection (svc_finn, svc_87, svc_ir, svc_oxy30, etc.)
  if (id.startsWith('svc_')) {
    const entry = _catalog.byGroupId[id];
    if (entry) {
      // Sub-option selected (has _subOption): resolve to specific session type IDs
      if (entry._subOption) {
        const sub = entry._subOption;
        const ids = sub.sessionTypeIds.join(',');
        return `${sub.label} [sessionTypeIds=${ids}]`;
      }
      // Parent group selected: tell AI what it is and whether it has sub-options
      const ids = entry.sessionTypeIds.join(',');
      if (entry.subOptions) {
        const opts = entry.subOptions.map(s => `{id:${s.id},label:"${s.label}",ids:${s.sessionTypeIds.join(',')}}`).join(', ');
        return `${entry.display} [subOptions: ${opts}]`;
      }
      return `${entry.display} [sessionTypeIds=${ids}]`;
    }
    // Legacy numeric fallback
    const sessionTypeId = id.slice(4);
    return `${title || id} [sessionTypeId=${sessionTypeId}]`;
  }
  if (id.startsWith('service_')) {
    return `${title} [sessionTypeId=${id.slice(8)}]`;
  }

  // Cancel appointment selection
  if (id.startsWith('cancel_apt_')) {
    return `Cancel appointment ${id.slice(11)} (${title})`;
  }

  // Old time selection format (legacy)
  if (id.startsWith('time_')) {
    const parts = id.slice(5).split('_');
    const dateTime = parts[0];
    const staffId = parts[1] || '0';
    const sessionTypeId = parts[2] || '0';
    return `${title} [slot: dateTime=${dateTime} staffId=${staffId} sessionTypeId=${sessionTypeId}]`;
  }

  const MAP = {
    menu_book: 'I want to book an appointment',
    menu_appointments: 'Show my upcoming appointments',
    menu_info: 'I want information',
    confirm_yes: 'Yes, confirm',
    confirm_no: 'No, cancel',
    cancel_confirm: 'Yes, cancel the appointment',
    cancel_no: 'No, keep the appointment',
    cancel_all: 'Cancel all my appointments',
    date_week: 'This week',
    date_nextweek: 'Next week',
    cat_tech: 'Tech Treatments',
    cat_massages: 'Massages',
    cat_traditional: 'Massages', // legacy
    cat_classes: 'Classes',
    info_other: 'I have another question',
  };
  if (MAP[id]) return MAP[id];
  if (id.startsWith('cat_')) return `Show ${id.slice(4)} treatments`;
  if (id.startsWith('info_')) return `Tell me about ${id.slice(5)}`;
  if (id.startsWith('date_')) return `Date: ${id.slice(5)}`;
  if (id.startsWith('cancel_all')) return 'Cancel all my appointments';

  return title || id;
}

module.exports = { run, decodeInput };
