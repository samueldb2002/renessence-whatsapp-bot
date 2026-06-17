Lees DEEP-ANALYSIS-REPORT.md voor de volledige context. Een eerdere ronde heeft de volgende issues al opgelost: C1 (SQL injection), C2 (Stripe webhook bypass), C3 (WhatsApp signature verificatie), C4 (Stripe idempotency), C5 (dead code verwijderd), C6 (Promise.all voor Mindbody calls), H2 (rate limiting), H5 (per-user concurrency lock), H6 (API timeouts), H7 (process error handlers), H11 (bot pause check), H12 (DB indexes).

Werk nu de resterende issues af in deze volgorde:

## Ronde 2: Wat nog open staat

### 1. Tests opzetten (C7)
- Installeer jest: `npm install --save-dev jest` en voeg `"test": "jest"` toe aan package.json scripts.
- Schrijf tests voor pure functies eerst:
  - `src/utils/date.js` — test `parseFreeTextDate` voor elke format (vandaag, morgen, overmorgen, this week, next week, dag-namen in NL/EN, ISO dates, "5 april", "5/4")
  - `src/utils/phone.js` — test `normalize` voor +31..., 31..., 06..., nummers met spaties/streepjes
  - `src/services/payment.service.js` — test `getPriceInCents` voor elke session type ID in PRICE_MAP
  - De `decodeInput` functie in renessence.agent.js — test elk ID-patroon (slot_*, svc_*, class_*, cancel_apt_*, reschedule_apt_*)
- Daarna: test Stripe webhook handler in server.js met gemockte stripe, db, mindbody en whatsapp services.

### 2. Agent opsplitsen (H4)
Split `src/agents/renessence.agent.js` (1597 regels) in:
- `src/agents/tool-definitions.js` — de TOOLS array (tool schemas)
- `src/agents/tool-implementations.js` — alle tool* functies (toolCheckAvailability, toolBookAppointment, toolCancelAppointments, etc.)
- `src/agents/system-prompt.js` — buildSystemPrompt functie
- `src/agents/input-decoder.js` — decodeInput functie
- `src/agents/renessence.agent.js` — alleen de runner (run, runWeb, executeRespond)
Zorg dat alle imports/exports kloppen en dat de bot daarna nog steeds werkt. Test handmatig met een bericht via de webhook.

### 3. Prompt injection mitigatie (H1)
- Filter `__RESUME__` berichten in `src/routes/webhook.js` of `src/handlers/message.handler.js` — alleen toestaan als ze van het dashboard komen (niet van WhatsApp users).
- Wrap user messages in de OpenAI messages array met delimiters, bijv.: `[USER MESSAGE START] ... [USER MESSAGE END]` en voeg aan de system prompt toe dat content tussen deze delimiters untrusted user input is.

### 4. HTML escaping in emails (H3)
- Maak een `escapeHtml()` utility in `src/utils/html.js` die `<`, `>`, `&`, `"`, `'` escaped.
- Pas toe op ALLE dynamische waarden in `src/services/email.service.js`: customerName, message, serviceName, dateTime, conversationHistory in sendEscalationEmail, sendCancellationNotificationEmail, sendRefundNotificationEmail, en sendBookingConfirmationEmail.

### 5. Prompt caching + tool_choice optimalisatie (H8 + H9)
- Cache de system prompt: de statische delen (knowledge base, catalog, booking flow instructies) hoeven niet per bericht herbouwd te worden. Cache globaal met een TTL van 5 minuten. Alleen datum, klantnaam en restoredFromDb flag per bericht updaten.
- Verander `tool_choice: 'required'` naar `tool_choice: 'auto'` in de OpenAI call. Handle het geval dat het model met plain text antwoordt in plaats van een tool call (er zit al een partial handler op regel ~1351).

### 6. Fire-and-forget DB updates fixen (H10)
- In `toolSendPayment`: `await` de `db.updateBookingEvent()` calls. Voeg error handling toe die bij failure logt met appointment ID en Stripe session ID.
- In `toolCancelAppointments`: wrap elke side-effect (Stripe cancel, DB update, email, WhatsApp) in een eigen try/catch zodat een WhatsApp send failure niet de cancelled/failed rapportage beïnvloedt.

### 7. Overige medium fixes
- `src/middleware/dashboard-auth.js`: gebruik `crypto.timingSafeEqual()` voor token vergelijking
- `src/data/database.js`: voeg `pool.on('error', ...)` handler toe
- `src/agents/renessence.agent.js`: wrap `JSON.parse(tc.function.arguments)` in try/catch
- `src/agents/renessence.agent.js`: als ALLE availability calls falen, return `{ error: 'availability_check_failed' }` in plaats van lege slots
- `src/services/mindbody.service.js`: voeg retry toe voor 500/502/503/429 errors in `withRetry`, niet alleen 401
- `src/services/mindbody.service.js`: extract `buildPhoneVariants()` helper, deel tussen getClientByPhone en getAllClientsByPhone

Werk elk punt sequentieel af. Commit na elke logische groep (tests, agent split, security fixes, performance fixes). Verifieer na de agent split en na de tests dat de bot nog correct werkt.
