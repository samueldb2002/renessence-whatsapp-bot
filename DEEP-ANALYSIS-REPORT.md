# Deep Code Analysis Report — WhatsApp Booking Agent (Renessence)

> Generated 2026-05-22 by 6 parallel analysis agents (security, performance, architecture, maintainability, error handling, testing).
> Paste this file into a Claude Code session to work through the fixes.

**Scope:** ~6.000 LOC | Node.js/Express | OpenAI GPT-4o + Mindbody + Stripe + WhatsApp Cloud API + PostgreSQL
**Totaal:** 8 critical, 14 high, 16 medium, 8 low findings

---

## CRITICAL (fix immediately)

### C1. SQL Injection in dashboard bookings count query
- **File:** `src/routes/dashboard.routes.js` lines 103-107
- **Issue:** The count query concatenates user-supplied `from`, `to`, and `status` query parameters directly into SQL using template literals (`AND created_at >= '${from}'`). The main query on lines 78-101 correctly uses parameterized queries, but the duplicate count query does not.
- **Fix:** Rewrite the count query to use parameterized queries (`$1`, `$2`, etc.) mirroring the pattern used by the main query above it. Build the params array and index counter the same way.

### C2. Stripe webhook accepts unverified payloads when STRIPE_WEBHOOK_SECRET is unset
- **File:** `src/services/payment.service.js` lines 239-246
- **Issue:** `constructWebhookEvent` falls back to raw JSON parsing without signature verification when `STRIPE_WEBHOOK_SECRET` is not configured. The comment says "ok for dev" but there is no `NODE_ENV` check. If the env var is accidentally unset in production, anyone can forge Stripe webhook events to mark bookings as paid without payment.
- **Fix:** Throw an error or refuse to process webhooks if `STRIPE_WEBHOOK_SECRET` is not set. At minimum gate the fallback behind `NODE_ENV === 'development'`. Log a warning at startup if the secret is missing.

### C3. No WhatsApp webhook signature verification
- **File:** `src/routes/webhook.js` lines 38-90
- **Issue:** Meta signs all webhook deliveries with `X-Hub-Signature-256`. This endpoint does not verify that signature. Anyone who knows the webhook URL can send forged messages that the bot processes as legitimate WhatsApp messages — triggering bookings, cancellations, or escalations on behalf of any phone number.
- **Fix:** Implement HMAC-SHA256 signature verification using the `X-Hub-Signature-256` header and the app secret. Compare computed hash to the header value before processing.

### C4. Stripe webhook has no idempotency guard — duplicate messages on retry
- **File:** `server.js` lines 40-79
- **Issue:** No idempotency check. If Stripe retries the webhook (e.g., first delivery timed out), the customer receives duplicate WhatsApp confirmations and emails. Additionally `db.updateBookingByStripeSession()` on line 54 is called without `await` and without `.catch()` — if the DB update fails, the booking status stays "payment_sent" instead of "paid".
- **Fix:** Query `booking_events` for the `stripe_session_id` and check if status is already "paid" before processing. Await the DB update and handle failures. Consider storing the Stripe event ID to detect duplicate deliveries.

### C5. ~2,000 lines of dead code (29% of codebase) with contradictory business logic
- **Files to DELETE entirely:**
  - `src/handlers/booking.handler.js` (782 LOC) — never imported, replaced by agent
  - `src/handlers/cancel.handler.js` (290 LOC) — never imported, replaced by agent
  - `src/handlers/reschedule.handler.js` (354 LOC) — never imported, replaced by agent
  - `src/services/claude.service.js` (132 LOC) — never imported, replaced by agent
  - `src/config/i18n.js` (149 LOC) — never imported by any live code
- **Files to CLEAN UP:**
  - `src/config/constants.js` — remove `INTENTS`, `FAQ_TOPICS`, `buildSystemPrompt` (only used by dead files). The legacy system prompt still lists "IV Drip" as a treatment while the agent explicitly says it's no longer offered.
  - `src/data/service-catalog.js` — only imported by dead `booking.handler.js`. Contains stale services (Yoga id 5, Hot Yoga id 6, Meditation id 7) not in the dynamic catalog. Delete or archive.
  - `src/services/conversation.service.js` — remove `startFlow()` and `clearFlow()` methods (only used by dead handlers)
