const whatsappService = require('../services/whatsapp.service');
const mindbodyService = require('../services/mindbody.service');
const conversationService = require('../services/conversation.service');
const { FLOW_STEPS } = require('../config/constants');
const { formatDutchDate, formatDutchTime, formatDateISO, addDays, parseFreeTextDate } = require('../utils/date');
const logger = require('../utils/logger');

function getLang(from) {
  return conversationService.get(from)?.lang || 'en';
}

function treatmentName(apt) {
  return apt.SessionType?.Name || apt.Staff?.DisplayName || apt.Staff?.Name || 'Treatment';
}

async function start(from, name) {
  const lang = getLang(from);
  conversationService.startFlow(from, 'reschedule', { userName: name });

  try {
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
        ? 'Je hebt geen aankomende afspraken om te wijzigen.'
        : "You don't have any upcoming appointments to reschedule.");
    }

    if (appointments.length === 1) {
      return selectAppointmentForReschedule(from, appointments[0]);
    }

    const rows = appointments.slice(0, 10).map((apt) => ({
      id: `resc_apt_${apt.Id}`,
      title: treatmentName(apt),
      description: `${formatDutchDate(apt.StartDateTime)} ${formatDutchTime(apt.StartDateTime)}`,
    }));

    conversationService.update(from, {
      flowStep: FLOW_STEPS.SELECT_APPOINTMENT,
      flowData: { appointments },
    });

    return whatsappService.sendList(
      from,
      lang === 'nl' ? 'Welke afspraak wil je wijzigen?' : 'Which appointment would you like to reschedule?',
      lang === 'nl' ? 'Afspraken' : 'Appointments',
      [{ title: lang === 'nl' ? 'Je afspraken' : 'Your appointments', rows }]
    );
  } catch (err) {
    logger.error('Reschedule start error:', err.message);
    conversationService.clearFlow(from);
    return whatsappService.sendText(from, lang === 'nl' ? 'Er ging iets mis. Probeer het later opnieuw.' : 'Something went wrong. Please try again later.');
  }
}

function selectAppointmentForReschedule(from, apt) {
  const lang = getLang(from);
  const sessionTypeId = apt.SessionType?.Id || apt.Staff?.Id;

  // Try to find the session type ID from the staff appointment
  // Staff appointments don't always have SessionType, so we need the staffId to look up bookable items
  conversationService.update(from, {
    flowStep: FLOW_STEPS.SELECT_NEW_DATE,
    flowData: {
      appointmentId: apt.Id,
      serviceId: apt.SessionTypeId || sessionTypeId,
      serviceName: treatmentName(apt),
      originalDateTime: apt.StartDateTime,
      staffId: apt.StaffId || apt.Staff?.Id,
      clientId: apt.ClientId,
    },
  });

  const dateStr = formatDutchDate(apt.StartDateTime);
  const timeStr = formatDutchTime(apt.StartDateTime);
  const today = new Date();
  const tomorrow = addDays(today, 1);
  const atWord = lang === 'nl' ? 'om' : 'at';

  const msg = lang === 'nl'
    ? `Je afspraak voor *${treatmentName(apt)}* op ${dateStr} ${atWord} ${timeStr}.\n\nNaar welke dag wil je verplaatsen?`
    : `Your appointment for *${treatmentName(apt)}* on ${dateStr} ${atWord} ${timeStr}.\n\nWhich day would you like to move it to?`;

  return whatsappService.sendButtons(from, msg, [
    { id: `resc_date_${formatDateISO(tomorrow)}`, title: lang === 'nl' ? 'Morgen' : 'Tomorrow' },
    { id: 'resc_date_week', title: lang === 'nl' ? 'Volgende week' : 'Next week' },
    { id: 'resc_date_pick', title: lang === 'nl' ? 'Andere datum' : 'Other date' },
  ]);
}

