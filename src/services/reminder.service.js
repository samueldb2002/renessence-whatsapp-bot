const cron = require('node-cron');
const mindbodyService = require('./mindbody.service');
const whatsappService = require('./whatsapp.service');
const { formatDutchDate, formatDutchTime } = require('../utils/date');
const phone = require('../utils/phone');
const logger = require('../utils/logger');
const config = require('../config');
const conversationService = require('./conversation.service');
const db = require('../data/database');

// Track sent reminders: key = "${appointmentId}_${type}"
const sentReminders = new Map();

function startReminderCron() {
  logger.info('Starting reminder cron (every 15 minutes)');
  cron.schedule('*/15 * * * *', async () => {
    logger.debug('Running reminder check...');
    try {
      await checkAndSendReminders();
    } catch (err) {
      logger.error('Reminder cron error:', err.message);
    }
  });
}

async function checkAndSendReminders() {
  const now = new Date();
  const in25h = new Date(now.getTime() + 37 * 60 * 60 * 1000);

  let appointments;
  try {
    appointments = await mindbodyService.getUpcomingAppointments(now, in25h);
  } catch (err) {
    logger.error('Failed to fetch appointments for reminders:', err.message);
    return;
  }

  for (const apt of appointments) {
    const aptTime = new Date(apt.StartDateTime);
    const hoursUntil = (aptTime - now) / (1000 * 60 * 60);

    // 36-hour reminder (between 35 and 37 hours out)
    if (hoursUntil >= 35 && hoursUntil <= 37) {
      await sendReminderIfNotSent(apt, '24h');
    }

    // 2-hour reminder (between 1.5 and 2.5 hours out)
    if (hoursUntil >= 1.5 && hoursUntil <= 2.5) {
      await sendReminderIfNotSent(apt, '2h');
    }
  }

  cleanupSentReminders();
}

async function sendReminderIfNotSent(appointment, type) {
  const key = `${appointment.Id}_${type}`;
  if (sentReminders.has(key)) return;

  // Fallback to DB check in case server restarted and in-memory map was cleared
  const alreadySent = await db.hasReminderBeenSent(appointment.Id, type);
  if (alreadySent) {
    sentReminders.set(key, Date.now()); // repopulate cache
    return;
  }

  const clientPhone = appointment.Client?.MobilePhone;
  if (!clientPhone) {
    logger.debug(`No phone for appointment ${appointment.Id}, skipping reminder`);
    return;
  }

  const waPhone = phone.toWhatsAppFormat(clientPhone);
  if (!waPhone) return;

  const dateStr = formatDutchDate(appointment.StartDateTime);
  const timeStr = formatDutchTime(appointment.StartDateTime);
  const service = appointment.SessionType?.Name || appointment.Staff?.DisplayName || appointment.Staff?.Name || 'your treatment';

  // Detect language from previous conversation, default to English
  const conv = conversationService.get(waPhone);
  const lang = conv?.lang || 'en';

  let message;
  if (type === '24h') {
    message = lang === 'nl'
      ? `Herinnering: Overmorgen heb je een afspraak voor *${service}* om ${timeStr} op ${dateStr}.\n\n📍 ${config.SPA_ADDRESS}\n\n_Annuleren is gratis tot 24 uur voor aanvang. Bij annulering binnen 24 uur of no-show wordt 100% van de sessiekosten in rekening gebracht._`
      : `Reminder: You have an appointment for *${service}* at ${timeStr} on ${dateStr}.\n\n📍 ${config.SPA_ADDRESS}\n\n_Cancellations are free of charge up to 24 hours before your appointment. Cancellations within 24 hours or no-shows will be charged 100% of the session fee._`;
  } else {
    message = lang === 'nl'
      ? `Over 2 uur begint je afspraak voor *${service}* om ${timeStr}. We zien je graag! 🙏\n\n📍 ${config.SPA_ADDRESS}`
      : `Your appointment for *${service}* starts in 2 hours at ${timeStr}. We look forward to seeing you! 🙏\n\n📍 ${config.SPA_ADDRESS}`;
  }

  try {
    await whatsappService.sendText(waPhone, message);
    sentReminders.set(key, Date.now());
    db.logReminder(appointment.Id, waPhone, type);
    logger.info(`Sent ${type} reminder for appointment ${appointment.Id} to ${waPhone}`);
  } catch (err) {
    logger.error(`Failed to send ${type} reminder for ${appointment.Id}:`, err.message);
  }
}

function cleanupSentReminders() {
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  for (const [key, timestamp] of sentReminders) {
    if (timestamp < cutoff) {
      sentReminders.delete(key);
    }
  }
}

module.exports = { startReminderCron };