- **Why it matters:** The dead `booking.handler.js` has its own `SERVICE_SLOT_TIMES` (lines 295-340) with DIFFERENT values than the canonical `src/config/slot-times.js` (e.g., 30-min intervals vs 70-min for Hyperbaric). Two catalog systems define different services. The legacy system prompt contradicts the active agent about offered treatments.

### C6. Sequential Mindbody API calls — N+1 pattern causing 5-15 second response times
- **File:** `src/agents/renessence.agent.js` lines 618-631
  - `toolCheckAvailability` iterates `session_type_ids` with sequential `for...of` loop. Infrared Sauna has 7 IDs = 1.4-5.6 seconds just for availability.
  - **Fix:** `Promise.all(session_type_ids.map(id => mindbodyService.getBookableItems(id, start_date, end_date).catch(...)))`
- **File:** `src/services/mindbody.service.js` lines 469-500
  - `getAllClientsByPhone` tries 4 phone formats sequentially (800ms-3.2s).
  - **Fix:** `Promise.all` all 4 variants, then merge/deduplicate results.
- **File:** `src/services/mindbody.service.js` lines 340-380
  - `searchClientByEmail` scans 90 days of appointments with individual API calls per client ID.
  - **Fix:** Cache email-to-client mapping. Parallelize `fetchClientById` calls with concurrency limit.
- **File:** `src/agents/renessence.agent.js` lines 767-788
  - `toolBookAppointment` calls `getClientByPhone` again even though `lookup_client` already found the client. The client ID is not passed between tools.
  - **Fix:** Pass `clientId` through the `book_appointment` tool parameters, or add a per-conversation client cache.

### C7. No automated tests exist — zero
- **What's missing:** No test framework in package.json, no `.test.*` or `.spec.*` files, no CI/CD pipeline. Only 3 manual scripts in `tools/` that hit live APIs with no assertions.
- **Fix — Phase 1 (install):**
  ```bash
  npm install --save-dev jest
  ```
  Add to package.json: `"test": "jest"`
- **Fix — Phase 2 (test pure functions first — highest value, lowest effort):**
  1. `src/utils/date.js` — `parseFreeTextDate` handles 12+ input formats in Dutch/English. Test every format.
  2. `src/utils/phone.js` — `normalize` handles 3 phone formats. Test all variants + edge cases.
  3. `src/services/payment.service.js` — `getPriceInCents` maps 30+ session type IDs to prices. Verify every mapping.
  4. `src/agents/renessence.agent.js:1477-1569` — `decodeInput` converts button/list IDs to text. Test every ID pattern.
  5. `src/data/service-catalog.js` — `findServiceByText` fuzzy matching. Test customer-realistic inputs.
- **Fix — Phase 3 (test critical business logic with mocked services):**
  6. `server.js:31-130` — Stripe webhook handler (mocked stripe, db, mindbody, whatsapp)
  7. `renessence.agent.js:767-888` — `toolBookAppointment` (mocked services)
  8. `renessence.agent.js:1013-1078` — `toolCancelAppointments` (mocked services)
  9. `renessence.agent.js:617-746` — `toolCheckAvailability` slot generation (mocked Mindbody data)

### C8. In-memory pending payments lost on server restart
- **File:** `src/services/payment.service.js` lines 6-7
- **Issue:** `pendingPayments` is a `Map()` — the primary lookup for matching Stripe webhook events to bookings. On server restart: all entries lost. `handlePaymentSuccess` returns `null`, the fallback relies on incomplete Stripe metadata. `cancelPendingPaymentByAppointment` silently fails for pre-restart bookings, leaving orphaned Stripe sessions. No cleanup mechanism; grows unbounded.
- **Fix:** Use the `booking_events` table (already has `stripe_session_id`) as the source of truth. DB lookup in `handlePaymentSuccess`/`handlePaymentExpired`. Keep the Map as a hot cache only. Add periodic cleanup (delete entries > 2 hours old).

---

## HIGH (fix soon)

### H1. Prompt injection via WhatsApp user messages
- **File:** `src/agents/renessence.agent.js` lines 1282-1318
- **Issue:** User messages go directly into the OpenAI messages array alongside the system prompt. The `__RESUME__` trigger (line 1307) can be sent by any WhatsApp user — it's checked by `userMessage.startsWith('__RESUME__')` with no verification that it came from the dashboard. The system prompt contains tool schemas, pricing, and internal business logic.
- **Fix:** (1) Filter `__RESUME__` messages at the webhook/handler level unless they originate from the dashboard. (2) Wrap user messages in delimiters that the system prompt explicitly treats as untrusted. (3) Add a content filter for known prompt injection patterns.