async function cont(from, userInput, conversation) {
  const lang = getLang(from);
  const step = conversation.flowStep;

  if (step === FLOW_STEPS.SELECT_APPOINTMENT) {
    const aptId = userInput.replace('resc_apt_', '');
    const apt = conversation.flowData.appointments.find((a) => String(a.Id) === aptId);
    if (!apt) {
      return whatsappService.sendText(from, lang === 'nl' ? 'Die afspraak kon ik niet vinden.' : "I couldn't find that appointment.");
    }
    return selectAppointmentForReschedule(from, apt);
  }

  if (step === FLOW_STEPS.SELECT_NEW_DATE) {
    if (userInput === 'resc_date_pick') {
      return whatsappService.sendText(from, lang === 'nl'
        ? 'Typ de datum waarnaar je wilt verplaatsen (bijv. "maandag", "5 april", "next friday"):'
        : 'Type the date you want to move to (e.g. "Monday", "April 5", "next friday"):');
    }

    let startDate, endDate;
    const today = new Date();

    if (userInput === 'resc_date_week') {
      const nextMon = addDays(today, (8 - today.getDay()) % 7 || 7);
      startDate = formatDateISO(nextMon);
      endDate = formatDateISO(addDays(nextMon, 6));
      // Show day picker for next week
      return showDayPicker(from, startDate, endDate);
    } else if (userInput.startsWith('resc_date_')) {
      const dateStr = userInput.replace('resc_date_', '');
      startDate = dateStr;
      endDate = dateStr;
    } else {
      // Free text date
      const parsed = parseFreeTextDate(userInput.toLowerCase());
      if (parsed) {
        startDate = parsed.startDate;
        endDate = parsed.endDate;
      } else {
        return whatsappService.sendText(from, lang === 'nl'
          ? 'Ik begreep die datum niet. Probeer bijv. "maandag", "5 april" of "next friday".'
          : "I didn't understand that date. Try e.g. \"Monday\", \"April 5\" or \"next friday\".");
      }
    }

    conversationService.update(from, {
      flowData: { ...conversation.flowData, newDate: startDate },
    });

    return showNewTimeSlots(from, conversation.flowData, startDate, endDate);
  }

  // Day picker for "next week"
  if (step === 'pick_day') {
    if (userInput.startsWith('resc_day_')) {
      const dateStr = userInput.replace('resc_day_', '');
      conversationService.update(from, {
        flowStep: FLOW_STEPS.SELECT_NEW_TIME,
        flowData: { ...conversation.flowData, newDate: dateStr },
      });
      return showNewTimeSlots(from, conversation.flowData, dateStr, dateStr);
    }
  }

  if (step === FLOW_STEPS.SELECT_NEW_TIME) {
    // Allow free text date to switch days
    if (!userInput.startsWith('resc_time_')) {
      const parsed = parseFreeTextDate(userInput.toLowerCase());
      if (parsed) {
        conversationService.update(from, { flowStep: FLOW_STEPS.SELECT_NEW_DATE });
        return cont(from, userInput, { ...conversation, flowStep: FLOW_STEPS.SELECT_NEW_DATE });
      }
      return whatsappService.sendText(from, lang === 'nl'
        ? 'Kies een tijd uit de lijst, of typ een datum om een andere dag te kiezen.'
        : 'Choose a time from the list, or type a date to pick a different day.');
    }

    const parts = userInput.replace('resc_time_', '').split('_');
    const newDateTime = parts[0];
    const staffId = parts[1] ? parseInt(parts[1]) : conversation.flowData.staffId;

    conversationService.update(from, {
      flowStep: FLOW_STEPS.CONFIRM_RESCHEDULE,
      flowData: { ...conversation.flowData, newDateTime, staffId },
    });

    const dateStr = formatDutchDate(newDateTime);
    const timeStr = formatDutchTime(newDateTime);
    const origDate = formatDutchDate(conversation.flowData.originalDateTime);
    const origTime = formatDutchTime(conversation.flowData.originalDateTime);
    const atWord = lang === 'nl' ? 'om' : 'at';

    const msg = lang === 'nl'
      ? `Wijziging bevestigen:\n\n❌ Was: ${origDate} ${atWord} ${origTime}\n✅ Wordt: ${dateStr} ${atWord} ${timeStr}\n\nKlopt dit?`
      : `Confirm reschedule:\n\n❌ Was: ${origDate} ${atWord} ${origTime}\n✅ New: ${dateStr} ${atWord} ${timeStr}\n\nIs this correct?`;

    return whatsappService.sendButtons(from, msg, [
      { id: 'resc_confirm', title: lang === 'nl' ? 'Bevestigen' : 'Confirm' },
      { id: 'resc_cancel', title: lang === 'nl' ? 'Annuleren' : 'Cancel' },
    ]);
  }

  if (step === FLOW_STEPS.CONFIRM_RESCHEDULE) {
    if (userInput === 'resc_cancel') {
      conversationService.clearFlow(from);
      return whatsappService.sendText(from, lang === 'nl'
        ? 'De wijziging is geannuleerd. Je oorspronkelijke afspraak blijft staan.'
        : 'The change has been cancelled. Your original appointment remains.');
    }

    if (userInput === 'resc_confirm') {
      try {
        const { appointmentId, serviceName, newDateTime, serviceId, staffId, clientId } = conversation.flowData;

        // Step 1: Cancel old appointment
        await mindbodyService.cancelAppointment(appointmentId);
        logger.info('Old appointment cancelled:', appointmentId);

        // Step 2: Book new appointment
        const newAppointment = await mindbodyService.addAppointment({
          clientId,
          sessionTypeId: serviceId,
          staffId,
          startDateTime: newDateTime,
        });
        logger.info('New appointment booked:', newAppointment?.Id);

        const dateStr = formatDutchDate(newDateTime);
        const timeStr = formatDutchTime(newDateTime);
        const atWord = lang === 'nl' ? 'om' : 'at';

        conversationService.clearFlow(from);
        return whatsappService.sendText(from, lang === 'nl'
          ? `Je afspraak is gewijzigd! ✅\n\n*${serviceName}*\n📅 ${dateStr} ${atWord} ${timeStr}\n\nTot dan bij Renessence!`
          : `Your appointment has been rescheduled! ✅\n\n*${serviceName}*\n📅 ${dateStr} ${atWord} ${timeStr}\n\nSee you at Renessence!`);
      } catch (err) {
        logger.error('Reschedule error:', err.message);
        conversationService.clearFlow(from);
        return whatsappService.sendText(from, lang === 'nl'
          ? 'Er ging iets mis bij het wijzigen. Neem contact met ons op.'
          : 'Something went wrong while rescheduling. Please contact us.');
      }
    }
  }

  return whatsappService.sendText(from, lang === 'nl' ? 'Wil je een afspraak wijzigen?' : 'Would you like to reschedule an appointment?');
}

