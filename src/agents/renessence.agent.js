/**
 * Renessence AI Agent
 * Uses OpenAI function calling to handle the entire conversation.
 * The AI decides what to do, which tools to call, and generates all responses.
 */

const OpenAI = require('openai');
const config = require('../config');
const conversationService = require('../services/conversation.service');
const whatsappService = require('../services/whatsapp.service');
const logger = require('../utils/logger');
const { TOOLS } = require('./tool-definitions');
const { buildSystemPrompt } = require('./system-prompt');
const payFirst = require('../services/pay-first.service');
const paymentService = require('../services/payment.service');
const {
  toolCheckAvailability,
  toolLookupClient,
  toolBookAppointment,
  toolSendPayment,
  toolGetAppointments,
  toolCancelAppointments,
  toolCheckClassSchedule,
  toolBookClass,
  toolHumanHandoff,
  toolForwardGiftCard,
  toolCheckGiftCard,
  toolForwardReschedule,
  executeRespond,
  webCallbacks,
  closeUsedConfirmation,
} = require('./tool-implementations');
const { decodeInput } = require('./input-decoder');
const db = require('../data/database');
const outageAlert = require('../services/outage-alert.service');

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

// ---- Main agent runner ----

/**
 * @param {object} [opts]
 * @param {{hoursAgo:number}} [opts.catchUp] Replay of a message the assistant
 *   missed while it was down. The message is already stored (it was saved when
 *   it arrived), so it is not logged again, and the model is told to open with
 *   one short apology before answering it normally.
 */
/**
 * Send a pay-first payment link created in this turn that no reply carried —
 * but only if its booking row is still open (a link closed later in the same
 * turn must never go out).
 */
async function deliverPendingPayFirstLink(from) {
  const pending = conversationService.get(from)?.payFirstLinkPending;
  if (!pending || String(from).startsWith('web_')) return false;
  conversationService.update(from, { payFirstLinkPending: null });
  let row = await db.getBookingEventById(pending.rowId).catch(() => null);
  if (!row) row = await db.getBookingEventById(pending.rowId).catch(() => null);
  // Rows are never deleted: unreadable = DB hiccup → still send. Only a row
  // that was read and is no longer open is withheld.
  if (row && row.status !== 'awaiting_payment') return false;
  conversationService.update(from, { payFirstLinkSentAt: Date.now() });
  await payFirst.sendGuestMessage(from, pending.text, { ctaLabel: pending.ctaLabel, ctaUrl: pending.url });
  return true;
}

