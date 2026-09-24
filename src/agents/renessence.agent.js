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

async function run(from, name, userMessage) {
  // Ensure conversation state
  const isNew = !conversationService.get(from);
  let restoredFromDb = false;
  let historyUnavailable = false;
  if (isNew) {
    // The handler may have just recorded a Confirm tap for this very message —
    // set() merges, so that gate survives this initialisation.
    conversationService.set(from, { userName: name, lang: 'en' });

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

  // Add user message to history
  // __RESUME__ is an internal trigger — don't log it to DB as a customer message
  const isResumeTrigger = userMessage.startsWith('__RESUME__');
  conversationService.addMessage(from, 'user', userMessage);
  if (!isResumeTrigger) {
    db.logMessage(from, 'user', userMessage);
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
    { role: 'system', content: buildSystemPrompt(from, name, restoredFromDb, historyUnavailable) },
    ...history,
  ];

  const MAX_ITERATIONS = 8;
  let terminated = false;
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

      if (failure.outage) {
        db.markConversationEscalated(from);
        if (!failure.notifyCustomer) return; // told them within the last hour — don't answer every retry
      }
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
            key = `${a.session_type_id}|${a.start_date_time}`;
          } catch (_) { /* fall through to normal handling */ }
          if (key && seenBookings.has(key)) {
            logger.warn('Skipping duplicate book_appointment in same turn:', key);
            collected.push({ id: tc.id, result: { error: 'duplicate_booking_skipped', message: 'This booking was already created in this turn — do not create it again.' } });
            continue;
          }
          if (key) seenBookings.add(key);
        }
        collected.push(await runOne(tc));
      }

      for (const { id, result } of collected) {
        messages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(result) });
      }
    }

    // Execute respond
    if (respondCall) {
      const args = JSON.parse(respondCall.function.arguments);
      logger.info('Agent respond:', args.ui_type, args.message?.substring(0, 80));
      await executeRespond(from, args);
      respondCount++;

      // Only allow a second payment CTA if a NEW book_appointment also happened
      // in this same turn. Without a new booking there is nothing to link to,
      // so chaining would just re-send the previous link.
      const hadNewBookingThisTurn = otherCalls.some(tc => tc.function.name === 'book_appointment' || tc.function.name === 'book_class');
      const isChainablePayment = args.ui_type === 'cta_button'
        && !from.startsWith('web_')
        && respondCount < 3
        && hadNewBookingThisTurn;

      const toolResult = { sent: true };

      messages.push({ role: 'tool', tool_call_id: respondCall.id, content: JSON.stringify(toolResult) });

      if (!isChainablePayment) {
        terminated = true;
      }
    }
  }

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

module.exports = { run, runWeb, decodeInput, pingModel };
