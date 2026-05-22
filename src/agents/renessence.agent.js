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
  executeRespond,
  webCallbacks,
} = require('./tool-implementations');
const { decodeInput } = require('./input-decoder');
const db = require('../data/database');

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

// ---- Main agent runner ----

async function run(from, name, userMessage) {
  // Ensure conversation state
  const isNew = !conversationService.get(from);
  let restoredFromDb = false;
  if (isNew) {
    conversationService.set(from, { userName: name, lang: 'en' });
    // Restore last 10 messages from DB so the bot has context after a
    // server restart or 30-min TTL expiry — prevents random greetings mid-convo
    try {
      const rows = await db.getMessagesByPhone(from, 10);
      if (rows && rows.length > 0) {
        for (const row of rows) {
          // 'team' messages are from Renessence staff — treat as assistant for OpenAI context
          const role = (row.role === 'agent' || row.role === 'team') ? 'assistant' : row.role;
          conversationService.addMessage(from, role, row.content);
        }
        restoredFromDb = true;
      }
    } catch (_) {}
  } else {
    conversationService.update(from, { userName: name });
  }

  // Add user message to history
  // __RESUME__ is an internal trigger — don't log it to DB as a customer message
  const isResumeTrigger = userMessage.startsWith('__RESUME__');
  conversationService.addMessage(from, 'user', userMessage);
  if (!isResumeTrigger) {
    db.logMessage(from, 'user', userMessage);
  }

  // Build message array for OpenAI
  const history = conversationService.getMessages(from);
  const messages = [
    { role: 'system', content: buildSystemPrompt(from, name, restoredFromDb) },
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
      const errMsg = lang === 'nl' ? 'Er ging iets mis. Probeer het opnieuw.' : 'Something went wrong. Please try again.';
      if (from.startsWith('web_') && webCallbacks.has(from)) {
        const resolve = webCallbacks.get(from);
        webCallbacks.delete(from);
        resolve({ message: errMsg, ui_type: 'text' });
      } else {
        await whatsappService.sendText(from, errMsg);
      }
      return;
    }

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

    // Execute data/action tools in parallel
    if (otherCalls.length > 0) {
      const results = await Promise.all(otherCalls.map(async tc => {
        let args;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch (parseErr) {
          logger.error(`Failed to parse tool arguments for ${tc.function.name}:`, tc.function.arguments);
          return { tool_call_id: tc.id, role: 'tool', content: JSON.stringify({ error: 'Invalid tool arguments — JSON parse failed' }) };
        }
        logger.info(`Agent tool: ${tc.function.name}`, JSON.stringify(args).substring(0, 200));
        let result;
        try {
          switch (tc.function.name) {
            case 'check_availability':
              result = await toolCheckAvailability(from, args);
              break;
            case 'lookup_client':
              result = await toolLookupClient(from);
              break;
            case 'book_appointment':
              result = await toolBookAppointment(from, args);
              break;
            case 'get_appointments':
              result = await toolGetAppointments(from, args);
              break;
            case 'cancel_appointments':
              result = await toolCancelAppointments(from, args);
              break;
            case 'check_class_schedule':
              result = await toolCheckClassSchedule(from, args);
              break;
            case 'book_class':
              result = await toolBookClass(from, args);
              break;
            case 'send_payment':
              result = await toolSendPayment(from, args);
              break;
            case 'request_human_handoff':
              result = await toolHumanHandoff(from, name, args);
              break;
            default:
              result = { error: `Unknown tool: ${tc.function.name}` };
          }
        } catch (err) {
          logger.error(`Tool ${tc.function.name} threw:`, err.message);
          result = { error: err.message };
        }
        return { id: tc.id, result };
      }));

      for (const { id, result } of results) {
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

module.exports = { run, runWeb, decodeInput };
