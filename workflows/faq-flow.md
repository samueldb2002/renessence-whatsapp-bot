# Workflow: FAQ Flow

## Objective
Answer frequently asked questions from customers via WhatsApp.

## Trigger
Customer asks a question about the business (detected by Claude AI as FAQ intent).

## Steps
1. Claude detects FAQ intent and identifies the topic
2. If Claude provided a freeformAnswer: use that directly
3. Otherwise: look up topic in `src/data/faq.json`
4. Replace placeholders with business info from config
5. Send answer via WhatsApp

## Supported Topics
- openingstijden (opening hours)
- prijzen (prices)
- locatie (location)
- parkeren (parking)
- behandelingen (treatments)
- annuleringsbeleid (cancellation policy)
- cadeaubon (gift cards)
- kleding (what to wear/bring)

## Updating FAQ
Edit `src/data/faq.json` to add or modify FAQ entries.

## Tools Used
- `src/services/claude.service.js`
- `src/services/whatsapp.service.js`
- `src/data/faq.json`
