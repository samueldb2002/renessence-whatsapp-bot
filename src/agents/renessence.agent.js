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
const { SERVICE_CATALOG } = require('../data/service-catalog');
const { PRICE_MAP } = require('../services/payment.service');

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

  const catalogText = SERVICE_CATALOG.map(cat => {
    const lines = [`\n**${cat.category}**`];
    for (const svc of cat.services) {
      const ids = svc.mindbodyIds.join(', ');
      const price = svc.mindbodyIds.map(id => PRICE_MAP[id]).find(p => p != null);
      const priceStr = price ? `€${price / 100}` : 'free / membership';
      lines.push(`- ${svc.displayName} | IDs: [${ids}] | ${priceStr} | keywords: ${svc.keywords.join(', ')}`);
    }
    return lines.join('\n');
  }).join('\n');

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

## Booking flow
1. Identify the treatment (ask or show a list if unclear)
2. Get the preferred date/time (today/tomorrow/this week, or specific date)
3. Call check_availability with the correct session_type_ids and date range
4. Show available slots using respond with ui_type "list" (use slot IDs from check_availability results as row IDs)
5. When customer selects a slot, call lookup_client to check if they're already known
6. If known client: skip to confirmation summary with their name
7. If new client: ask for full name and email, then show confirmation summary
8. Show confirmation summary with buttons "Confirm" / "Cancel"
9. When customer confirms: call book_appointment
10. If requiresPayment: respond with cta_button (payment link)

## Cancellation flow
1. Call get_appointments to see what's scheduled
2. If multiple appointments, ask which to cancel (show list or buttons)
3. Warn about late cancellation (within 24h = 100% charge)
4. Call cancel_appointments with the appointment ID(s)
5. Confirm cancellation

## WhatsApp UI rules
- Buttons: max 3, title max 20 chars each — use for yes/no and main menu
- List: max 10 rows total, title max 24 chars, description max 72 chars — use for time slots and multiple choices
- CTA button: payment links only

## STRICT RULE: showing time slots
NEVER put time slots in the message text. ALWAYS use ui_type "list" with list_sections populated from the check_availability result.

After calling check_availability, you get back a "slots" array like:
[
  { "id": "slot_2026-05-01T09:00:00_5_65", "timeLabel": "09:00", "dateLabel": "1 mei", "serviceName": "Infrared Sauna (1p)" },
  { "id": "slot_2026-05-01T09:30:00_5_65", "timeLabel": "09:30", "dateLabel": "1 mei", "serviceName": "Infrared Sauna (1p)" }
]

You MUST call respond like this — copy each slot's "id" exactly into the row id, "timeLabel" as the row title, and "dateLabel — serviceName" as the row description:
{
  "message": "Here are the available times for Infrared Sauna on 1 mei:",
  "ui_type": "list",
  "list_button_label": "View times",
  "list_sections": [
    {
      "title": "Available",
      "rows": [
        { "id": "slot_2026-05-01T09:00:00_5_65", "title": "09:00", "description": "1 mei — Infrared Sauna (1p)" },
        { "id": "slot_2026-05-01T09:30:00_5_65", "title": "09:30", "description": "1 mei — Infrared Sauna (1p)" }
      ]
    }
  ],
  "detected_language": "en"
}

If check_availability returns no slots, respond with ui_type "none" and offer alternative dates.

## Special redirects (always redirect, never book via bot)
- Memberships / credits / strippenkaart → book via https://renessence.com
- Gift cards / cadeaubonnen → redeem at https://renessence.com
- Double massage / duo massage / koppelmassage → https://form.jotform.com/Renessence/double-massage-form-request
- Creative Space / vergaderruimte → https://form.jotform.com/Renessence/creative-business-space-booking

## Service catalog (with Mindbody IDs and prices)
${catalogText}

## Knowledge base
${JSON.stringify(knowledgeBase)}`;
}

// ---- Tool implementations ----

function getServiceName(sessionTypeId) {
  for (const cat of SERVICE_CATALOG) {
    for (const svc of cat.services) {
      if (svc.mindbodyIds.includes(sessionTypeId)) return svc.displayName;
    }
  }
  return `Service ${sessionTypeId}`;
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

  if (allItems.length === 0) return { slots: [] };

  const now = new Date();
  const slots = [];

  for (const item of allItems) {
    const windowStart = new Date(item.StartDateTime);
    const windowEnd = new Date(item.BookableEndDateTime || item.EndDateTime);
    const staffId = item.Staff?.Id || 0;
    const sessionTypeId = item.SessionType?.Id || 0;
    const duration = item.SessionType?.DefaultTimeLength || 60;
    const windowDateStr = item.StartDateTime.split('T')[0];
    const validTimes = SERVICE_SLOT_TIMES[sessionTypeId];

    if (validTimes) {
      for (const timeStr of validTimes) {
        const slotTime = new Date(`${windowDateStr}T${timeStr}:00`);
        const slotEnd = new Date(slotTime.getTime() + duration * 60000);
        if (slotTime > now && slotTime >= windowStart && slotEnd <= windowEnd) {
          const dateTime = `${windowDateStr}T${timeStr}:00`;
          slots.push({
            id: `slot_${dateTime}_${staffId}_${sessionTypeId}`,
            dateTime,
            dateLabel: formatDutchDate(dateTime),
            timeLabel: timeStr,
            staffId,
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

      while (t < windowEnd) {
        const tEnd = new Date(t.getTime() + duration * 60000);
        if (t > now && tEnd <= windowEnd) {
          const pad = n => String(n).padStart(2, '0');
          const dateTime = `${t.getFullYear()}-${pad(t.getMonth()+1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}:00`;
          slots.push({
            id: `slot_${dateTime}_${staffId}_${sessionTypeId}`,
            dateTime,
            dateLabel: formatDutchDate(dateTime),
            timeLabel: `${pad(t.getHours())}:${pad(t.getMinutes())}`,
            staffId,
            sessionTypeId,
            serviceName: getServiceName(sessionTypeId),
          });
        }
        t = new Date(t.getTime() + 60 * 60000);
      }
    }
  }

  // Deduplicate by dateTime + sessionTypeId
  const seen = new Set();
  const unique = slots.filter(s => {
    const key = `${s.dateTime}_${s.sessionTypeId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => a.dateTime.localeCompare(b.dateTime));

  return { slots: unique.slice(0, 10) };
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

  return {
    appointments: all.slice(0, 10).map(apt => ({
      id: apt.Id,
      serviceName: apt.SessionType?.Name || 'Treatment',
      dateLabel: formatDutchDate(apt.StartDateTime),
      timeLabel: formatDutchTime(apt.StartDateTime),
      dateTime: apt.StartDateTime,
      isWithin24h: (new Date(apt.StartDateTime) - new Date()) < 24 * 60 * 60 * 1000,
    })),
  };
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

  // Service selection
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
    cat_traditional: 'Traditional Treatments',
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
