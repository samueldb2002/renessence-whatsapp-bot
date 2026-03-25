# Workflow: Cancel Flow

## Objective
Allow customers to cancel their appointment via WhatsApp.

## Trigger
Customer sends a message with cancellation intent.

## Steps
1. Look up client in Mindbody by phone number
2. Fetch upcoming appointments for that client
3. If no appointments: inform customer
4. If one appointment: show it and ask for confirmation
5. If multiple: show list, let customer select which one
6. On confirmation: cancel appointment in Mindbody
7. Send cancellation confirmation

## Important
- Remind about 24-hour cancellation policy if within 24 hours
- Clear conversation state after completion

## Tools Used
- `src/services/mindbody.service.js`
- `src/services/whatsapp.service.js`
- `src/services/conversation.service.js`
