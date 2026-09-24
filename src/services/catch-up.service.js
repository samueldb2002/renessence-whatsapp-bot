/**
 * Replay the customer messages the assistant missed.
 *
 * Every inbound message is stored the moment it arrives, so after an outage
 * nobody has to repeat their question: the bot re-runs each unanswered
 * conversation with a short apology and answers what was actually asked.
 *
 * WhatsApp rule that shapes everything here: a free-form message is only
 * delivered within 24h of the customer's LAST message. Anyone older than that
 * can only be reached with a Meta-approved template (business-initiated,
 * paid). So: within the window → replay through the agent; outside it → send
 * the re-engagement template if one is configured, otherwise report them for
 * manual follow-up. Paused (team-handled) and blocked numbers are left alone.
 *
 * Runs automatically when an outage ends (outage-alert.service) and by hand
 * from the dashboard (POST /api/dashboard/outage/catch-up) — e.g. for an
 * outage that happened before this code was deployed.
 */
const db = require('../data/database');
const whatsappService = require('./whatsapp.service');
const outageAlert = require('./outage-alert.service');
const agent = require('../agents/renessence.agent');
const { withUserLock } = require('../utils/user-lock');
const logger = require('../utils/logger');

const FREE_REPLY_WINDOW_MS = 23.5 * 60 * 60 * 1000; // 24h minus a safety margin
const MAX_CUSTOMERS = 100;

function templateFromEnv() {
  if (!process.env.WHATSAPP_CATCHUP_TEMPLATE) return null;
  return {
    name: process.env.WHATSAPP_CATCHUP_TEMPLATE,
    language: process.env.WHATSAPP_CATCHUP_TEMPLATE_LANG || 'en',
    useNameParam: process.env.WHATSAPP_CATCHUP_TEMPLATE_HAS_NAME === 'true',
  };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * @param {object} o
 * @param {string} o.since ISO — start of the missed window
 * @param {string} [o.until] ISO — end of the window (default: now)
 * @param {boolean} [o.dryRun=false] list what WOULD happen, send nothing
 * @param {{name:string,language?:string,useNameParam?:boolean}|null} [o.template]
 *   re-engagement template for customers outside the 24h window (default: env)
 * @param {number} [o.delayMs=2000] pause between replays (rate limits)
 */
async function runCatchUp({ since, until = new Date().toISOString(), dryRun = false, template = undefined, delayMs = 2000 } = {}) {
  const tpl = template === undefined ? templateFromEnv() : template;
  const missed = await db.getUnansweredConversations(since, until, outageAlert.HOLDING_TEXTS);
  const results = { window: { since, until }, dryRun, found: missed.length, answered: [], unreachable: [], templated: [], skipped: [], failed: [] };
  const now = Date.now();

  for (const m of missed.slice(0, MAX_CUSTOMERS)) {
    const entry = {
      phone: m.phone,
      name: m.customer_name || null,
      lastMessageAt: m.last_user_at,
      preview: String(m.content || '').slice(0, 80),
    };
    if (await db.isBlocked(m.phone)) { results.skipped.push({ ...entry, reason: 'blocked number' }); continue; }
    if (await db.isPaused(m.phone)) { results.skipped.push({ ...entry, reason: 'paused — the team is handling this chat' }); continue; }

    const ageMs = now - new Date(m.last_user_at).getTime();
    const hoursAgo = Math.max(1, Math.round(ageMs / 3600000));

    if (ageMs > FREE_REPLY_WINDOW_MS) {
      if (tpl && !dryRun) {
        try {
          await whatsappService.sendTemplate(m.phone, tpl.name, tpl.language || 'en', tpl.useNameParam ? [m.customer_name || 'there'] : []);
          db.logMessage(m.phone, 'assistant', `📨 Re-engagement template "${tpl.name}" sent — the assistant was unavailable when this customer wrote; asked them to send their question again.`);
          results.templated.push(entry);
        } catch (err) {
          results.failed.push({ ...entry, error: `template: ${err.message}` });
        }
      } else {
        results.unreachable.push({ ...entry, hoursAgo });
      }
      continue;
    }

    if (dryRun) { results.answered.push({ ...entry, planned: true }); continue; }
    try {
      await withUserLock(m.phone, () => agent.run(m.phone, m.customer_name || '', m.content, { catchUp: { hoursAgo } }));
      results.answered.push(entry);
      logger.info(`Catch-up: answered ${m.phone} (message from ${hoursAgo}h ago)`);
    } catch (err) {
      results.failed.push({ ...entry, error: err.message });
      logger.error(`Catch-up: failed for ${m.phone}:`, err.message);
    }
    if (delayMs > 0) await sleep(delayMs);
  }
  return results;
}

module.exports = { runCatchUp, FREE_REPLY_WINDOW_MS };
