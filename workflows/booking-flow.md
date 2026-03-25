# Workflow: Booking Flow

## Objective
Handle end-to-end appointment booking via WhatsApp.

## Trigger
Customer sends a message with booking intent (detected by Claude AI).

## Steps
1. Detect intent and extract entities (service, date, time) via Claude
2. If service not specified: send service list (WhatsApp list message)
3. If date not specified: send date options (WhatsApp buttons)
4. Query Mindbody for available time slots on selected date
5. Send available times (WhatsApp list message)
6. On time selection: show booking summary with confirm/cancel buttons
7. On confirmation:
   a. Look up client in Mindbody by WhatsApp phone number
   b. If client not found: create client with WhatsApp display name
   c. Call Mindbody addAppointment
   d. Send confirmation message
   e. Clear conversation state

## Tools Used
- `src/services/claude.service.js` (intent detection)
- `src/services/mindbody.service.js` (services, availability, booking)
- `src/services/whatsapp.service.js` (send messages)
- `src/services/conversation.service.js` (state management)

## Error Handling
- Mindbody unavailable: "Sorry, we ondervinden technische problemen. Probeer het later opnieuw of bel ons."
- No availability: "Helaas zijn er geen tijden beschikbaar op die dag. Wilt u een andere dag proberen?"
- Booking fails: Retry once, then suggest calling.

## Expected Output
Customer receives booking confirmation via WhatsApp. Appointment is visible in Mindbody.