### H2. No rate limiting on any endpoint
- **File:** `server.js` (all routes)
- **Issue:** No `express-rate-limit` on any route. The unauthenticated webchat endpoint triggers OpenAI API calls — an attacker can run up the bill.
- **Fix:**
  ```bash
  npm install express-rate-limit
  ```
  Add limits: webhook 100/min/IP, webchat 15/min/IP, dashboard 60/min/IP, stripe webhook 30/min/IP.

### H3. HTML injection in email templates via unsanitized customer data
- **File:** `src/services/email.service.js` lines 70-78, 179-191, 209-222
- **Issue:** `customerName`, `message`, `serviceName`, `conversationHistory` are interpolated directly into HTML email templates without encoding. A WhatsApp user with a malicious name can inject HTML/JS into emails received by the team.
- **Fix:** Create `escapeHtml()` utility that escapes `<`, `>`, `&`, `"`, `'`. Apply to every dynamic value in email templates.

### H4. renessence.agent.js is a 1,571-line god object
- **File:** `src/agents/renessence.agent.js`
- **Issue:** Contains 7+ distinct responsibilities: tool definitions (27-270), system prompt builder (274-600), availability logic (617-745), booking/payment/cancel tool implementations (767-1196), WhatsApp response dispatcher (1203-1278), agent loop runner (1282-1454), web chat runner (1458-1473), input decoder (1477-1571). 8 direct service dependencies. Impossible to unit test.
- **Fix:** Split into:
  - `src/agents/tool-definitions.js` — TOOLS array
  - `src/agents/tool-implementations.js` — all `tool*` functions
  - `src/agents/system-prompt.js` — `buildSystemPrompt` (consider extracting static text to a .md template file)
  - `src/agents/input-decoder.js` — `decodeInput` function
  - `src/agents/renessence.agent.js` — keep only the runner loop (run, runWeb, executeRespond)

### H5. No per-user concurrency guard — double bookings possible
- **File:** `src/handlers/message.handler.js` lines 44-46
- **Issue:** If a user sends 2 messages quickly, two `agent.run()` calls execute concurrently for the same phone number. Both read the same conversation history, both may attempt to book the same slot. The in-memory conversations Map is mutated concurrently without protection.
- **Fix:** Add a per-user lock in `message.handler.js`:
  ```js
  const userLocks = new Map();
  async function withUserLock(phone, fn) {
    const prev = userLocks.get(phone) || Promise.resolve();
    const current = prev.then(fn, fn);
    userLocks.set(phone, current);
    current.finally(() => { if (userLocks.get(phone) === current) userLocks.delete(phone); });
    return current;
  }
  // Usage: await withUserLock(from, () => agent.run(from, name, text));
  ```

### H6. No timeouts on external API calls
- **File:** `src/services/mindbody.service.js` lines 12-19
- **Issue:** Axios instance has no `timeout`. If Mindbody becomes unresponsive, the entire system hangs for that user. Under load, multiple hangs exhaust memory/connections.
- **Fix:** Add `timeout: 15000` to the axios instance config. Also add timeout to the OpenAI call in `renessence.agent.js` line 1327.

### H7. No process-level error handlers
- **File:** `server.js`
- **Issue:** No `process.on('unhandledRejection')` or `process.on('uncaughtException')`. Background async errors (fire-and-forget calls after `res.sendStatus(200)`, cron jobs) go completely unnoticed or crash the process.
- **Fix:** Add at the top of server.js:
  ```js
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection:', reason);
  });
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception:', err);
  });
  ```

### H8. System prompt rebuilt on every single message (~5,000 tokens)
- **File:** `src/agents/renessence.agent.js` lines 274-600
- **Issue:** Every message triggers `buildSystemPrompt` which includes the entire knowledge base JSON and service catalog. Over an 8-iteration agent loop, this is sent with every OpenAI call, burning tokens and adding latency/cost.
- **Fix:** Cache the system prompt globally (or per-conversation) with a TTL. Only the dynamic parts (date, customer name, `restoredFromDb` flag) need per-message updates. Rebuild only when catalog changes.