async function run(from, name, userMessage, opts = {}) {
  const catchUp = opts.catchUp || null;
  // Ensure conversation state. Taps the handler records (Confirm, cancel,
  // therapist) and server-sent pay-first messages can create a bare in-memory
  // entry before this point — only run() marks a conversation as restored.
  const existing = conversationService.get(from);
  const isNew = !existing || !existing.hydrated;
  let restoredFromDb = false;
  let historyUnavailable = false;
  if (isNew) {
    // The handler may have just recorded a Confirm tap for this very message —
    // set() merges, so that gate survives this initialisation.
    conversationService.set(from, { userName: name, lang: existing?.lang || 'en', hydrated: true });

    // In-memory state lives 30 minutes, but WhatsApp customers routinely reply
    // hours or days later. Bring back what the server-side guards need — the
    // slots this customer was genuinely offered, and their language — so a
    // late "Confirm" books instead of bouncing through re-check/re-confirm
    // rounds (Maria incident). Staleness is safe: Mindbody re-verifies the
    // slot at booking time; the offer list only blocks INVENTED datetimes.
    try {
      const saved = await db.loadConversationState(from);
      if (saved) {
        const nowIso = new Date(Date.now() - 60 * 60 * 1000).toISOString().slice(0, 16);
        const liveOffers = (saved.offeredSlots || []).filter(s => String(s.dateTime).slice(0, 16) >= nowIso);
        conversationService.set(from, {
          ...(liveOffers.length ? { offeredSlots: liveOffers } : {}),
          ...(saved.lang ? { lang: saved.lang } : {}),
        });
      }
    } catch (err) {
      logger.warn(`[${from}] conversation state restore failed:`, err.message);
    }

    // Restore last 10 messages from DB so the bot has context after a
    // server restart or 30-min TTL expiry — prevents random greetings mid-convo.
    // One retry: a swallowed transient DB error here once made the bot greet a
    // customer from scratch right after she tapped "Confirm".
    for (let attempt = 1; attempt <= 2 && !restoredFromDb; attempt++) {
      try {
        const rows = await db.getMessagesByPhone(from, 10, { strict: true });
        if (rows && rows.length > 0) {
          // The DB log is the truth and already holds any server message a
          // bare entry carries: replace instead of appending.
          conversationService.set(from, { messages: [] });
          for (const row of rows) {
            // 'team' messages are from Renessence staff — treat as assistant for OpenAI context
            const role = (row.role === 'agent' || row.role === 'team') ? 'assistant' : row.role;
            conversationService.addMessage(from, role, row.content);
          }
          restoredFromDb = true;
        }
        break;
      } catch (err) {
        logger.warn(`[${from}] history restore attempt ${attempt} failed:`, err.message);
        if (attempt === 2) historyUnavailable = true;
      }
    }
  } else {
    conversationService.update(from, { userName: name });
  }

  // Close a confirmation gate that was used in a PREVIOUS turn. A fresh Confirm
  // tap resets bookingConfirmUsed in the handler, so this never eats a new tap.
  closeUsedConfirmation(from);
  // A pay-first link is only ever delivered in the turn that created it.
  conversationService.update(from, { payFirstLinkPending: null });
  const turnStartedAt = Date.now();

  // The guest's pay-first bookings (awaiting payment / paid / booked) — the
  // model can't see the server's own payment messages otherwise.
  let payFirstStatus = null;
  try { payFirstStatus = await payFirst.statusLine(from); } catch (_) { payFirstStatus = null; }

  // Add user message to history
  // __RESUME__ is an internal trigger — don't log it to DB as a customer message
  const isResumeTrigger = userMessage.startsWith('__RESUME__');
  if (catchUp) {
    // Already in the DB; the restore above normally brought it back as the
    // last history entry. Only add it in memory if it is not there yet.
    const hist = conversationService.getMessages(from);
    const last = hist[hist.length - 1];
    if (!(last && last.role === 'user' && last.content === userMessage)) {
      conversationService.addMessage(from, 'user', userMessage);
    }
  } else {
    conversationService.addMessage(from, 'user', userMessage);
    if (!isResumeTrigger) {
      db.logMessage(from, 'user', userMessage);
    }
  }

  // Build message array for OpenAI.
  // H1: wrap user messages with delimiters so the model knows they are untrusted
  // customer input — the system prompt explains not to follow instructions inside them.
  const rawHistory = conversationService.getMessages(from);
  const history = rawHistory.map(msg =>
    msg.role === 'user'
      ? { ...msg, content: `[USER MESSAGE START]\n${msg.content}\n[USER MESSAGE END]` }
      : msg
  );
  const messages = [
    { role: 'system', content: buildSystemPrompt(from, name, restoredFromDb, historyUnavailable, { payFirstStatus }) },
    ...history,
  ];
  if (catchUp) {
    messages.push({
      role: 'system',
      content: `CATCH-UP: the customer's latest message above was never answered — the assistant was unavailable for about ${catchUp.hoursAgo} hour(s) when it arrived. Begin your reply with ONE short apology for the delay (e.g. "Sorry for the late reply — our assistant was temporarily unavailable."), then handle their message exactly as you normally would. Do NOT ask them to repeat anything you can already read above, and do NOT send the first-message welcome greeting.`,
    });
  }

  const MAX_ITERATIONS = 8;
  let terminated = false;
  // A book_appointment in this turn that did NOT produce a payment link (refused,
  // "replace or both?", payment received…): its explanation must reach the guest
  // next to any link created in the same turn.
  let bookingWithoutLinkThisTurn = false;
  let respondCount = 0;

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

      // A persistent failure (no credits / bad key) is an OUTAGE, not a
      // hiccup: alert the team, tell the customer the truth instead of
      // "please try again", and flag the conversation for a human follow-up.
      // Transient errors keep the plain retry hint.
      let failure = { kind: 'other', notifyCustomer: true, outage: false };
      try { failure = await outageAlert.recordAgentFailure(from, name, err); } catch (_) { /* never mask the real error */ }

      if (failure.outage) db.markConversationEscalated(from, 'Assistant was unavailable — reply by hand');
      // A payment link created earlier in this turn still goes out. On an
      // outage the once-an-hour notice was just claimed for this guest, so it
      // must follow the link (or their next messages go unexplained).
      const linkSent = await deliverPendingPayFirstLink(from);
      if (linkSent && !failure.outage) return; // transient error: the link is the whole reply
      if (failure.outage && !failure.notifyCustomer) return; // told them within the last hour — don't answer every retry
      const errMsg = failure.outage
        ? outageAlert.holdingMessage(lang)
        : (lang === 'nl' ? 'Er ging iets mis. Probeer het opnieuw.' : 'Something went wrong. Please try again.');

      if (from.startsWith('web_') && webCallbacks.has(from)) {
        const resolve = webCallbacks.get(from);
        webCallbacks.delete(from);
        resolve({ message: errMsg, ui_type: 'text' });
      } else {
        await whatsappService.sendText(from, errMsg);
        if (failure.outage) db.logMessage(from, 'assistant', errMsg);
      }
      return;
    }

    // The model answered: if an outage was open, it is over.
    outageAlert.recordAgentSuccess().catch(() => {});

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

    // Execute data/action tools. Read-only tools run in parallel; MUTATING
    // tools (book/cancel/payment/handoff) run SEQUENTIALLY. The model sometimes
    // emits several book_appointment calls in one turn, and running them
    // concurrently against Mindbody produced duplicate bookings / slot races.
    // We also drop exact-duplicate book_appointment calls within the same turn.
    if (otherCalls.length > 0) {
      const READ_ONLY = new Set(['check_availability', 'lookup_client', 'get_appointments', 'check_class_schedule', 'check_gift_card']);

      const runOne = async (tc) => {
        let args;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch (parseErr) {
          logger.error(`Failed to parse tool arguments for ${tc.function.name}:`, tc.function.arguments);
          return { id: tc.id, result: { error: 'Invalid tool arguments — JSON parse failed' } };
        }
        logger.info(`Agent tool: ${tc.function.name}`, JSON.stringify(args).substring(0, 200));
        let result;
        try {
          switch (tc.function.name) {
            case 'check_availability':   result = await toolCheckAvailability(from, args); break;
            case 'lookup_client':        result = await toolLookupClient(from); break;
            case 'book_appointment':     result = await toolBookAppointment(from, args); break;
            case 'get_appointments':     result = await toolGetAppointments(from, args); break;
            case 'cancel_appointments':  result = await toolCancelAppointments(from, args); break;
            case 'check_class_schedule': result = await toolCheckClassSchedule(from, args); break;
            case 'book_class':           result = await toolBookClass(from, args); break;
            case 'send_payment':         result = await toolSendPayment(from, args); break;
            case 'request_human_handoff':result = await toolHumanHandoff(from, name, args); break;
            case 'check_gift_card':      result = toolCheckGiftCard(args); break;
            case 'forward_gift_card_request': result = await toolForwardGiftCard(from, name, args); break;
            case 'forward_reschedule_request': result = await toolForwardReschedule(from, name, args); break;
            default:                     result = { error: `Unknown tool: ${tc.function.name}` };
          }
        } catch (err) {
          logger.error(`Tool ${tc.function.name} threw:`, err.message);
          result = { error: err.message };
        }
        return { id: tc.id, result };
      };

      const readCalls = otherCalls.filter(tc => READ_ONLY.has(tc.function.name));
      const writeCalls = otherCalls.filter(tc => !READ_ONLY.has(tc.function.name));
      const collected = [];

      // Read-only tools: safe to parallelize.
      if (readCalls.length > 0) {
        collected.push(...await Promise.all(readCalls.map(runOne)));
      }

      // Mutating tools: sequential + de-duplicated.
      // Escalation/forward/payment tools only ever need to run ONCE per turn. The
      // model sometimes fires them in a tight loop (one customer generated 8
      // identical escalation emails in 4 seconds before the loop exhausted), so
      // collapse repeats by tool name — the args vary but the spam is the same.
      const ONCE_PER_TURN = new Set([
        'request_human_handoff',
        'forward_gift_card_request',
        'forward_reschedule_request',
        'send_payment',
      ]);
      const seenBookings = new Set();
      const seenOnce = new Set();
      // Orders of 2+ treatments worth €150 or more (people count separately)
      // are arranged by the team. When the model books a whole confirmed
      // order in one turn, decide on the WHOLE order before booking any of it
      // — otherwise the first items get booked and only the last one is
      // refused (or, as with Gina & Nathalie, the rule never fires).
      const turnOrderBlocked = (() => {
        const items = [];
        const seen = new Set();
        for (const tc of writeCalls) {
          if (tc.function.name !== 'book_appointment') continue;
          try {
            const a = JSON.parse(tc.function.arguments);
            const k = `${a.session_type_id}|${a.start_date_time}|${String(a.client_email || a.client_name || '').trim().toLowerCase()}`;
            if (seen.has(k)) continue;
            seen.add(k);
            items.push(paymentService.getPriceInCents(a.session_type_id) || 0);
          } catch (_) { /* ignore */ }
        }
        if (items.length < 2) return null;
        const cart = conversationService.get(from)?.pendingBookings || [];
        const total = items.reduce((s, c) => s + c, 0) + cart.reduce((s, b) => s + (Number(b.amount_cents) || 0), 0);
        if (total < paymentService.JOURNEY_TEAM_THRESHOLD_CENTS) return null;
        const eurTotal = `€${total / 100}`;
        logger.info(`Whole order of ${items.length + cart.length} treatments (${eurTotal}) for ${from} routed to the team before booking`);
        return {
          error: 'journey_needs_team',
          journey_total: eurTotal,
          message: `This order totals ${eurTotal} for ${items.length + cart.length} treatments (every person counts). Orders of €${paymentService.JOURNEY_TEAM_THRESHOLD_CENTS / 100} or more are arranged personally by our team — NOTHING from this order was booked. Tell the customer warmly that our team arranges an order of this size personally, ask for their email if you don't have it, then call request_human_handoff ONCE with a reason that starts with "Order of €${paymentService.JOURNEY_TEAM_THRESHOLD_CENTS / 100}+ — arrange personally" and lists every person, treatment, date and time.`,
        };
      })();
      for (const tc of writeCalls) {
        if (ONCE_PER_TURN.has(tc.function.name)) {
          if (seenOnce.has(tc.function.name)) {
            logger.warn(`Skipping repeated ${tc.function.name} in same turn`);
            collected.push({ id: tc.id, result: { skipped: true, message: `${tc.function.name} already ran in this turn — do NOT call it again. Reply to the customer instead.` } });
            continue;
          }
          seenOnce.add(tc.function.name);
        }
        if (tc.function.name === 'book_appointment') {
          let key = null;
          try {
            const a = JSON.parse(tc.function.arguments);
            // Per PERSON: two guests taking the same treatment at the same time
            // are two bookings (they used to collapse into one).
            const who = String(a.client_email || a.client_name || '').trim().toLowerCase();
            key = `${a.session_type_id}|${a.start_date_time}|${who}`;
          } catch (_) { /* fall through to normal handling */ }
          if (key && seenBookings.has(key)) {
            logger.warn('Skipping duplicate book_appointment in same turn:', key);
            collected.push({ id: tc.id, result: { error: 'duplicate_booking_skipped', message: 'Skipped: this exact call (same treatment, time and person) was already made in this turn. It is NOT an extra booking — report only bookings whose own result shows success.' } });
            continue;
          }
          if (key) seenBookings.add(key);
          if (turnOrderBlocked) {
            collected.push({ id: tc.id, result: turnOrderBlocked });
            continue;
          }
        }
        collected.push(await runOne(tc));
      }

      for (const { id, result } of collected) {
        messages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(result) });
      }
      for (const tc of writeCalls) {
        if (tc.function.name !== 'book_appointment') continue;
        const r = collected.find(c => c.id === tc.id)?.result;
        if (r?.error === 'duplicate_booking_skipped') continue; // same booking as a call that ran
        if (!(r && r.success && r.payFirst)) bookingWithoutLinkThisTurn = true;
      }
    }

    // Execute respond
    if (respondCall) {
      let args;
      try {
        args = JSON.parse(respondCall.function.arguments);
      } catch (parseErr) {
        // Malformed reply: never let it swallow a payment link from this turn.
        if (conversationService.get(from)?.payFirstLinkPending) break;
        throw parseErr;
      }
      logger.info('Agent respond:', args.ui_type, args.message?.substring(0, 80));
      const pend = conversationService.get(from)?.payFirstLinkPending;
      if (bookingWithoutLinkThisTurn && pend && !pend.alsoSendModelText) {
        conversationService.update(from, { payFirstLinkPending: { ...pend, alsoSendModelText: true } });
      }
      await executeRespond(from, args);
      respondCount++;

      // Only allow a second payment CTA if a NEW book_appointment also happened
      // in this same turn. Without a new booking there is nothing to link to,
      // so chaining would just re-send the previous link.
      const hadNewBookingThisTurn = otherCalls.some(tc => tc.function.name === 'book_appointment' || tc.function.name === 'book_class');
      // A pay-first link ends the turn: nothing may follow it.
      const payFirstLinkSentThisTurn = (conversationService.get(from)?.payFirstLinkSentAt || 0) >= turnStartedAt;
      const isChainablePayment = args.ui_type === 'cta_button'
        && !from.startsWith('web_')
        && respondCount < 3
        && hadNewBookingThisTurn
        && !payFirstLinkSentThisTurn;

      const toolResult = { sent: true };

      messages.push({ role: 'tool', tool_call_id: respondCall.id, content: JSON.stringify(toolResult) });

      if (!isChainablePayment) {
        terminated = true;
      }
    }
  }

  // A payment link created this turn that no reply carried: send it anyway.
  if (await deliverPendingPayFirstLink(from)) terminated = true;

  if (!terminated) {
    logger.error('Agent loop exhausted without respond for', from);
    const lang = conversationService.get(from)?.lang || 'en';
    const fallbackMsg = lang === 'nl'
      ? 'Er is geen beschikbaarheid gevonden voor die datum. Probeer een andere dag, of neem contact op via welcome@renessence.com.'
      : 'No availability was found for that date. Try a different day, or reach out to us at welcome@renessence.com.';
    if (from.startsWith('web_') && webCallbacks.has(from)) {
      const resolve = webCallbacks.get(from);
      webCallbacks.delete(from);
      resolve({ message: fallbackMsg, ui_type: 'text' });
    } else {
      await whatsappService.sendText(from, fallbackMsg);
    }
  }
}

// ---- Web chat runner ----

async function runWeb(sessionId, userMessage) {
  const webFrom = `web_${sessionId}`;
  return new Promise(async (resolve) => {
    webCallbacks.set(webFrom, resolve);
    try {
      await run(webFrom, null, userMessage);
    } catch (err) {
      logger.error('runWeb error:', err.message);
    }
    // Safety fallback if callback was never resolved
    if (webCallbacks.has(webFrom)) {
      webCallbacks.delete(webFrom);
      resolve({ message: 'Something went wrong. Please try again.', ui_type: 'text' });
    }
  });
}

/** Cheapest possible model call — used by the outage heartbeat. */
async function pingModel() {
  await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
  });
}

module.exports = {
  deliverPendingPayFirstLink, run, runWeb, decodeInput, pingModel };
