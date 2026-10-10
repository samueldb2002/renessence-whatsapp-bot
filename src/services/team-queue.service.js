/**
 * Delivering team replies that were written after WhatsApp's 24-hour window
 * had closed. The dashboard sends an approved re-open template and parks the
 * reply in queued_team_messages; the moment the guest answers, the window is
 * open again and the parked replies go out here, strictly in order.
 */
const db = require('../data/database');
const whatsappService = require('./whatsapp.service');
const logger = require('../utils/logger');
const { withSendLock } = require('../utils/user-lock');

/**
 * Send this guest's parked replies, oldest first. Caller must hold the send
 * lock for `phone` (use deliverQueuedTeamMessages unless you already do).
 * @returns {Promise<{sent:number, failed:boolean, error?:string}>}
 */
async function deliverQueuedUnlocked(phone) {
  if (String(phone).startsWith('web_')) return { sent: 0, failed: false };
  let claimed = [];
  try {
    claimed = (await db.claimQueuedTeamMessages(phone)) || [];
  } catch (err) {
    logger.error('Queued team messages: claim failed:', err.message);
    return { sent: 0, failed: true, error: err.message };
  }
  let sent = 0;
  for (let i = 0; i < claimed.length; i++) {
    const msg = claimed[i];
    try {
      await whatsappService.sendText(phone, msg.content);
      await db.logMessage(phone, 'team', msg.content);
      sent++;
    } catch (err) {
      // Stop here: sending later replies before this one would put them out
      // of order. This one and everything after it wait for the next attempt
      // (the guest's next message, or the team's Send now).
      logger.warn(`Queued team message ${msg.id} to ${phone} failed, will retry:`, err.message);
      await db.releaseQueuedTeamMessage(msg.id, true).catch(() => {});
      for (const rest of claimed.slice(i + 1)) await db.releaseQueuedTeamMessage(rest.id, false).catch(() => {});
      // Someone has to look: the reply keeps holding back everything after it.
      await db.flagQueueFailure(phone);
      return { sent, failed: true, error: err.message };
    }
  }
  // "Needs reply" stays as it is: the guest's message that re-opened the
  // window is new, and nobody on the team has read it yet.
  if (sent > 0) {
    logger.info(`Delivered ${sent} queued team message(s) to ${phone}`);
    // An earlier failure flagged the chat; it's resolved now.
    await db.clearQueueFailure(phone);
  }
  return { sent, failed: false };
}

/** Send this guest's parked replies now (takes the per-guest send lock). */
function deliverQueuedTeamMessages(phone) {
  return withSendLock(String(phone), () => deliverQueuedUnlocked(phone));
}

module.exports = { deliverQueuedTeamMessages, deliverQueuedUnlocked };