### H9. `tool_choice: 'required'` forces unnecessary OpenAI calls
- **File:** `src/agents/renessence.agent.js` lines 1327-1333
- **Issue:** The model MUST call a tool every turn, even for simple greetings. This means it always calls `respond` as a tool rather than finishing naturally — an extra round-trip for simple conversations.
- **Fix:** Switch to `tool_choice: 'auto'` and handle plain text responses (already partially handled at line 1351-1357).

### H10. Fire-and-forget DB updates in payment flow
- **File:** `src/agents/renessence.agent.js` lines 908-912
- **Issue:** `db.updateBookingEvent()` in `toolSendPayment` is called without `await` and without `.catch()`. If the update fails, the `booking_events` table won't have the Stripe session ID, breaking payment-to-booking correlation permanently.
- **Fix:** `await` the DB updates. On failure, log at error level with the appointment ID and Stripe session ID for manual reconciliation.

### H11. Global bot pause flag is never checked
- **File:** `src/routes/dashboard.routes.js` lines 429-455, `src/handlers/message.handler.js`
- **Issue:** The dashboard exposes `/bot-stop` and `/bot-start` endpoints that toggle a `botPaused` boolean. But `message.handler.js` never imports or checks this flag. The emergency kill-switch does nothing.
- **Fix:** Import `isBotPaused` in `message.handler.js` and check before calling `agent.run()`. Send a "we're temporarily offline" message to the user if paused.

### H12. Missing database indexes on frequently queried columns
- **File:** `src/data/database.js`
- **Issue:** No index on `booking_events.mindbody_appointment_id` (queried in agent lines 982, 1039) or `booking_events.stripe_session_id` (queried in webhook handler). Full table scans on every payment and appointment lookup.
- **Fix:** Add to `initialize()`:
  ```sql
  CREATE INDEX IF NOT EXISTS idx_booking_events_mb_appointment ON booking_events(mindbody_appointment_id);
  CREATE INDEX IF NOT EXISTS idx_booking_events_stripe_session ON booking_events(stripe_session_id);
  ```

### H13. Webchat endpoint is completely unauthenticated
- **File:** `src/routes/webchat.routes.js` lines 1-24
- **Issue:** `/webchat/message` accepts arbitrary requests with no auth, CAPTCHA, or rate limiting. Each request triggers an OpenAI API call. `sessionId` is client-generated (`Math.random()`).
- **Fix:** Rate limit per IP (10-20 req/min). Move sessionId generation server-side. Consider lightweight CAPTCHA for new sessions.

### H14. Partial cancellation leaves inconsistent state
- **File:** `src/agents/renessence.agent.js` lines 1013-1077
- **Issue:** When cancelling multiple appointments, side-effects (Stripe cancel, DB update, email, WhatsApp) are fire-and-forget with `.catch()`. If the WhatsApp refund message on line 1058 fails, the outer catch pushes the ID to `failed[]` even though the Mindbody cancellation already succeeded. The user is told it failed when the appointment is actually cancelled.
- **Fix:** Move the ID to `cancelled[]` immediately after `mindbodyService.cancelAppointment()` succeeds (already done on line 1032). Wrap each side-effect independently so WhatsApp send failure doesn't affect the cancelled/failed reporting.

---

## MEDIUM (fix when possible)

### M1. Dashboard auth: static token, no timing-safe comparison
- **File:** `src/middleware/dashboard-auth.js` lines 1-16
- **Fix:** Use `crypto.timingSafeEqual()` for token comparison. Consider JWT with expiration.

### M2. SSL cert validation disabled for PostgreSQL
- **File:** `src/data/database.js` lines 4-6
- **Fix:** Set `rejectUnauthorized: true` and configure the CA certificate from your database provider.

### M3. Sensitive customer data (PII) logged to console
- **File:** `src/services/mindbody.service.js` lines 179, 214-224, 515-516
- **Fix:** Redact PII from logs. Log only non-sensitive identifiers at info level. Full request/response logging at debug level only.

### M4. BOT_STOP_PASSWORD falls back to DASHBOARD_API_TOKEN
- **File:** `src/routes/dashboard.routes.js` lines 437-438
- **Fix:** Require a dedicated `BOT_STOP_PASSWORD` env var. Do not fall back.

### M5. In-memory conversation state lost on restart
- **File:** `src/services/conversation.service.js` lines 1-90
- **Fix:** Persist the booking cart/flow state to DB. The 30-min TTL is also aggressive for payment flows. Consider Redis or DB-backed sessions.

