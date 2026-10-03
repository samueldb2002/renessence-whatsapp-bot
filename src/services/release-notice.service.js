/**
 * Releasing an unpaid booking cancels it in Mindbody — and on this site every
 * API cancellation we have logged came back with Status "NoShow" (Angy,
 * Fadoua, Isaac, Reem). For a therapist treatment a no-show can be billable:
 * the therapist gets paid for a booking the customer never paid for, and the
 * team sees "a bot booking with no payment and a no-show". Tell the team the
 * moment it happens so they can change it to a normal cancellation.
 * Fire-and-forget: a notice must never affect the release itself.
 */
const emailService = require('./email.service');
const logger = require('../utils/logger');

const isNoShowStatus = (status) => /^no[\s-]?show$/i.test(String(status || '').trim());

function noticeIfReleasedAsNoShow(releasedAppointment, { appointmentId, row, reason }) {
  if (!isNoShowStatus(releasedAppointment?.Status)) return false;
  logger.warn(`Released unpaid apt ${appointmentId} came back from Mindbody as NoShow — notifying the team`);
  if (typeof emailService.sendReleasedNoShowEmail !== 'function') return true;
  emailService.sendReleasedNoShowEmail({
    appointmentId,
    customerName: row?.customer_name || null,
    customerPhone: row?.phone || null,
    serviceName: row?.service_name || null,
    appointmentDate: row?.appointment_date || null,
    reason,
  }).catch(err => logger.error('Released-no-show email failed:', err.message));
  return true;
}

module.exports = { isNoShowStatus, noticeIfReleasedAsNoShow };
