const { Langfuse } = require('langfuse');
const logger = require('../utils/logger');

let langfuse = null;

function init() {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_BASE_URL;

  if (!publicKey || !secretKey) {
    logger.warn('Langfuse not configured — set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY');
    return;
  }

  langfuse = new Langfuse({
    publicKey,
    secretKey,
    baseUrl: baseUrl || 'https://cloud.langfuse.com',
  });

  logger.info('Langfuse observability initialized');
}

/**
 * Create a new trace for a conversation message
 */
function createTrace({ userId, sessionId, name, metadata }) {
  if (!langfuse) return null;
  try {
    return langfuse.trace({
      name: name || 'whatsapp-message',
      userId,
      sessionId,
      metadata,
    });
  } catch (err) {
    logger.error('Langfuse createTrace error:', err.message);
    return null;
  }
}

/**
 * Track an LLM generation (OpenAI call)
 */
function trackGeneration(trace, { name, model, input, output, usage, metadata }) {
  if (!trace) return null;
  try {
    return trace.generation({
      name: name || 'openai-completion',
      model,
      input,
      output,
      usage: usage ? {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
      } : undefined,
      metadata,
    });
  } catch (err) {
    logger.error('Langfuse trackGeneration error:', err.message);
    return null;
  }
}

/**
 * Track a span (API call to Mindbody, Stripe, etc.)
 */
function trackSpan(trace, { name, input, output, metadata }) {
  if (!trace) return null;
  try {
    const span = trace.span({
      name,
      input,
      metadata,
    });
    if (output !== undefined) {
      span.end({ output });
    }
    return span;
  } catch (err) {
    logger.error('Langfuse trackSpan error:', err.message);
    return null;
  }
}

/**
 * Score a trace (e.g., intent confidence, booking success)
 */
function score(trace, { name, value, comment }) {
  if (!trace) return;
  try {
    trace.score({
      name,
      value,
      comment,
    });
  } catch (err) {
    logger.error('Langfuse score error:', err.message);
  }
}

/**
 * Track a complete intent detection call
 */
function trackIntentDetection(trace, { userMessage, systemPrompt, result, response }) {
  if (!trace) return;

  const generation = trackGeneration(trace, {
    name: 'detect-intent',
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    input: [
      { role: 'system', content: systemPrompt?.substring(0, 500) + '...' },
      { role: 'user', content: userMessage },
    ],
    output: result,
    usage: response?.usage,
    metadata: {
      intent: result?.intent,
      confidence: result?.confidence,
      detectedLanguage: result?.detectedLanguage,
    },
  });

  // Score the intent confidence
  if (result?.confidence) {
    score(trace, {
      name: 'intent-confidence',
      value: result.confidence,
      comment: `Intent: ${result.intent}`,
    });
  }

  return generation;
}

/**
 * Track a flow intent detection call
 */
function trackFlowIntent(trace, { userMessage, flowContext, result, response }) {
  if (!trace) return;

  trackGeneration(trace, {
    name: 'detect-flow-intent',
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    input: [
      { role: 'context', content: JSON.stringify(flowContext) },
      { role: 'user', content: userMessage },
    ],
    output: result,
    usage: response?.usage,
    metadata: {
      action: result?.action,
      confidence: result?.confidence,
      flowStep: flowContext?.step,
    },
  });
}

/**
 * Flush all pending events (call on shutdown or periodically)
 */
async function flush() {
  if (!langfuse) return;
  try {
    await langfuse.flushAsync();
  } catch (err) {
    logger.error('Langfuse flush error:', err.message);
  }
}

async function shutdown() {
  if (!langfuse) return;
  try {
    await langfuse.shutdownAsync();
  } catch (err) {
    logger.error('Langfuse shutdown error:', err.message);
  }
}

// Initialize on load
init();

module.exports = {
  createTrace,
  trackGeneration,
  trackSpan,
  trackIntentDetection,
  trackFlowIntent,
  score,
  flush,
  shutdown,
};
