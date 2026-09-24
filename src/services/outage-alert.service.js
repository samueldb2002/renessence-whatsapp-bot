/**
 * Assistant outage detection + alerting.
 *
 * On 23 Sept 2026 the OpenAI prepaid balance ran out at 16:18 and every
 * customer message for the next 26 hours got "Something went wrong. Please try
 * again." — nobody was told, customers kept retrying, and the team found out
 * from the server logs. This module turns a PERSISTENT model failure (no
 * credits, invalid key) into: one alert email straight away, a reminder at
 * most once an hour while it lasts, a recovery email when the first call
 * succeeds again, an honest holding message to each affected customer (once
 * per customer per hour, not on every retry), and a status line on /health.
 *
 * Transient errors (rate limits, timeouts, 5xx) keep the old behaviour — a
 * single retry hint — and never raise an outage.
 */
const logger = require('../utils/logger');
const emailService = require('./email.service');

const ALERT_COOLDOWN_MS = 60 * 60 * 1000;          // reminder email at most hourly
const CUSTOMER_NOTICE_COOLDOWN_MS = 60 * 60 * 1000; // holding message once per customer per hour

const state = {
  since: null,        // first failure of the current outage
  kind: null,         // 'billing' | 'auth'
  lastError: null,
  count: 0,
  affected: new Map(), // phone -> { name, firstAt, lastAt, notifiedAt }
  lastAlertAt: 0,
};

/**
 * 'billing' = out of credits / quota (persistent until someone tops up)
 * 'auth'    = key rejected (persistent until someone fixes the env)
 * 'rate_limit' / 'other' = transient, handled the old way.
 */
function classifyOpenAIError(err) {
  const status = err?.status ?? err?.response?.status;
  const code = err?.code || err?.error?.code || err?.error?.error?.code;
  const msg = String(err?.message || '');
  if (code === 'insufficient_quota' || (status === 429 && /credit|quota|billing/i.test(msg))) return 'billing';
  if (status === 401 || code === 'invalid_api_key') return 'auth';
  if (status === 429) return 'rate_limit';
  return 'other';
}

const fmt = (ms) => new Date(ms).toLocaleString('en-GB', { timeZone: 'Europe/Amsterdam' });
const escape = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function affectedRowsHtml() {
  const rows = [...state.affected.entries()]
    .sort((a, b) => b[1].lastAt - a[1].lastAt)
    .map(([phone, a]) => `<tr><td style="padding:4px 8px;">${escape(a.name || '—')}</td><td style="padding:4px 8px;">+${escape(phone)}</td><td style="padding:4px 8px;">${fmt(a.lastAt)}</td></tr>`)
    .join('');
  return `<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;"><tr><th align="left" style="padding:4px 8px;">Customer</th><th align="left" style="padding:4px 8px;">Phone</th><th align="left" style="padding:4px 8px;">Last message</th></tr>${rows}</table>`;
}

async function sendOutageAlert(isReminder) {
  const cause = state.kind === 'billing'
    ? 'The OpenAI account has no credits left (HTTP 429 "no credits remaining").'
    : 'OpenAI rejects the API key (HTTP 401).';
  const fix = state.kind === 'billing'
    ? 'Add credits at https://platform.openai.com/settings/organization/billing/ and enable auto-recharge so this cannot happen again.'
    : 'Check OPENAI_API_KEY in the server environment (Coolify) and redeploy.';
  const subject = `${isReminder ? '⏰ STILL DOWN' : '🚨 BOT DOWN'} — WhatsApp assistant cannot answer customers (${state.kind})`;
  const html = `
    <h2 style="color:#C43E3E;">The WhatsApp assistant is not answering customers</h2>
    <p><b>Since:</b> ${fmt(state.since)} (Amsterdam) &nbsp;·&nbsp; <b>Failed replies:</b> ${state.count} &nbsp;·&nbsp; <b>Customers affected:</b> ${state.affected.size}</p>
    <p><b>Cause:</b> ${escape(cause)}</p>
    <p><b>Fix:</b> ${escape(fix)} Nothing needs to be deployed — the bot recovers by itself as soon as the API works again.</p>
    <p>Each customer below received a short message that our assistant is temporarily unavailable and that the team will get back to them here. <b>Please reply to them from the dashboard</b> — WhatsApp only allows free replies within 24 hours of their last message.</p>
    ${affectedRowsHtml()}
    <p style="color:#666;font-size:12px;">Last error: ${escape(state.lastError)}</p>`;
  await emailService.sendOpsAlertEmail({ subject, html });
}

