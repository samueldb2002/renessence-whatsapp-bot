# Workflow: Appointment Reminders

## Objective
Send automatic WhatsApp reminders before appointments.

## Schedule
Cron: every 15 minutes (`*/15 * * * *`)

## Steps
1. Query Mindbody for appointments in the next 25 hours
2. For each appointment:
   a. If 23-25 hours away and 24h reminder not yet sent: send 24h reminder
   b. If 1.5-2.5 hours away and 2h reminder not yet sent: send 2h reminder
3. Track sent reminders in memory (Map with composite key)
4. Clean up tracking entries older than 48 hours

## Duplicate Prevention
Key format: `${appointmentId}_${reminderType}` in sentReminders Map.

## Important
- Reminders outside WhatsApp 24h window require approved message templates
- Register templates in Meta Business Manager for production

## Tools Used
- `src/services/mindbody.service.js`
- `src/services/whatsapp.service.js`
- `src/services/reminder.service.js`