async function showDayPicker(from, startDate, endDate) {
  const lang = getLang(from);
  const days = [];
  let current = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');

  while (current <= end) {
    const dayName = formatDutchDate(current.toISOString());
    days.push({
      id: `resc_day_${formatDateISO(current)}`,
      title: dayName,
      description: lang === 'nl' ? 'Bekijk tijden' : 'View times',
    });
    current = addDays(current, 1);
  }

  conversationService.update(from, { flowStep: 'pick_day' });

  return whatsappService.sendList(
    from,
    lang === 'nl' ? 'Kies een dag:' : 'Choose a day:',
    lang === 'nl' ? 'Kies een dag' : 'Pick a day',
    [{ title: lang === 'nl' ? 'Beschikbare dagen' : 'Available days', rows: days.slice(0, 10) }]
  );
}

async function showNewTimeSlots(from, flowData, startDate, endDate) {
  const lang = getLang(from);
  try {
    const serviceId = flowData.serviceId;
    let allItems = [];
    const items = await mindbodyService.getBookableItems(serviceId, startDate, endDate);
    allItems = allItems.concat(items);

    if (allItems.length === 0) {
      conversationService.update(from, { flowStep: FLOW_STEPS.SELECT_NEW_DATE });
      return whatsappService.sendText(from, lang === 'nl'
        ? 'Helaas geen beschikbare tijden op die dag. Typ een andere datum:'
        : 'Unfortunately no available times on that day. Type another date:');
    }

    // Generate actual time slots from availability windows
    const sessionDuration = allItems[0].SessionType?.DefaultTimeLength || 60;
    const slotInterval = 60;
    const slots = [];

    for (const item of allItems) {
      const windowStart = new Date(item.StartDateTime);
      const windowEnd = new Date(item.BookableEndDateTime || item.EndDateTime);

      let slotTime = new Date(windowStart);
      while (slotTime < windowEnd) {
        const slotEnd = new Date(slotTime.getTime() + sessionDuration * 60000);
        const now = new Date();
        if (!( slotTime < now) && slotEnd <= windowEnd) {
          slots.push({
            dateTime: slotTime.toISOString().replace(/\.\d{3}Z$/, ''),
            staffId: item.Staff?.Id || 0,
          });
        }
        slotTime = new Date(slotTime.getTime() + slotInterval * 60000);
      }
    }

    if (slots.length === 0) {
      conversationService.update(from, { flowStep: FLOW_STEPS.SELECT_NEW_DATE });
      return whatsappService.sendText(from, lang === 'nl'
        ? 'Alle tijden zijn volgeboekt op die dag. Typ een andere datum:'
        : 'All times are fully booked on that day. Type another date:');
    }

    const isMultiDay = startDate !== endDate;
    const rows = slots.slice(0, 10).map((slot) => {
      const dateLabel = formatDutchDate(slot.dateTime);
      const timeLabel = formatDutchTime(slot.dateTime);
      return {
        id: `resc_time_${slot.dateTime}_${slot.staffId}`,
        title: isMultiDay ? `${dateLabel} ${timeLabel}` : timeLabel,
        description: isMultiDay ? (lang === 'nl' ? 'Beschikbaar' : 'Available') : dateLabel,
      };
    });

    conversationService.update(from, { flowStep: FLOW_STEPS.SELECT_NEW_TIME });

    return whatsappService.sendList(
      from,
      lang === 'nl' ? 'Kies een nieuw tijdslot:' : 'Choose a new time slot:',
      lang === 'nl' ? 'Tijden bekijken' : 'View times',
      [{ title: lang === 'nl' ? 'Beschikbare tijden' : 'Available times', rows }]
    );
  } catch (err) {
    logger.error('Error fetching new time slots:', err.message);
    return whatsappService.sendText(from, lang === 'nl' ? 'Er ging iets mis. Probeer het later opnieuw.' : 'Something went wrong. Please try again later.');
  }
}

module.exports = { start, continue: cont };
