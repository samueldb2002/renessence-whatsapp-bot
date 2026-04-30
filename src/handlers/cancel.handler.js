const whatsappService = require('../services/whatsapp.service');
const mindbodyService = require('../services/mindbody.service');
const conversationService = require('../services/conversation.service');
const { FLOW_STEPS } = require('../config/constants');
const { formatDutchDate, formatDutchTime, formatDateISO, addDays } = require('../utils/date');
const logger = require('../utils/logger');
const db = require('../data/database');

function getLang(from) {
  return conversationService.get(from)?.lang || 'en';
}

function treatmentName(apt) {
  return apt.SessionType?.Name || apt.Staff?.DisplayName || apt.Staff?.Name || 'Treatment';
}

function isWithin24Hours(dateTimeStr) {
  const aptTime = new Date(dateTimeStr);
  const now = new Date();
  const hoursUntil = (aptTime - now) / (1000 * 60 * 60);
  return hoursUntil < 24 && hoursUntil > 0;
}

function getLateWarning(lang, dateStr, timeStr, serviceName) {
  return lang === 'nl'
    ? `⚠️ *Let op: Late annulering*\n\nJe afspraak voor ${serviceName} is op ${dateStr}. Annuleringen binnen 24 uur voor de afspraak worden voor 100% in rekening gebracht.\n\nWeet je zeker dat je wilt annuleren?`
    : `⚠️ *Warning: Late cancellation*\n\nYour appointment for ${serviceName} is on ${dateStr}. Cancellations within 24 hours of the appointment will be charged at 100%.\n\nAre you sure you want to cancel?`;
}

async function start(from, name) {
  const lang = getLang(from);
  conversationService.startFlow(from, 'cancel', { userName: name });

  try {
    // Find ALL clients linked to this phone number
    const clients = await mindbodyService.getAllClientsByPhone(from);
    if (!clients || clients.length === 0) {
      conversationService.clearFlow(from);
      return whatsappService.sendText(from, lang === 'nl'
        ? 'Ik kan geen afspraken vinden voor dit telefoonnummer.'
        : "I couldn't find any appointments for this phone number.");
    }

    const today = formatDateISO(new Date());
    const futureDate = formatDateISO(addDays(new Date(), 90));

    let appointments = [];
    for (const client of clients) {
      const appts = await mindbodyService.getStaffAppointments(today, futureDate, client.Id);
      appointments = appointments.concat(appts);
    }
    appointments.sort((a, b) => new Date(a.StartDateTime) - new Date(b.StartDateTime));

    if (appointments.length === 0) {
      conversationService.clearFlow(from);
      return whatsappService.sendText(from, lang === 'nl'
        ? 'Je hebt geen aankomende afspraken om te annuleren.'
        : "You don't have any upcoming appointments to cancel.");
    }

    if (appointments.length === 1) {
      const apt = appointments[0];
      conversationService.update(from, {
        flowStep: FLOW_STEPS.CONFIRM_CANCEL,
        flowData: {
          appointmentId: apt.Id,
          serviceName: treatmentName(apt),
          dateTime: apt.StartDateTime,
        },
      });

      const dateStr = formatDutchDate(apt.StartDateTime);
      const timeStr = formatDutchTime(apt.StartDateTime);
      const atWord = lang === 'nl' ? 'om' : 'at';
      const lateCancel = isWithin24Hours(apt.StartDateTime);

      const message = lateCancel
        ? getLateWarning(lang, dateStr, timeStr, treatmentName(apt))
        : (lang === 'nl'
          ? `Wil je deze afspraak annuleren?\n\n${treatmentName(apt)}\n${dateStr} ${atWord} ${timeStr}`
          : `Would you like to cancel this appointment?\n\n${treatmentName(apt)}\n${dateStr} ${atWord} ${timeStr}`);

      return whatsappService.sendButtons(from, message, [
        { id: 'cancel_confirm', title: lang === 'nl' ? 'Ja, annuleren' : 'Yes, cancel' },
        { id: 'cancel_no', title: lang === 'nl' ? 'Nee, behouden' : 'No, keep it' },
      ]);
    }

    // Multiple appointments - show list with "Cancel all" option
    const aptRows = appointments.slice(0, 9).map((apt) => ({
      id: `cancel_apt_${apt.Id}`,
      title: treatmentName(apt).substring(0, 24),
      description: `${formatDutchDate(apt.StartDateTime)} ${formatDutchTime(apt.StartDateTime)}`,
    }));

    const cancelAllRow = {
      id: 'cancel_all',
      title: lang === 'nl' ? 'Alles annuleren' : 'Cancel all',
      description: lang === 'nl' ? `Alle ${appointments.length} afspraken` : `All ${appointments.length} appointments`,
    };

    const rows = [cancelAllRow, ...aptRows];

    conversationService.update(from, {
      flowStep: FLOW_STEPS.SELECT_APPOINTMENT,
      flowData: { appointments },
    });

    return whatsappService.sendList(
      from,
      lang === 'nl' ? 'Welke afspraak wil je annuleren?' : 'Which appointment would you like to cancel?',
      lang === 'nl' ? 'Afspraken' : 'Appointments',
      [{ title: lang === 'nl' ? 'Je afspraken' : 'Your appointments', rows }]
    );
  } catch (err) {
    logger.error('Cancel start error:', err.message);
    conversationService.clearFlow(from);
    return whatsappService.sendText(from, lang === 'nl' ? 'Er ging iets mis. Probeer het later opnieuw.' : 'Something went wrong. Please try again later.');
  }
}

