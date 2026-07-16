/**
 * Tool definitions for the Renessence AI Agent.
 * These are the OpenAI function-calling tool schemas.
 */

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
          notes: { type: 'string', description: 'Optional notes to add to the appointment, e.g. add-on requests.' },
          skip_payment: { type: 'boolean', description: 'Set true when rescheduling a paid same-treatment booking — skips payment entirely.' },
          client_phone: { type: 'string', description: 'Customer phone number — required for web chat sessions where phone is not known from WhatsApp.' },
        },
        required: ['session_type_id', 'start_date_time'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_payment',
      description: 'Create ONE combined Stripe payment link for the pay-online bookings the customer made this journey. Call this once, when the customer is ready to pay, for treatments that require online payment (massages, nervous system reset, let it go, renewal facial, acupuncture, classes). The server already knows exactly which bookings to bill — you do NOT pass the bookings; just call it. If the journey has no pay-online treatments it safely returns nothing_to_pay.',
      parameters: {
        type: 'object',
        properties: {
          customer_email: { type: 'string', description: 'Customer email if known (used as the Stripe receipt address).' },
          customer_name:  { type: 'string', description: 'Customer name if known.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_appointments',
      description: "Get the customer's upcoming appointments from Mindbody. ALWAYS call this before cancel_appointments to obtain the real numeric appointment IDs — never guess or invent them.",
      parameters: {
        type: 'object',
        properties: {
          client_phone: { type: 'string', description: 'Customer phone number — fallback if not found by WhatsApp number.' },
          client_email: { type: 'string', description: 'Customer email — fallback lookup.' },
          client_name: { type: 'string', description: 'Customer full name — last-resort lookup if phone and email fail.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_appointments',
      description: 'Cancel one or more appointments. IMPORTANT: You MUST call get_appointments first to retrieve the real numeric appointment IDs. Never invent, guess, or reuse IDs from memory — always get them fresh from get_appointments.',
      parameters: {
        type: 'object',
        properties: {
          appointment_ids: {
            type: 'array',
            items: { type: 'integer' },
            description: 'Real appointment IDs from the get_appointments tool result. Never invent or guess these numbers.',
          },
          is_reschedule: {
            type: 'boolean',
            description: 'Set true when cancelling as part of a reschedule for the same treatment — suppresses the refund flow.',
          },
          is_within_24h: {
            type: 'boolean',
            description: 'Set true when isWithin24h is true for this appointment — suppresses refund notification to team (no refund within 24h per policy).',
          },
          service_name: {
            type: 'string',
            description: 'Name of the treatment being cancelled (from get_appointments result). Used for the team notification email.',
          },
          date_time: {
            type: 'string',
            description: 'Human-readable date and time of the appointment being cancelled, e.g. "Saturday 23 May at 14:35". Used for the team notification email.',
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
      description: 'Escalate to a human team member when the customer needs help the bot cannot provide. Always collect the customer email first before calling this.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why the customer needs human help.' },
          customer_email: { type: 'string', description: 'Email address provided by the customer.' },
        },
        required: ['reason', 'customer_email'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'forward_reschedule_request',
      description: "Forward a reschedule request to the Renessence team by email. Use when a customer wants to reschedule / move / change the date or time of an existing appointment. The bot does NOT reschedule itself. First state the reschedule policy, then collect the desired new date, the treatment (appointment type), and their email, then call this once. Do NOT call cancel_appointments or book_appointment for a reschedule.",
      parameters: {
        type: 'object',
        properties: {
          new_date: { type: 'string', description: 'The new date/time the customer would like, e.g. "Saturday 19 July, afternoon".' },
          treatment: { type: 'string', description: 'The treatment / appointment type to reschedule.' },
          customer_email: { type: 'string', description: 'Customer email — required so the team can reach them.' },
          customer_name: { type: 'string', description: 'Customer name if known.' },
          current_appointment: { type: 'string', description: 'Any detail the customer gave about the current appointment being moved, e.g. "Float this Saturday at 15:00". Optional.' },
        },
        required: ['new_date', 'treatment', 'customer_email'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_gift_card',
      description: "Check whether a gift-card number the customer gave is from Renessence's OLD (pre-migration) system, which no longer works for online payment. ALWAYS call this the moment a customer provides a gift-card number they want to use, BEFORE collecting anything else. Returns { is_old_system }. If is_old_system is true, follow the old-gift-card flow in the instructions.",
      parameters: {
        type: 'object',
        properties: {
          gift_card_number: { type: 'string', description: 'The gift-card number exactly as the customer typed it (spaces/dashes are fine — they are ignored).' },
        },
        required: ['gift_card_number'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'forward_gift_card_request',
      description: "Forward a gift-card booking request to the Renessence team by email. Use when a customer wants to pay with a gift card / cadeaubon. The bot does NOT book gift-card requests itself — the team handles them. For a normal gift card, collect the gift card number, which treatment they want, and which day. For an OLD-system gift card (check_gift_card returned is_old_system), collect the gift card number, their email, the appointment date, and the appointment type, and set old_system: true. Ask one at a time if needed, then call this once. Do NOT call book_appointment or send_payment for a gift-card booking.",
      parameters: {
        type: 'object',
        properties: {
          gift_card_number: { type: 'string', description: 'The gift card / cadeaubon number the customer provided.' },
          treatment: { type: 'string', description: 'The treatment / appointment type the customer wants.' },
          preferred_day: { type: 'string', description: 'The day (and time if given), e.g. "Saturday 12 July, afternoon".' },
          customer_name: { type: 'string', description: 'Customer name if known.' },
          customer_email: { type: 'string', description: 'Customer email. Required for an old-system card so the team can reach them.' },
          old_system: { type: 'boolean', description: 'Set true when check_gift_card reported is_old_system — flags the email as an old card needing manual transfer.' },
        },
        required: ['gift_card_number', 'treatment', 'preferred_day'],
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

module.exports = { TOOLS };