### M6. PostgreSQL pool has no error handler
- **File:** `src/data/database.js` lines 4-7
- **Fix:** Add `pool.on('error', (err) => { logger.error('PG pool error:', err.message); })` after pool creation.

### M7. JSON.parse of tool call arguments can throw, crashing agent loop
- **File:** `src/agents/renessence.agent.js` lines 1366-1367
- **Fix:** Wrap in try/catch. On parse failure, return `{ error: 'Invalid tool arguments' }` as tool result.

### M8. Availability check returns empty slots on total API failure (looks like "no availability")
- **File:** `src/agents/renessence.agent.js` lines 617-633
- **Fix:** Track whether any calls succeeded. If all failed, return `{ error: 'availability_check_failed' }` instead of empty slots.

### M9. Microsoft Graph token refresh: no retry
- **File:** `src/services/email.service.js` lines 14-31
- **Fix:** Add at least one retry with backoff for token acquisition.

### M10. Mindbody `withRetry` only retries 401, not transient errors
- **File:** `src/services/mindbody.service.js` lines 43-55
- **Fix:** Add retry for 500, 502, 503, 429 with exponential backoff (2-3 attempts). Guard against infinite recursion.

### M11. `conversation_messages` table grows unbounded
- **File:** `src/data/database.js` lines 339-348
- **Fix:** Add periodic cleanup (prune messages > 90 days) or Postgres partitioning.

### M12. Reminder cron fetches 37-hour window but acts on 2 narrow bands
- **File:** `src/services/reminder.service.js` lines 26-53
- **Fix:** Two targeted queries instead: one for 35-37h window, one for 1.5-2.5h window.

### M13. Treatment metadata scattered across 4+ files
- **Files:** `mindbody.service.js` (RESOURCE_MAP), `payment.service.js` (PRICE_MAP), `slot-times.js` (SERVICE_SLOT_TIMES), `dynamic-catalog.service.js` (catalog)
- **Fix:** Create a single `treatment-registry.js` with all treatment metadata. Other modules import from it.

### M14. System prompt is 300 lines of string template in code
- **File:** `src/agents/renessence.agent.js` lines 293-599
- **Fix:** Extract static prompt to a `.md` template file with `{{TODAY}}`, `{{CATALOG}}` placeholders.

### M15. Phone normalization duplicated between two functions
- **File:** `src/services/mindbody.service.js` lines 422-499
- **Fix:** Extract `buildPhoneVariants(phoneNumber)` helper, share between `getClientByPhone` and `getAllClientsByPhone`.

### M16. No CI/CD pipeline
- **Fix:** Create `.github/workflows/test.yml` that runs `npm test` on push and PR.

---

## LOW (nice to have)

### L1. `escAttr()` in widget only escapes double quotes
- **File:** `public/widget.js` lines 229-231
- **Fix:** Also escape `<`, `>`, `&`, `'`.

### L2. No `helmet` security headers
- **File:** `server.js`
- **Fix:** `npm install helmet` and add `app.use(helmet())`.

### L3. Debug endpoint `/debug/session-types` in production
- **File:** `src/routes/dashboard.routes.js` lines 560-567
- **Fix:** Remove or gate behind `NODE_ENV === 'development'`.

### L4. `process.memoryUsage()` exposed in health endpoint
- **File:** `src/routes/dashboard.routes.js` lines 406-425
- **Fix:** Remove or simplify to healthy/unhealthy boolean.

### L5. `defer_payment` parameter in tool schema does nothing
- **File:** `src/agents/renessence.agent.js` line 71
- **Fix:** Remove from tool definition.

### L6. Schema migration via CREATE TABLE IF NOT EXISTS on every boot
- **File:** `src/data/database.js` lines 9-131
- **Fix:** Consider `node-pg-migrate` for proper migration tracking.

### L7. Knowledge base JSON load silently swallowed
- **File:** `src/agents/renessence.agent.js` lines 280-282
- **Fix:** Log a warning when the knowledge base fails to load.

### L8. Stripe webhook handler inline in server.js (100 lines)
- **File:** `server.js` lines 31-130
- **Fix:** Extract to `src/routes/stripe.routes.js`.

---

## Recommended fix order

Start with security (C1-C3), then stability (C4, C8, H5-H7), then dead code removal (C5), then performance (C6), then testing (C7), then work down the HIGH and MEDIUM lists.