async function cont(from, userInput, conversation) {
  const lang = getLang(from);
  const step = conversation.flowStep;

  if (step === FLOW_STEPS.SELECT_APPOINTMENT) {
    const allKeywords = ['both', 'allebei', 'all', 'allemaal', 'alle', 'alles', 'beiden', 'alle twee', 'alle 2', 'cancel all', 'alles annuleren', 'alle afspraken'];
    const isAllRequest = userInput === 'cancel_all' ||
      allKeywords.some((w) => userInput.toLowerCase().trim() === w || userInput.toLowerCase().includes(w));

    if (isAllRequest) {
      const appointments = conversation.flowData.appointments;
      const hasLateCancel = appointments.some((apt) => isWithin24Hours(apt.StartDateTime));
      const atWord = lang === 'nl' ? 'om' : 'at';
      const apptList = appointments
        .map((apt) => `• ${treatmentName(apt)}: ${formatDutchDate(apt.StartDateTime)} ${atWord} ${formatDutchTime(apt.StartDateTime)}`)
        .join('\n');

      conversationService.update(from, {
        flowStep: FLOW_STEPS.CONFIRM_CANCEL,
        flowData: { ...conversation.flowData, cancelAll: true },
      });

      let message;
      if (hasLateCancel) {
        message = lang === 'nl'
          ? `⚠️ *Let op: Late annulering*\n\nEen of meer afspraken vallen binnen 24 uur. Annuleringen binnen 24 uur worden voor 100% in rekening gebracht.\n\nWil je alle ${appointments.length} afspraken annuleren?\n\n${apptList}`
          : `⚠️ *Warning: Late cancellation*\n\nOne or more appointments are within 24 hours. Cancellations within 24 hours will be charged at 100%.\n\nDo you want to cancel all ${appointments.length} appointments?\n\n${apptList}`;
      } else {
        message = lang === 'nl'
          ? `Wil je alle ${appointments.length} afspraken annuleren?\n\n${apptList}`
          : `Do you want to cancel all ${appointments.length} appointments?\n\n${apptList}`;
      }

      return whatsappService.sendButtons(from, message, [
        { id: 'cancel_confirm', title: lang === 'nl' ? 'Ja, alles annuleren' : 'Yes, cancel all' },
        { id: 'cancel_no', title: lang === 'nl' ? 'Nee, behouden' : 'No, keep them' },
      ]);
    }

    const aptId = userInput.replace('cancel_apt_', '');
    const apt = conversation.flowData.appointments.find((a) => String(a.Id) === aptId);

    if (!apt) {
      // Re-show the list so the user can pick
      const appointments = conversation.flowData.appointments;
      const aptRows = appointments.slice(0, 9).map((a) => ({
        id: `cancel_apt_${a.Id}`,
        title: treatmentName(a).substring(0, 24),
        description: `${formatDutchDate(a.StartDateTime)} ${formatDutchTime(a.StartDateTime)}`,
      }));
      const cancelAllRow = {
        id: 'cancel_all',
        title: lang === 'nl' ? 'Alles annuleren' : 'Cancel all',
        description: lang === 'nl' ? `Alle ${appointments.length} afspraken` : `All ${appointments.length} appointments`,
      };
      return whatsappService.sendList(
        from,
        lang === 'nl' ? 'Kies een afspraak uit de lijst:' : 'Please choose an appointment from the list:',
        lang === 'nl' ? 'Afspraken' : 'Appointments',
        [{ title: lang === 'nl' ? 'Je afspraken' : 'Your appointments', rows: [cancelAllRow, ...aptRows] }]
      );
    }

    conversationService.update(from, {
      flowStep: FLOW_STEPS.CONFIRM_CANCEL,
      flowData: {
        appointmentId: apt.Id,
        serviceName: treatmentName(apt),
        dateTime: apt.StartDateTime,
        appointments: conversation.flowData.appointments,
      },
    });

    const dateStr = formatDutchDate(apt.StartDateTime);
    const timeStr = formatDutchTime(apt.StartDateTime);
    const atWord = lang === 'nl' ? 'om' : 'at';
    const lateCancel = isWithin24Hours(apt.StartDateTime);

    const message = lateCancel
      ? getLateWarning(lang, dateStr, timeStr, treatmentName(apt))
      : (lang === 'nl'
        ? `Wil je deze afspraak annuleren?\n\n${treatmentName(apt)}\n${dateStr} ${atWord} ${timeStr}`
        : `Would you like to cancel this appointment?\n\n${treatmentName(apt)}\n${dateStr} ${atWord} ${timeStr}`);

    return whatsappService.sendButtons(from, message, [
      { id: 'cancel_confirm', title: lang === 'nl' ? 'Ja, annuleren' : 'Yes, cancel' },
      { id: 'cancel_no', title: lang === 'nl' ? 'Nee, behouden' : 'No, keep it' },
    ]);
  }

  if (step === FLOW_STEPS.CONFIRM_CANCEL) {
    if (userInput === 'cancel_no') {
      conversationService.clearFlow(from);
      return whatsappService.sendText(from, lang === 'nl' ? 'Je afspraak blijft staan. Tot dan!' : 'Your appointment is kept. See you then!');
    }

    if (userInput === 'cancel_confirm') {
      try {
        // Bulk cancel — user said "both" / "all"
        if (conversation.flowData.cancelAll) {
          const appointments = conversation.flowData.appointments;
          const failed = [];
          let cancelledCount = 0;

          for (const apt of appointments) {
            try {
              await mindbodyService.cancelAppointment(apt.Id);
              cancelledCount++;
              db.query(
                `UPDATE booking_events SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = 'customer' WHERE mindbody_appointment_id = $1`,
                [apt.Id]
              ).catch((err) => logger.error('DB cancel log error:', err.message));
            } catch (err) {
              logger.error(`Failed to cancel appointment ${apt.Id}:`, err.message);
              failed.push(treatmentName(apt));
            }
          }

          conversationService.clearFlow(from);

          if (failed.length > 0) {
            const errMsg = lang === 'nl'
              ? `${cancelledCount} afspraak/afspraken geannuleerd. Kon de volgende afspraken niet annuleren: ${failed.join(', ')}. Neem contact op via welcome@renessence.com.`
              : `${cancelledCount} appointment(s) cancelled. Could not cancel: ${failed.join(', ')}. Please contact us at welcome@renessence.com.`;
            return whatsappService.sendText(from, errMsg);
          }

          const successMsg = lang === 'nl'
            ? `Alle ${cancelledCount} afspraken zijn geannuleerd. ✅`
            : `All ${cancelledCount} appointments have been cancelled. ✅`;
          return whatsappService.sendButtons(from, successMsg, [
            { id: 'menu_book', title: lang === 'nl' ? 'Opnieuw boeken' : 'Book again' },
            { id: 'menu_info', title: lang === 'nl' ? 'Informatie' : 'Information' },
          ]);
        }

        // Single appointment cancel
        const { appointmentId, serviceName, dateTime } = conversation.flowData;
        const dateStr = formatDutchDate(dateTime);

        // Actually cancel in Mindbody
        await mindbodyService.cancelAppointment(appointmentId);

        // Log cancellation to DB
        db.query(
          `UPDATE booking_events SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = 'customer' WHERE mindbody_appointment_id = $1`,
          [appointmentId]
        ).catch(err => logger.error('DB cancel log error:', err.message));

        conversationService.clearFlow(from);
        const cancelMsg = lang === 'nl'
          ? `Je afspraak voor ${serviceName} op ${dateStr} is geannuleerd.`
          : `Your appointment for ${serviceName} on ${dateStr} has been cancelled.`;
        return whatsappService.sendButtons(from, cancelMsg, [
          { id: 'menu_book', title: lang === 'nl' ? 'Opnieuw boeken' : 'Book again' },
          { id: 'menu_info', title: lang === 'nl' ? 'Informatie' : 'Information' },
        ]);
      } catch (err) {
        logger.error('Cancel error:', err.message);
        conversationService.clearFlow(from);
        return whatsappService.sendText(from, lang === 'nl' ? 'Er ging iets mis bij het annuleren.' : 'Something went wrong while cancelling.');
      }
    }
  }

  return whatsappService.sendText(from, lang === 'nl' ? 'Wil je een afspraak annuleren?' : 'Would you like to cancel an appointment?');
}

module.exports = { start, continue: cont };
