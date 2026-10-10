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
  if (String(phone).startsWith('web_')) return 0;
  let claimed = [];
  try {
    claimed = await db.claimQueuedTeamMessages(phone);
  } catch (err) {
    logger.error('Queued team messages: claim failed:', err.message);
    return 0;
  }
  let sent = 0;
  for (const msg of claimed) {
    try {
      await whatsappService.sendText(phone, msg.content);
      await db.logMessage(phone, 'team', msg.content);
      sent++;
    } catch (err) {
      logger.warn(`Queued team message ${msg.id} to ${phone} failed, will retry on the next guest message:`, err.message);
      await db.releaseQueuedTeamMessage(msg.id).catch(() => {});
    }
  }
  // "Needs reply" stays as it is: the guest's message that re-opened the
  // window is new, and nobody on the team has read it yet.
  if (sent > 0) logger.info(`Delivered ${sent} queued team message(s) to ${phone}`);
  return sent;
}

module.exports = { deliverQueuedTeamMessages };