async function sendRecoveryAlert(durationMs, affectedCount, failedCount) {
  const hours = (durationMs / 3600000).toFixed(1);
  const subject = `✅ BOT BACK — WhatsApp assistant answering again (down ${hours}h, ${affectedCount} customers affected)`;
  const html = `
    <h2 style="color:#2E7D32;">The WhatsApp assistant is answering customers again</h2>
    <p><b>Outage:</b> ${fmt(state.since)} → ${fmt(Date.now())} (Amsterdam), about ${hours} hours. <b>Failed replies:</b> ${failedCount}. <b>Customers affected:</b> ${affectedCount}.</p>
    <p>The customers below were told the assistant was unavailable and that the team would get back to them. Their messages are in the dashboard; the bot does NOT re-answer old messages, so please follow up with anyone who has not been helped yet (free replies only work within 24h of their last message).</p>
    ${affectedRowsHtml()}`;
  await emailService.sendOpsAlertEmail({ subject, html });
}

/**
 * Called from the agent's catch block. Returns the classification so the
 * caller can pick the customer message; for a persistent outage it records
 * the customer, alerts the team (first time immediately, then hourly) and says
 * whether this customer should receive the holding message now.
 */
async function recordAgentFailure(from, name, err) {
  const kind = classifyOpenAIError(err);
  if (kind !== 'billing' && kind !== 'auth') return { kind, notifyCustomer: true, outage: false };

  const now = Date.now();
  if (!state.since) {
    state.since = now;
    logger.error(`ASSISTANT OUTAGE started (${kind}): ${err?.message}`);
  }
  state.kind = kind;
  state.lastError = err?.message || String(err);
  state.count += 1;

  const entry = state.affected.get(from) || { name, firstAt: now, lastAt: now, notifiedAt: 0 };
  entry.name = name || entry.name;
  entry.lastAt = now;
  const notifyCustomer = now - entry.notifiedAt >= CUSTOMER_NOTICE_COOLDOWN_MS;
  if (notifyCustomer) entry.notifiedAt = now;
  state.affected.set(from, entry);

  if (now - state.lastAlertAt >= ALERT_COOLDOWN_MS) {
    const isReminder = state.lastAlertAt !== 0;
    state.lastAlertAt = now;
    try {
      await sendOutageAlert(isReminder);
    } catch (mailErr) {
      logger.error('Outage alert email failed:', mailErr.message);
      state.lastAlertAt = 0; // try again on the next failure
    }
  }
  return { kind, notifyCustomer, outage: true };
}

/** Called after any successful model call. Ends an outage, if one was open. */
async function recordAgentSuccess() {
  if (!state.since) return;
  const durationMs = Date.now() - state.since;
  const affectedCount = state.affected.size;
  const failedCount = state.count;
  logger.info(`ASSISTANT OUTAGE ended after ${(durationMs / 60000).toFixed(0)} min — ${affectedCount} customers affected`);
  try {
    await sendRecoveryAlert(durationMs, affectedCount, failedCount);
  } catch (mailErr) {
    logger.error('Outage recovery email failed:', mailErr.message);
  }
  state.since = null; state.kind = null; state.lastError = null;
  state.count = 0; state.affected = new Map(); state.lastAlertAt = 0;
}

/** For /health: null when fine, otherwise a small status object. */
function getOutageStatus() {
  if (!state.since) return null;
  return {
    status: 'down',
    kind: state.kind,
    since: new Date(state.since).toISOString(),
    failedReplies: state.count,
    customersAffected: state.affected.size,
    lastError: state.lastError,
  };
}

/** The honest customer-facing message during an outage. */
function holdingMessage(lang) {
  return lang === 'nl'
    ? 'Onze assistent is op dit moment tijdelijk niet beschikbaar. Ons team ziet je bericht en komt hier bij je terug. Wil je sneller antwoord, mail dan naar welcome@renessence.com. Excuses voor het ongemak! 🌿'
    : 'Our assistant is temporarily unavailable right now. Our team can see your message and will get back to you here. For a faster reply, email welcome@renessence.com. Sorry for the inconvenience! 🌿';
}

/** Test hook. */
function _reset() {
  state.since = null; state.kind = null; state.lastError = null;
  state.count = 0; state.affected = new Map(); state.lastAlertAt = 0;
}

module.exports = { classifyOpenAIError, recordAgentFailure, recordAgentSuccess, getOutageStatus, holdingMessage, _reset };
