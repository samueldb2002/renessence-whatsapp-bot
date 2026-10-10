/**
 * Delivering team replies that were written after WhatsApp's 24-hour window
 * had closed. The dashboard sends an approved re-open template and parks the
 * reply in queued_team_messages; the moment the guest answers, the window is
 * open again and the parked replies go out here, in order.
 */
const db = require('../data/database');
const whatsappService = require('./whatsapp.service');
const logger = require('../utils/logger');

async function deliverQueuedTeamMessages(phone) {
  if (String(phone).startsWith('web_')) return { sent: 0, failed: false };
  let claimed = [];
  try {
    claimed = await db.claimQueuedTeamMessages(phone);
  } catch (err) {
    logger.error('Queued team messages: claim failed:', err.message);
    return { sent: 0, failed: true };
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
      // of order. This one and everything after it wait for the next message.
      logger.warn(`Queued team message ${msg.id} to ${phone} failed, will retry on the next guest message:`, err.message);
      await db.releaseQueuedTeamMessage(msg.id, true).catch(() => {});
      for (const rest of claimed.slice(i + 1)) await db.releaseQueuedTeamMessage(rest.id, false).catch(() => {});
      return { sent, failed: true };
    }
  }
  // "Needs reply" stays as it is: the guest's message that re-opened the
  // window is new, and nobody on the team has read it yet.
  if (sent > 0) logger.info(`Delivered ${sent} queued team message(s) to ${phone}`);
  return { sent, failed: false };
}

module.exports = { deliverQueuedTeamMessages };
