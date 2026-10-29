# Team-editable bot content: plan

Status: approved 2026-10-27 (all ten areas in scope). Phase 1 built 2026-10-29 — see "Phase 1 as built" at the end.

## Why

Today every change the team wants is a code edit plus a redeploy: a promotion, a price, opening hours, a treatment. The Oct 13 dashboard fix showed what that costs, because "pushed" and "live" drifted apart for 11 days. Goal: the team changes business facts themselves from the dashboard. The change is live within a minute, it can be scheduled ahead (the `offering.js` date-switch pattern, but data instead of code), and it can be undone.

**The real difficulty is that most facts are written in several places, not just one.** A massage price lives in `PRICE_MAP`, in a `DISPLAY_GROUPS` label, in the hard-coded step-1 menu in `system-prompt.js:200-222`, and in `knowledge-base.json` text. An "edit price" box that only changes `PRICE_MAP` would make the bot quote one price and charge another. So every editable fact gets **one source** (the database, with today's code values as the fallback), and the prompt text, the WhatsApp menu and the catalog are **generated from it**.

## What the team can edit (proposed)

The user asked for the first four; the rest is my "what else" list, ordered by value.

| # | Area | What the team edits | Notes |
|---|---|---|---|
| 1 | **Promotions** | Name, start/end, what the bot should know (EN), intro message EN/NL + poster, "send intro at start of new chats" on/off, "only mention when asked" on/off | Replaces `offering.js` PT promo, the `CAMPAIGNS` array, the stale July promo and the undated December gift-card deal |
| 2 | **Opening hours** | Weekly hours | Today only in KB text; `SPA_OPENING_HOURS` is never read |
| 3 | **Closures and special hours** *(what else)* | "Closed 25 Dec", "Open 12:00–18:00 on 31 Dec", with a reason | New: the bot never offers slots on a closed day (a code guard, not just prompt text) and tells guests why |
| 4 | **Prices** | Price per treatment and duration; Passes & Memberships prices | Generated into menu, catalog labels, KB; validated before saving |
| 5 | **Treatments** | Pause/unpause a treatment; name and description; which days it runs (NSR Fridays); register a new treatment that already exists in Mindbody | New ones are a guided form; see phase 4 |
| 6 | **Notices** *(what else)* | Temporary facts with an end date: "Float cabin in maintenance until 3 Nov", "Hammam closed this week" | Bot reads them; they expire by themselves |
| 7 | **Packages** *(what else)* | Oxygen 5x and similar website-only packages: price, link, what's included | Currently hard-coded prose |
| 8 | **Contact and links** *(what else)* | Address, phone, the welcome@/events@/memberships@ addresses, membership and gift-card URLs | Used by the prompt and the reminder messages (`SPA_ADDRESS` is empty today, so reminders show an empty 📍 line) |
| 9 | **Bot behaviour** *(what else)* | Payment window minutes, the €150 "fully prepaid" threshold, who gets escalation emails | The €150 is hard-coded in the prompt separately from the env var today, so this fixes a real inconsistency |
| 10 | **FAQ answers** *(what else, later)* | Free-text answers per topic (parking, what to bring, pregnancy) | Editing raw knowledge-base JSON is too fragile; this needs topic-sized fields, so it comes last |

Not editable from the dashboard (on purpose):
- Mindbody setup: session types, staff, rooms, schedules stay in Mindbody.
- The rules that protect money: confirm taps, offered-slot checks, pay-first flow.
- Anything in the core prompt rules.

## Your calls (correct any of these)

- **Who can edit:** one extra password for the edit page (like the bot-stop password), plus the team member's name on every save for the history. Per-person accounts are a bigger project; see open questions.
- **When changes go live:** immediately or at a chosen date and time. Every save is recorded with who, when, before and after, and any version can be restored with one click.
- **Prices need a second look:** a price change shows a summary first ("Tailored Massage 60 min €130 → €140: menu, booking links and quotes all change") and needs a confirm. Already-sent payment links keep their price, as today.
- **Storage:** Postgres in the bot (`whatsapp-booking-agent`), loaded into memory at startup and after every save, so every read in the bot stays synchronous. Today's code values stay as the fallback, so a missing or empty DB behaves exactly like now.
- **Order:** promotions and opening hours/closures first, because they change most often and carry no money risk. Prices next. Treatments last.

## Architecture

### Bot (`whatsapp-booking-agent`)

**Storage** (`src/data/database.js`, `initialize()`, `CREATE TABLE IF NOT EXISTS`):
- `bot_settings(section text PK, value jsonb, updated_at, updated_by)` holds one row per section: `hours`, `closures`, `prices`, `memberships`, `treatments`, `notices`, `packages`, `contact`, `behaviour`.
- `bot_settings_history(id, section, value jsonb, effective_from, saved_at, saved_by, note)` is append-only. A scheduled change is a history row with a future `effective_from`, and "Restore" re-saves an old row.
- `campaigns(id text PK, …)` has its own table, because campaigns have their own lifetime, images and a send log. `id` can't be changed after creation: changing it would re-send the intro to every guest (`promo_messages_sent` is keyed on it).
- `campaign_images(id, campaign_id, bytes, mime)` stores posters in the DB, because the container filesystem is wiped on every Coolify deploy. They're served on a **public**, unguessable URL (`/public/campaign/<uuid>.jpg`), because WhatsApp fetches media without our token.
- Persist the **global bot pause** here too. Today it's `let botPaused` in `dashboard.routes.js:479` and is lost on every redeploy.

**`src/services/settings.service.js` (new):**
- `load()` runs after `db.initialize()` in `server.js`. After that, it polls every 60 s, so scheduled changes switch on by themselves and a second container would stay in step.
- Exposes synchronous getters: `hours()`, `isClosed(date)`, `activeCampaigns(now)`, `notices(now)`, `contact()`, `behaviour()`.
- `save(section, value, by)`: validates, writes the row and history, then calls `apply()`.
- `apply()` updates memory **in place**: it mutates `PRICE_MAP` keys rather than reassigning, because other modules hold references to it (`dynamic-catalog.service.js:23`, `tool-implementations.js:15`). It then rebuilds the catalog and resets the prompt-body cache.
- Lazy and tolerant: tests that mock `database` with only a few functions keep working with the code defaults.

**Generate instead of hard-code:**
- `dynamic-catalog.service.js`:
  - Turn the module-level `CATALOG` into `rebuildCatalog()`. The three modules that capture it (`system-prompt.js:11`, `input-decoder.js:9`, `tool-implementations.js:21`) call `getCatalog()` instead of holding a copy.
  - Generate the € amounts in `DISPLAY_GROUPS` descriptions from prices. The literal ones are listed in the explorer notes: `:70-252`.
- `system-prompt.js`:
  - Generate the step-1 menu JSON (`:200-222`) from the catalog.
  - Generate the opening hours, closures, notices, active promotions, packages and Passes & Memberships sections from settings.
  - Replace the hard-coded €150 with `behaviour().prepayThreshold`.
  - Delete the expired July promo and the dead `OLD_*` texts.
  - **Layout rule** (`tests/prompt-cache-layout.test.js`): the generated sections go late in the shared body, right before `## Knowledge base`, and never in `## Session`. An edit then costs one round of cache misses and nothing else.
  - Reset `_promptBodyCache` on every `apply()`; its date key alone would keep stale text for up to a day.
- `knowledge-base.json`: remove the facts that move to settings (opening hours, prices, contact, gift-card December deal). `withNewOffering()` disappears in the same step.
- `intro-promo.service.js`: read campaigns from settings.
  - Log each sent promo with its campaign id instead of matching caption text. `isPromoMessage` currently compares exact text, so editing a caption would break the "fresh conversation" check in `renessence.agent.js:130`.
  - Keep the text match for messages sent before the change.

**Guards in code, not only prompt text** (per CLAUDE.md, each with a test):
- Closed day:
  - `check_availability` returns no slots and a `closed` reason with the team's text.
  - `book_appointment` refuses.
- Paused treatment: same treatment as `DISCONTINUED_SESSION_TYPES` (`tool-implementations.js:39`), which becomes settings-driven plus the code list for the permanent removals.
- Day restrictions (`DAY_RESTRICTIONS`, `:27`) become settings-driven, with today's values as defaults.

**Validation** (in the service, used by the save endpoint and by `tests/catalog-prices.test.js`):
- Prices are whole euros, more than 0 and at most €1000, and every bookable session type has a price.
- WhatsApp limits: titles ≤24 characters, descriptions ≤72, captions ≤1024, at most 10 rows per section.
- Campaign end comes after start.
- Hours: open before close.
- Closures can't be in the past.
- The existing `catalog-prices.test.js` checks become a `validateCatalog()` function that runs on the merged data at save time. A bad save is refused with a readable message, never half-applied.

**API** (`src/routes/dashboard.routes.js`, same Bearer auth and hand-written validation style):
- `GET /settings`: all sections, effective values, the defaults, and scheduled changes.
- `POST /settings/:section`: body `{ value, effectiveFrom?, by, editPassword }`.
- `GET /settings/:section/history`.
- `POST /settings/:section/restore/:historyId`.
- `GET|POST /campaigns`, `POST /campaigns/:id`, `POST /campaigns/:id/image` (multipart or base64, ≤2 MB, JPEG/PNG).
- `POST /settings/preview`: renders the generated prompt sections and the WhatsApp menu for a draft, so the page can show "what the bot will say".
- Rate-limited like the rest; `editPassword` is compared timing-safe (new env `SETTINGS_EDIT_PASSWORD`).

### Dashboard (`RENESSENCE-DASHBOARD`)

- New sidebar item "Bot content" (`src/components/sidebar.tsx:18-25`) → `src/app/dashboard/content/page.tsx`.
- Tabs: Promotions · Hours & closures · Prices · Treatments · Notices · Contact & links · Behaviour · History.
- Each tab uses the same pattern:
  - Form → "Preview" (shows the WhatsApp menu or text the bot will use) → "Save now" or "Schedule for…".
  - The edit password is asked once per session.
  - The name is reused from `renessence.teamName` (`conversations/page.tsx:89`).
- Follow the existing inline Tailwind style (`var(--card)`, `var(--border)`, inline confirm panels as in `settings/page.tsx:182-231`).
- Extract three small shared pieces, because six tabs need them: `Field`, `SaveBar` and `HistoryList`.
- Add the API calls to `src/lib/api.ts` in the existing `fetchApi` POST style.
- Read `node_modules/next/dist/docs/` before writing code (`AGENTS.md`).

## Phases (each one shippable on its own)

1. **Foundation + hours/closures/notices/contact.**
   - Settings tables, the service, history/restore, the edit password, and a persisted bot pause.
   - Generated hours, closures, notices and contact sections, plus the closed-day guard.
   - Dashboard tabs: Hours & closures, Notices, Contact, History.
   - Delete the July promo and the dead `OLD_*` text.
   - Fix the Settings page Memory card, which reads `health.memory`; the API no longer sends it.
2. **Promotions.**
   - `campaigns` + images + public image route.
   - The intro message and the bot's promotion section come from campaigns, with send-logging by campaign id.
   - Move the PT promo (ends 1 Nov) and the December gift-card deal into it as data.
3. **Prices + Passes & Memberships + packages + behaviour.**
   - Generated menu, labels and KB prices; runtime `validateCatalog()`; scheduled price changes; the confirm summary.
   - `offering.js` membership text becomes generated from data.
   - Behaviour settings (payment window, €150 threshold, escalation email).
4. **Treatments.**
   - Pause/unpause, rename, description, which days it runs.
   - "Add a treatment": pick a Mindbody session type that isn't in the catalog yet (fetched from Mindbody), then fill in:
     - price
     - payment model (pay online after booking / pay first / pay at reception)
     - duration and room block
     - rooms (from Mindbody resources)
     - start-time grid
     - menu group
   - It stays hidden until a "test booking" passes. The `booking-smoke-test` skill flow becomes a button that books and cancels one real slot.
5. **FAQ answers** (optional): split the knowledge base's free text into topic fields the team can edit.

Rough size:
- Phase 1: 2–3 days.
- Phase 2: about 2 days.
- Phase 3: 3–4 days, the riskiest because of money.
- Phase 4: 4–5 days.
- Phase 5: about 2 days.

## Verification per phase

- **Unit tests** for the settings service:
  - defaults with no DB
  - in-place apply
  - scheduled switch-over (fake timers)
  - restore
  - validation refusals
- **Regression tests named after the incident:**
  - closed day → no slots and booking refused
  - an edited promo caption still counts as a promo
  - a price edit changes the menu, the catalog label and the charged amount together, while an already-sent link keeps its price
- `tests/prompt-cache-layout.test.js` and `tests/catalog-prices.test.js` stay green with edited data, not only defaults.
- **Dashboard:**
  - run against the local bot (`npm run dev`, `NODE_ENV=development`)
  - edit each tab in the built-in browser
  - check that the generated prompt sections change (preview endpoint), and that the webchat answers with the new fact (`/webchat`)
- **After deploy:**
  - `GET /health` (bot) and `/api/version` (dashboard) show the expected commits
  - make one harmless edit (a notice) and ask the live webchat about it

## Open questions only Samuel or the team can answer

1. Is one shared edit password enough, or do you want per-person logins? Per-person logins would put a real name on every change and allow "only managers may change prices", but they are a separate project of about 2 days on the dashboard login.
2. Should price changes go live immediately, or need your approval first? Approval would mean a "pending" state and an email to you.
3. Who on the team will own this page? That decides the wording: Dutch or English labels.

## Phase 1 as built (2026-10-29)

Bot (`whatsapp-booking-agent`, branch `team-editable-content`):
- `bot_settings_history` table (append-only; a future `effective_from` is a scheduled change) and `src/services/settings.service.js` (sync getters, 60 s reload, validation, restore, cancel, stored bot pause). Hand-edited rows that fail validation are skipped; the previous valid version stays in force.
- Prompt: `## Opening hours, closures and notices` section (`src/agents/business-facts.js`) after the knowledge base, before Session. The knowledge base's own opening hours, contact block and address are removed from the prompt; changed email addresses are swapped everywhere in the prompt.
- Guards: closed days and special hours filter `check_availability` and `check_class_schedule`, and refuse `book_appointment` / `book_class` before Mindbody is touched.
- Reminders use the contact address. The expired July promo is gone from the prompt.
- API: `GET /settings`, `POST /settings/check-password`, `POST /settings/preview`, `POST /settings/:section`, `GET /settings/:section/history`, `POST /settings/history/:id/restore|cancel`. Bot stop/start now stored.

Dashboard (`renessence-dashboard`, branch `bot-content-page`): "Bot content" page (Hours & closures, Notices, Contact details, History), unlock with name + edit password, preview, save now / schedule / cancel, restore. Settings page Memory card no longer reads a field the API dropped.

Calls made while building (correct if wrong):
- Weekly opening hours are what the bot *says*; bookable times still come from Mindbody. Only closures and special hours filter slots — filtering on weekly hours could hide real Mindbody slots if the two disagree.
- The bot is told every planned closure up to a year ahead (guests ask about Christmas in November), not just the next 60 days.
- Contact defaults come from the knowledge base; `SPA_PHONE` is ignored so the `.env.example` placeholder can never be quoted to guests.
- Dashboard texts are in English, like the rest of the dashboard.

New env var on the bot: `SETTINGS_EDIT_PASSWORD` (without it, editing is refused).
