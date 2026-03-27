const OpenAI = require('openai');
const config = require('../config');
const { buildSystemPrompt } = require('../config/constants');
const logger = require('../utils/logger');
const langfuse = require('./langfuse.service');
const fs = require('fs');
const path = require('path');

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

// Load services list for the system prompt
function getServicesList() {
  try {
    const servicesPath = path.join(__dirname, '../data/services.json');
    const services = JSON.parse(fs.readFileSync(servicesPath, 'utf-8'));
    if (services.length === 0) return null;
    return services
      .map((s) => `- ${s.Name} (${s.DefaultTimeLength} min) - EUR ${s.Price || 'n.v.t.'}`)
      .join('\n');
  } catch {
    return null;
  }
}

async function detectIntent(userMessage, userName, trace) {
  const servicesList = getServicesList();
  const systemPrompt = buildSystemPrompt(servicesList);

  try {
    const response = await openai.chat.completions.create({
      model: config.OPENAI_MODEL,
      max_tokens: 1024,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Customer "${userName}" says: "${userMessage}"` },
      ],
    });

    const text = response.choices[0].message.content;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('OpenAI returned non-JSON response:', text);
      return { intent: 'unknown', confidence: 0, entities: {}, faqTopic: null, freeformAnswer: null };
    }

    const result = JSON.parse(jsonMatch[0]);

    // Track in Langfuse
    langfuse.trackIntentDetection(trace, {
      userMessage,
      systemPrompt,
      result,
      response,
    });

    return result;
  } catch (err) {
    logger.error('OpenAI API error:', err.message);
    return { intent: 'unknown', confidence: 0, entities: {}, faqTopic: null, freeformAnswer: null };
  }
}

/**
 * Flow-aware intent detection: GPT-4o understands the current booking step
 * and decides what the user wants to do (continue flow, change something, break out, etc.)
 */
async function detectFlowIntent(userMessage, userName, flowContext, trace) {
  const flowPrompt = `You are the WhatsApp assistant for Renessence, a premium wellness centre in Amsterdam.

The customer is currently in the middle of a booking flow. Here is the current context:
- Current step: ${flowContext.step}
- Selected treatment: ${flowContext.serviceName || 'not yet selected'}
- Selected date: ${flowContext.date || 'not yet selected'}
- Selected time: ${flowContext.time || 'not yet selected'}
- Customer name on booking: ${flowContext.clientName || 'not yet provided'}
- Customer email: ${flowContext.clientEmail || 'not yet provided'}

Based on what the customer says, determine what they want to do. Respond in JSON:

{
  "action": "<one of the actions below>",
  "confidence": <0-1>,
  "value": "<extracted value if applicable, otherwise null>",
  "detectedLanguage": "<en or nl>"
}

Possible actions:
- "continue_flow" — the customer is answering the current step's question (providing a name, email, date, time, etc.). Put the extracted answer in "value".
- "change_name" — the customer wants to change/correct the name on the booking
- "change_date" — the customer wants to pick a different date. Put the parsed date in "value" if mentioned.
- "change_time" — the customer wants to pick a different time slot
- "change_treatment" — the customer wants to switch to a different treatment. Put the treatment name in "value".
- "want_info" — the customer wants information/FAQ, not booking
- "cancel_flow" — the customer wants to stop/cancel the current booking process
- "confirm" — the customer confirms/agrees
- "decline" — the customer says no/declines
- "greeting" — the customer is greeting (hi, hello, hey)
- "human_handoff" — the customer wants to speak to a real person
- "other" — something else entirely, provide a helpful response in "value"

Important rules:
- If the step is "collect_name" and the user provides a name, action should be "continue_flow" with the name in "value"
- If the step is "collect_email" and the user provides an email, action should be "continue_flow" with the email in "value"
- If the step is "confirm" and the user says yes/ok/ja/bevestigen, action should be "confirm"
- If the step is "confirm" and the user says no/nee/cancel, action should be "decline"
- If the step is "confirm" and the user says "other name" or "andere naam" or wants to change details, action should be "change_name"
- If the user mentions a treatment name (sauna, float, massage, etc.) and it's different from the current one, action should be "change_treatment"
- If the user mentions a day/date (monday, tomorrow, 5th of april, etc.), action should be "change_date"
- "informatie", "information", "info", "openingstijden", "prices" → action should be "want_info"
- "stop", "cancel", "terug", "reset" → action should be "cancel_flow"

Today's date: ${new Date().toISOString().split('T')[0]}`;

  try {
    const response = await openai.chat.completions.create({
      model: config.OPENAI_MODEL,
      max_tokens: 512,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: flowPrompt },
        { role: 'user', content: `Customer "${userName}" says: "${userMessage}"` },
      ],
    });

    const text = response.choices[0].message.content;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('OpenAI flow intent returned non-JSON:', text);
      return { action: 'continue_flow', confidence: 0.5, value: userMessage, detectedLanguage: 'en' };
    }

    const result = JSON.parse(jsonMatch[0]);
    logger.debug('Flow intent result:', JSON.stringify(result));

    // Track in Langfuse
    langfuse.trackFlowIntent(trace, {
      userMessage,
      flowContext,
      result,
      response,
    });

    return result;
  } catch (err) {
    logger.error('OpenAI flow intent error:', err.message);
    // Fallback: treat as flow continuation
    return { action: 'continue_flow', confidence: 0.5, value: userMessage, detectedLanguage: 'en' };
  }
}

module.exports = { detectIntent, detectFlowIntent };
