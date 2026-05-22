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
      description: 'Create ONE combined Stripe payment link for one or more deferred bookings. Call this once after all book_appointment calls (with defer_payment: true) are done, or for a single booking when the customer is ready to pay.',
      parameters: {
        type: 'object',
        properties: {
          bookings: {
            type: 'array',
            description: 'All bookings to include in the payment. Each item comes from the result of a book_appointment call.',
            items: {
              type: 'object',
              properties: {
                booking_event_id: { type: 'integer', description: 'From book_appointment result' },
                appointment_id:   { type: 'integer', description: 'From book_appointment result' },
                service_name:     { type: 'string' },
                date_time_label:  { type: 'string', description: 'Human-readable date+time, e.g. "Monday 18 May at 10:00"' },
                amount_cents:     { type: 'integer', description: 'Price in cents, from book_appointment result' },
              },
              required: ['booking_event_id', 'appointment_id', 'service_name', 'date_time_label', 'amount_cents'],
            },
          },
          customer_email: { type: 'string' },
          customer_name:  { type: 'string' },
        },
        required: ['bookings'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_appointments',
      description: "Get the customer's upcoming appointments from Mindbody.",
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
      description: 'Cancel one or more appointments.',
      parameters: {
        type: 'object',
        properties: {
          appointment_ids: {
            type: 'array',
            items: { type: 'integer' },
            description: 'List of appointment IDs to cancel.',
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
