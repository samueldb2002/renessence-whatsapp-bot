const whatsappService = require('../services/whatsapp.service');
const mindbodyService = require('../services/mindbody.service');
const conversationService = require('../services/conversation.service');
const { FLOW_STEPS } = require('../config/constants');
const { formatDutchDate, formatDutchTime, formatDateISO, addDays, parseFreeTextDate } = require('../utils/date');
const { findServiceByText, findAmbiguousMatches, buildWhatsAppSections } = require('../data/service-catalog');
const paymentService = require('../services/payment.service');
const logger = require('../utils/logger');
const db = require('../data/database');

async function start(from, name, entities) {
  // Initialize booking flow
  conversationService.startFlow(from, 'booking', {
    userName: name,
    serviceName: entities?.service || null,
    serviceId: null,
    staffId: null,
    staffName: null,
    date: entities?.date || null,
    time: entities?.time || null,
    clientId: null,
  });

  // If service was mentioned, try to match it via catalog
  if (entities?.service) {
    return matchService(from, entities.service);
  }

  // Otherwise show service list
  return showServiceList(from);
}

async function cont(from, userInput, conversation) {
  const step = conversation.flowStep;

  switch (step) {
    case FLOW_STEPS.SELECT_SERVICE:
      return handleServiceSelection(from, userInput, conversation);
    case FLOW_STEPS.SELECT_DATE:
      return handleDateSelection(from, userInput, conversation);
    case FLOW_STEPS.SELECT_TIME:
      // If user clicks a date button (from "fully booked" fallback), handle as date selection
      if (userInput.startsWith('date_')) {
        conversationService.update(from, { flowStep: FLOW_STEPS.SELECT_DATE });
        return handleDateSelection(from, userInput, conversation);
      }
      return handleTimeSelection(from, userInput, conversation);
    case FLOW_STEPS.COLLECT_NAME:
      return handleCollectName(from, userInput, conversation);
    case FLOW_STEPS.COLLECT_EMAIL:
      return handleCollectEmail(from, userInput, conversation);
    case FLOW_STEPS.CONFIRM:
      return handleConfirmation(from, userInput, conversation);
    default:
      return showServiceList(from);
  }
}

async function showServiceList(from) {
  // WhatsApp lists max 10 rows total, so show category picker first
  conversationService.update(from, { flowStep: FLOW_STEPS.SELECT_SERVICE, flowData: { ...conversationService.get(from).flowData, awaitingCategory: true } });

  const lang = conversationService.get(from)?.lang || 'en';
  const msg = lang === 'nl' ? 'Welke categorie behandeling zoek je?' : 'Which category of treatment are you looking for?';
  return whatsappService.sendButtons(from, msg, [
    { id: 'cat_tech', title: 'Tech Treatments' },
    { id: 'cat_traditional', title: lang === 'nl' ? 'Traditioneel' : 'Traditional' },
    { id: 'cat_classes', title: 'Classes' },
  ]);
}

async function showCategoryServices(from, categoryKey) {
  const sections = buildWhatsAppSections();
  const categoryMap = { tech: 'Tech Treatments', traditional: 'Traditional Treatments', classes: 'Classes' };
  const section = sections.find((s) => s.title === categoryMap[categoryKey]);

  const lang = conversationService.get(from)?.lang || 'en';
  if (!section) {
    return whatsappService.sendText(from, lang === 'nl' ? 'Categorie niet gevonden. Probeer opnieuw.' : 'Category not found. Please try again.');
  }

  conversationService.update(from, { flowData: { ...conversationService.get(from).flowData, awaitingCategory: false } });

  const chooseMsg = lang === 'nl' ? `Kies een ${categoryMap[categoryKey]} behandeling:` : `Choose a ${categoryMap[categoryKey]} treatment:`;
  const btnLabel = lang === 'nl' ? 'Bekijk opties' : 'View options';
  return whatsappService.sendList(
    from,
    chooseMsg,
    btnLabel,
    [{ title: categoryMap[categoryKey], rows: section.rows.slice(0, 10) }]
  );
}

async function matchService(from, serviceName) {
  const lang = conversationService.get(from)?.lang || 'en';

  // Check if the query is ambiguous (e.g. "sauna" matches multiple types)
  const ambiguousMatches = findAmbiguousMatches(serviceName);
  if (ambiguousMatches && ambiguousMatches.length > 1) {
    // Ask user which specific variant they want
    conversationService.update(from, {
      flowStep: FLOW_STEPS.SELECT_SERVICE,
      flowData: { ...conversationService.get(from).flowData, awaitingCategory: false },
    });

    const msg = lang === 'nl' ? 'Welke variant wil je?' : 'Which type would you like?';
    const btnLabel = lang === 'nl' ? 'Bekijk opties' : 'View options';
    const rows = ambiguousMatches.slice(0, 10).map((s) => ({
      id: `service_${s.mindbodyIds[0]}`,
      title: s.displayName.substring(0, 24),
      description: s.description.substring(0, 72),
    }));

    return whatsappService.sendList(from, msg, btnLabel, [
      { title: lang === 'nl' ? 'Opties' : 'Options', rows },
    ]);
  }

  const catalogMatch = findServiceByText(serviceName);

  if (catalogMatch) {
    const mindbodyId = catalogMatch.mindbodyIds[0];
    conversationService.update(from, {
      flowStep: FLOW_STEPS.SELECT_DATE,
      flowData: {
        ...conversationService.get(from).flowData,
        serviceId: mindbodyId,
        serviceName: catalogMatch.displayName,
        mindbodyIds: catalogMatch.mindbodyIds,
      },
    });
    return showDateOptions(from, catalogMatch.displayName);
  }

  // No match found, show full list
  return showServiceList(from);
}

async function handleServiceSelection(from, userInput, conversation) {
  try {
    // Category button reply
    if (userInput.startsWith('cat_')) {
      const categoryKey = userInput.replace('cat_', '');
      return showCategoryServices(from, categoryKey);
    }

    if (userInput.startsWith('service_')) {
      // List reply: "service_58" -> use catalog to find display name
      const serviceId = parseInt(userInput.replace('service_', ''));
      const services = await mindbodyService.getServices();
      const mbService = services.find((s) => s.Id === serviceId);

      // Also find catalog entry for this ID
      const { SERVICE_CATALOG } = require('../data/service-catalog');
      let catalogEntry = null;
      for (const cat of SERVICE_CATALOG) {
        for (const svc of cat.services) {
          if (svc.mindbodyIds.includes(serviceId)) {
            catalogEntry = svc;
            break;
          }
        }
        if (catalogEntry) break;
      }

      if (mbService || catalogEntry) {
        conversationService.update(from, {
          flowStep: FLOW_STEPS.SELECT_DATE,
          flowData: {
            ...conversation.flowData,
            serviceId: serviceId,
            serviceName: catalogEntry?.displayName || mbService?.Name,
            mindbodyIds: catalogEntry?.mindbodyIds || [serviceId],
          },
        });
        return showDateOptions(from, catalogEntry?.displayName || mbService?.Name);
      }
    } else {
      // Free text: try catalog match
      const catalogMatch = findServiceByText(userInput);
      if (catalogMatch) {
        conversationService.update(from, {
          flowStep: FLOW_STEPS.SELECT_DATE,
          flowData: {
            ...conversation.flowData,
            serviceId: catalogMatch.mindbodyIds[0],
            serviceName: catalogMatch.displayName,
            mindbodyIds: catalogMatch.mindbodyIds,
          },
        });
        return showDateOptions(from, catalogMatch.displayName);
      }
    }

    // Nothing found
    const lang = conversationService.get(from)?.lang || 'en';
    await whatsappService.sendText(from, lang === 'nl' ? 'Die behandeling heb ik niet gevonden. Kies er een uit de lijst:' : "I couldn't find that treatment. Please choose from the list:");
    return showServiceList(from);
  } catch (err) {
    logger.error('Error handling service selection:', err.message);
    const lang = conversationService.get(from)?.lang || 'en';
    return whatsappService.sendText(from, lang === 'nl' ? 'Er ging iets mis. Probeer het later opnieuw.' : 'Something went wrong. Please try again later.');
  }
}

async function showDateOptions(from, serviceName) {
  const lang = conversationService.get(from)?.lang || 'en';
  const today = new Date();
  const tomorrow = addDays(today, 1);

  const msg = lang === 'nl' ? `Wanneer wil je komen voor ${serviceName}?` : `When would you like to book ${serviceName}?`;
  return whatsappService.sendButtons(from, msg, [
    { id: `date_${formatDateISO(today)}`, title: lang === 'nl' ? 'Vandaag' : 'Today' },
    { id: `date_${formatDateISO(tomorrow)}`, title: lang === 'nl' ? 'Morgen' : 'Tomorrow' },
    { id: 'date_week', title: lang === 'nl' ? 'Deze week' : 'This week' },
  ]);
}

async function showNextWeekDayPicker(from, conversation) {
  const lang = conversationService.get(from)?.lang || 'en';
  const today = new Date();
  const dayOfWeek = today.getDay();
  const daysUntilMonday = dayOfWeek === 0 ? 1 : (8 - dayOfWeek);
  const nextMonday = addDays(today, daysUntilMonday);

  const dutchDays = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
  const englishDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // Build rows for Mon-Sun of next week
  const rows = [];
  for (let i = 0; i < 7; i++) {
    const day = addDays(nextMonday, i);
    const dateStr = formatDateISO(day);
    const dayName = lang === 'nl' ? dutchDays[day.getDay()] : englishDays[day.getDay()];
    const dateLabel = formatDutchDate(dateStr);
    rows.push({
      id: `date_${dateStr}`,
      title: `${dayName} ${day.getDate()}/${day.getMonth() + 1}`,
      description: dateLabel,
    });
  }

  conversationService.update(from, { flowStep: FLOW_STEPS.SELECT_DATE });

  const msg = lang === 'nl' ? 'Welke dag volgende week?' : 'Which day next week?';
  const btn = lang === 'nl' ? 'Kies een dag' : 'Pick a day';
  const sectionTitle = lang === 'nl' ? 'Volgende week' : 'Next week';

  return whatsappService.sendList(from, msg, btn, [
    { title: sectionTitle, rows },
  ]);
}

async function handleDateSelection(from, userInput, conversation) {
  let startDate, endDate;
  const today = new Date();

  if (userInput === 'date_week') {
    // "This week" = today through Sunday (end of current week)
    const dayOfWeek = today.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const daysUntilSunday = dayOfWeek === 0 ? 0 : 7 - dayOfWeek;
    startDate = formatDateISO(today);
    endDate = formatDateISO(addDays(today, daysUntilSunday));
  } else if (userInput === 'date_nextweek') {
    // "Next week" — show day picker first
    return showNextWeekDayPicker(from, conversation);
  } else if (userInput.startsWith('date_')) {
    const dateStr = userInput.replace('date_', '');
    startDate = dateStr;
    endDate = dateStr;
  } else {
    // Free text date from user or Claude entities
    const parsed = parseFreeTextDate(userInput);
    if (parsed) {
      startDate = parsed.startDate;
      endDate = parsed.endDate;
    } else {
      startDate = userInput;
      endDate = userInput;
    }
  }

  conversationService.update(from, {
    flowData: { ...conversation.flowData, date: startDate },
  });

  // If multiple Mindbody IDs, query all of them and combine results
  const mindbodyIds = conversation.flowData.mindbodyIds || [conversation.flowData.serviceId];
  return showTimeSlots(from, mindbodyIds, startDate, endDate);
}

async function showTimeSlots(from, serviceIds, startDate, endDate) {
  const lang = conversationService.get(from)?.lang || 'en';
  try {
    // Query all Mindbody IDs for this service and combine
    let allItems = [];
    for (const serviceId of serviceIds) {
      const items = await mindbodyService.getBookableItems(serviceId, startDate, endDate);
      allItems = allItems.concat(items);
    }

    if (allItems.length === 0) {
      conversationService.update(from, { flowStep: FLOW_STEPS.SELECT_DATE });
      const msg = lang === 'nl'
        ? 'Helaas zijn er geen tijden beschikbaar in die periode. Wil je een andere dag proberen?'
        : 'Unfortunately, there are no times available in that period. Would you like to try another day?';
      return whatsappService.sendText(from, msg);
    }

    // Each bookable item is an availability WINDOW (e.g. 07:00-20:55), not a single slot.
    // We need to generate individual time slots within these windows.
    // Also fetch existing appointments to filter out booked times.
    // Bookable items from Mindbody are already available GAPS between existing bookings.
    // No need to fetch existing appointments separately.
    const sessionDuration = allItems[0].SessionType?.DefaultTimeLength || 60; // minutes
    const slotInterval = 60; // generate a slot every 60 minutes

    // Generate individual time slots from availability windows
    const slots = [];
    const now = new Date();
    for (const item of allItems) {
      const windowStart = new Date(item.StartDateTime);
      const windowEnd = new Date(item.BookableEndDateTime || item.EndDateTime);
      const windowMinutes = (windowEnd - windowStart) / 60000;
      const staffIdItem = item.Staff?.Id || 0;
      const sessionTypeId = item.SessionType?.Id || 0;

      // Skip windows too small for the session
      if (windowMinutes < sessionDuration) continue;

      // Round start time UP to next clean hour/half-hour for nicer display
      let slotTime = new Date(windowStart);
      const mins = slotTime.getMinutes();
      if (mins > 0 && mins <= 30) {
        slotTime.setMinutes(30, 0, 0);
      } else if (mins > 30) {
        slotTime.setHours(slotTime.getHours() + 1, 0, 0, 0);
      }
      // If rounding pushed us past the point where we can't fit a session, start from windowStart
      if (new Date(slotTime.getTime() + sessionDuration * 60000) > windowEnd) {
        slotTime = new Date(windowStart);
      }

      while (slotTime < windowEnd) {
        const slotEnd = new Date(slotTime.getTime() + sessionDuration * 60000);

        // Skip past times
        if (slotTime > now && slotEnd <= windowEnd) {
          // Format without timezone issues: extract local date/time parts
          const y = slotTime.getFullYear();
          const mo = String(slotTime.getMonth() + 1).padStart(2, '0');
          const d = String(slotTime.getDate()).padStart(2, '0');
          const h = String(slotTime.getHours()).padStart(2, '0');
          const mi = String(slotTime.getMinutes()).padStart(2, '0');
          const localDateTime = `${y}-${mo}-${d}T${h}:${mi}:00`;

          slots.push({
            dateTime: localDateTime,
            staffId: staffIdItem,
            sessionTypeId,
            dayKey: `${y}-${mo}-${d}`,
          });
        }

        slotTime = new Date(slotTime.getTime() + slotInterval * 60000);
      }
    }

    if (slots.length === 0) {
      conversationService.update(from, { flowStep: FLOW_STEPS.SELECT_TIME });
      const msg = lang === 'nl'
        ? 'Helaas zijn alle tijden volgeboekt in die periode. Probeer een andere periode:'
        : 'Unfortunately, all times are fully booked in that period. Try a different period:';
      return whatsappService.sendButtons(from, msg, [
        { id: 'date_nextweek', title: lang === 'nl' ? 'Volgende week' : 'Next week' },
        { id: `date_${formatDateISO(addDays(new Date(), 1))}`, title: lang === 'nl' ? 'Morgen' : 'Tomorrow' },
      ]);
    }

    const isMultiDay = startDate !== endDate;

    // For multi-day queries, distribute slots evenly across days (max 10 WhatsApp rows)
    let displaySlots;
    if (isMultiDay) {
      const dayGroups = {};
      for (const slot of slots) {
        if (!dayGroups[slot.dayKey]) dayGroups[slot.dayKey] = [];
        dayGroups[slot.dayKey].push(slot);
      }
      const days = Object.keys(dayGroups).sort();
      const slotsPerDay = Math.max(1, Math.floor(10 / days.length));
      displaySlots = [];
      for (const day of days) {
        // Pick evenly spaced slots from each day
        const daySlots = dayGroups[day];
        const step = Math.max(1, Math.floor(daySlots.length / slotsPerDay));
        for (let i = 0; i < daySlots.length && displaySlots.length < 10; i += step) {
          displaySlots.push(daySlots[i]);
        }
      }
    } else {
      displaySlots = slots.slice(0, 10);
    }

    const rows = displaySlots.map((slot) => {
      const dateLabel = formatDutchDate(slot.dateTime);
      const timeLabel = formatDutchTime(slot.dateTime);
      return {
        id: `time_${slot.dateTime}_${slot.staffId}_${slot.sessionTypeId}`,
        title: isMultiDay ? `${dateLabel} ${timeLabel}` : timeLabel,
        description: isMultiDay ? (lang === 'nl' ? 'Beschikbaar' : 'Available') : dateLabel,
      };
    });

    conversationService.update(from, { flowStep: FLOW_STEPS.SELECT_TIME });

    const listHeader = lang === 'nl'
      ? 'Kies een beschikbaar tijdslot:'
      : 'Choose an available time slot:';
    const listButton = lang === 'nl' ? 'Tijden bekijken' : 'View times';
    const sectionTitle = lang === 'nl' ? 'Beschikbare tijden' : 'Available times';

    return whatsappService.sendList(from, listHeader, listButton, [
      { title: sectionTitle, rows },
    ]);
  } catch (err) {
    logger.error('Error fetching time slots:', err.message);
    const msg = lang === 'nl'
      ? 'Er ging iets mis bij het ophalen van beschikbare tijden. Probeer het later opnieuw.'
      : 'Something went wrong while fetching available times. Please try again later.';
    return whatsappService.sendText(from, msg);
  }
}

async function handleTimeSelection(from, userInput, conversation) {
  let startDateTime, staffId, sessionTypeId;

  if (userInput.startsWith('time_')) {
    // List reply: "time_2026-03-17T14:00:00_5_58"
    const parts = userInput.replace('time_', '').split('_');
    startDateTime = parts[0];
    staffId = parts[1] && parseInt(parts[1]) !== 0 ? parseInt(parts[1]) : null;
    sessionTypeId = parts[2] ? parseInt(parts[2]) : conversation.flowData.serviceId;
  } else {
    // Free text - check if user is trying to change the date
    const dateWords = ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag',
      'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
      'morgen', 'tomorrow', 'overmorgen', 'vandaag', 'today', 'volgende week', 'next week',
      'deze week', 'this week', 'andere dag', 'another day', 'other day', 'andere datum', 'change date'];
    const lower = userInput.toLowerCase();

    if (dateWords.some((w) => lower.includes(w)) || parseFreeTextDate(lower)) {
      // User wants a different date — go back to date selection
      conversationService.update(from, { flowStep: FLOW_STEPS.SELECT_DATE });
      return handleDateSelection(from, userInput, conversation);
    }

    // Not a date — ask them to pick from the list
    const lang = conversationService.get(from)?.lang || 'en';
    return whatsappService.sendText(from, lang === 'nl'
      ? 'Kies een tijd uit de lijst hierboven.'
      : 'Please choose a time from the list above.');
  }

  const flowData = {
    ...conversation.flowData,
    startDateTime,
    staffId,
    serviceId: sessionTypeId || conversation.flowData.serviceId,
    time: formatDutchTime(startDateTime),
  };

  // Check if client exists in Mindbody
  let client = null;
  try {
    client = await mindbodyService.getClientByPhone(from, null);
  } catch (err) {
    logger.warn('Could not look up client:', err.message);
  }

  const lang = conversationService.get(from)?.lang || 'en';

  if (client) {
    // Client exists — skip to confirmation
    flowData.clientId = client.Id;
    flowData.clientName = `${client.FirstName} ${client.LastName}`.trim();
    flowData.clientEmail = client.Email;
    conversationService.update(from, { flowStep: FLOW_STEPS.CONFIRM, flowData });

    const dateStr = formatDutchDate(startDateTime);
    const timeStr = formatDutchTime(startDateTime);
    const atWord = lang === 'nl' ? 'om' : 'at';
    const summary = lang === 'nl'
      ? `Overzicht van je boeking:\n\n${flowData.serviceName}\n${dateStr} ${atWord} ${timeStr}\nOp naam van: ${flowData.clientName}\n\nKlopt dit?`
      : `Booking summary:\n\n${flowData.serviceName}\n${dateStr} ${atWord} ${timeStr}\nName: ${flowData.clientName}\n\nIs this correct?`;

    return whatsappService.sendButtons(from, summary, [
      { id: 'confirm_yes', title: lang === 'nl' ? 'Bevestigen' : 'Confirm' },
      { id: 'confirm_no', title: lang === 'nl' ? 'Annuleren' : 'Cancel' },
    ]);
  }

  // Client not found — collect details
  conversationService.update(from, { flowStep: FLOW_STEPS.COLLECT_NAME, flowData });
  return whatsappService.sendText(from, lang === 'nl' ? 'Ik heb je gegevens nodig om de boeking te maken. Wat is je volledige naam?' : 'I need your details to complete the booking. What is your full name?');
}

async function handleCollectName(from, userInput, conversation) {
  const lang = conversationService.get(from)?.lang || 'en';
  const name = userInput.trim();

  // Ignore button IDs that aren't real names
  if (!name || name.length < 2 || name.includes('_') || /^(date|service|time|confirm|category)/.test(name)) {
    return whatsappService.sendText(from, lang === 'nl' ? 'Voer alsjeblieft je volledige naam in (voor- en achternaam):' : 'Please enter your full name (first and last name):');
  }

  if (!name.includes(' ')) {
    return whatsappService.sendText(from, lang === 'nl' ? 'Voer alsjeblieft je volledige naam in (voor- én achternaam):' : 'Please enter your full name (first and last name):');
  }

  conversationService.update(from, {
    flowStep: FLOW_STEPS.COLLECT_EMAIL,
    flowData: { ...conversation.flowData, clientFullName: name },
  });

  const firstName = name.split(' ')[0];
  return whatsappService.sendText(from, lang === 'nl' ? `Bedankt ${firstName}! Wat is je e-mailadres?` : `Thanks ${firstName}! What is your email address?`);
}

async function handleCollectEmail(from, userInput, conversation) {
  const lang = conversationService.get(from)?.lang || 'en';
  const email = userInput.trim().toLowerCase();
  if (!email || !email.includes('@') || !email.includes('.')) {
    return whatsappService.sendText(from, lang === 'nl' ? 'Dat lijkt geen geldig e-mailadres. Probeer het opnieuw:' : "That doesn't look like a valid email address. Please try again:");
  }

  const flowData = {
    ...conversation.flowData,
    clientEmail: email,
  };

  conversationService.update(from, { flowStep: FLOW_STEPS.CONFIRM, flowData });

  const dateStr = formatDutchDate(flowData.startDateTime);
  const timeStr = formatDutchTime(flowData.startDateTime);
  const atWord = lang === 'nl' ? 'om' : 'at';
  const summary = lang === 'nl'
    ? `Overzicht van je boeking:\n\n${flowData.serviceName}\n${dateStr} ${atWord} ${timeStr}\nNaam: ${flowData.clientFullName}\nE-mail: ${email}\n\nKlopt dit?`
    : `Booking summary:\n\n${flowData.serviceName}\n${dateStr} ${atWord} ${timeStr}\nName: ${flowData.clientFullName}\nEmail: ${email}\n\nIs this correct?`;

  return whatsappService.sendButtons(from, summary, [
    { id: 'confirm_yes', title: lang === 'nl' ? 'Bevestigen' : 'Confirm' },
    { id: 'confirm_no', title: lang === 'nl' ? 'Annuleren' : 'Cancel' },
  ]);
}

async function handleConfirmation(from, userInput, conversation) {
  const input = userInput.toLowerCase().trim();
  const lang = conversationService.get(from)?.lang || 'en';
  const isNo = input === 'confirm_no' || input === 'annuleren' || input === 'nee' || input === 'no' || input === 'cancel';
  const isYes = input === 'confirm_yes' || input === 'bevestigen' || input === 'ja' || input === 'yes' || input === 'ok' || input === 'confirm';

  if (isNo) {
    conversationService.clearFlow(from);
    return whatsappService.sendText(from, lang === 'nl' ? 'Geen probleem! Als je toch wilt boeken, laat het me weten.' : 'No problem! Let me know if you want to book later.');
  }

  // Check if user wants to change their name
  const nameChangeWords = ['other name', 'andere naam', 'change name', 'naam wijzigen', 'niet mijn naam', 'wrong name', 'verkeerde naam', 'naam aanpassen'];
  if (nameChangeWords.some((w) => input.includes(w))) {
    conversationService.update(from, { flowStep: FLOW_STEPS.COLLECT_NAME, flowData: { ...conversation.flowData, clientId: null } });
    return whatsappService.sendText(from, lang === 'nl' ? 'Wat is de juiste naam? (voor- en achternaam)' : 'What is the correct name? (first and last name)');
  }

  if (!isYes) {
    const msg = lang === 'nl'
      ? 'Wil je de boeking bevestigen? Je kunt ook "andere naam" typen om de naam te wijzigen.'
      : 'Would you like to confirm the booking? You can also type "other name" to change the name.';
    return whatsappService.sendButtons(from, msg, [
      { id: 'confirm_yes', title: lang === 'nl' ? 'Bevestigen' : 'Confirm' },
      { id: 'confirm_no', title: lang === 'nl' ? 'Annuleren' : 'Cancel' },
    ]);
  }

  const { flowData } = conversation;
  logger.info('Booking confirmation flowData:', JSON.stringify(flowData));

  try {
    let clientId = flowData.clientId;

    // If we don't have a clientId yet, create the client in Mindbody
    if (!clientId) {
      const nameParts = (flowData.clientFullName || flowData.userName || 'WhatsApp Klant').split(' ');
      const firstName = nameParts[0];
      const lastName = nameParts.slice(1).join(' ') || 'WhatsApp';

      logger.info('Creating new Mindbody client:', firstName, lastName, flowData.clientEmail);
      try {
        const newClient = await mindbodyService.addClient({
          firstName,
          lastName,
          email: flowData.clientEmail,
          mobilePhone: from,
          city: 'Amsterdam',
        });
        clientId = newClient.Id;
        logger.info('New client created with ID:', clientId);
      } catch (addErr) {
        // If duplicate client, try to find existing client by email
        if (addErr.response?.data?.Error?.Code === 'InvalidClientCreation') {
          logger.info('Client already exists, searching by email:', flowData.clientEmail);
          const existingClient = await mindbodyService.getClientByPhone(from, flowData.clientEmail);
          if (existingClient) {
            clientId = existingClient.Id;
            logger.info('Found existing client by email, ID:', clientId);
          } else {
            throw addErr;
          }
        } else {
          throw addErr;
        }
      }
    }

    // Book the appointment
    logger.info('Booking appointment:', JSON.stringify({
      clientId,
      sessionTypeId: flowData.serviceId,
      staffId: flowData.staffId,
      startDateTime: flowData.startDateTime,
    }));
    const appointment = await mindbodyService.addAppointment({
      clientId,
      sessionTypeId: flowData.serviceId,
      staffId: flowData.staffId,
      startDateTime: flowData.startDateTime,
    });
    logger.info('Appointment booked! ID:', appointment?.Id);

    // Log booking event to DB
    const bookingEventId = await db.logBookingEvent({
      phone: from,
      customerName: flowData.clientFullName || flowData.clientName || flowData.userName,
      sessionTypeId: flowData.serviceId,
      serviceName: flowData.serviceName,
      status: 'confirmed',
      amountCents: paymentService.getPriceInCents(flowData.serviceId),
    });
    if (bookingEventId) {
      await db.updateBookingEvent(bookingEventId, {
        appointmentDate: flowData.startDateTime,
        mindbodyAppointmentId: appointment?.Id,
        staffName: flowData.staffName,
      });
    }
    // Store bookingEventId for payment tracking
    conversationService.update(from, { flowData: { ...flowData, dbBookingEventId: bookingEventId } });

    conversationService.clearFlow(from);

    const dateStr = formatDutchDate(flowData.startDateTime);
    const timeStr = formatDutchTime(flowData.startDateTime);
    const atWord = lang === 'nl' ? 'om' : 'at';
    const price = paymentService.getPrice(flowData.serviceId);

    // If we have a price, create a payment link
    if (price) {
      try {
        const payment = await paymentService.createPaymentLink({
          appointmentId: appointment?.Id,
          clientId,
          from,
          serviceName: flowData.serviceName,
          dateTime: `${dateStr} ${atWord} ${timeStr}`,
          amount: paymentService.getPriceInCents(flowData.serviceId),
          customerEmail: flowData.clientEmail,
          customerName: flowData.clientFullName || flowData.clientName || flowData.userName,
        });

        // Update DB with Stripe session
        if (bookingEventId) {
          db.updateBookingEvent(bookingEventId, {
            stripeSessionId: payment.sessionId,
            status: 'payment_sent',
          });
        }

        const confirmMsg = lang === 'nl'
          ? `Je afspraak is gereserveerd! 📋\n\n*${flowData.serviceName}*\n📅 ${dateStr} ${atWord} ${timeStr}\n\nBetaal binnen 45 minuten om je boeking te bevestigen.`
          : `Your appointment is reserved! 📋\n\n*${flowData.serviceName}*\n📅 ${dateStr} ${atWord} ${timeStr}\n\nPlease pay within 45 minutes to confirm your booking.`;
        const payBtnLabel = lang === 'nl' ? 'Betalen' : 'Pay now';
        return whatsappService.sendCTAButton(from, confirmMsg, payBtnLabel, payment.paymentUrl);
      } catch (payErr) {
        logger.error('Payment link creation failed:', payErr.message);
        // Still confirm the booking even if payment link fails
        const confirmMsg = lang === 'nl'
          ? `Je afspraak is bevestigd! ✅\n\n${flowData.serviceName}\n${dateStr} ${atWord} ${timeStr}\n\nEr ging iets mis met de betaallink. Je kunt ter plekke betalen.\nTot dan bij Renessence!`
          : `Your appointment is confirmed! ✅\n\n${flowData.serviceName}\n${dateStr} ${atWord} ${timeStr}\n\nSomething went wrong with the payment link. You can pay on site.\nSee you at Renessence!`;
        return whatsappService.sendText(from, confirmMsg);
      }
    }

    // No price mapped — confirm without payment
    const confirmMsg = lang === 'nl'
      ? `Je afspraak is bevestigd! ✅\n\n${flowData.serviceName}\n${dateStr} ${atWord} ${timeStr}\n\nTot dan bij Renessence!`
      : `Your appointment is confirmed! ✅\n\n${flowData.serviceName}\n${dateStr} ${atWord} ${timeStr}\n\nSee you at Renessence!`;
    return whatsappService.sendText(from, confirmMsg);
  } catch (err) {
    logger.error('Booking error:', err.message);
    logger.error('Booking error FULL:', JSON.stringify({
      status: err.response?.status,
      data: err.response?.data,
      step: err._step || 'unknown',
    }));

    const errorMsg = err.response?.data?.Error?.Message || '';

    // If the time is not available, let user pick another time
    if (errorMsg.includes('not available') || errorMsg.includes('resource') || errorMsg.includes('Resource')) {
      conversationService.update(from, { flowStep: FLOW_STEPS.SELECT_DATE });
      const unavailMsg = lang === 'nl'
        ? 'Helaas is dit tijdslot net niet meer beschikbaar. Kies een andere datum/tijd:'
        : 'Unfortunately, this time slot is no longer available. Please choose another date/time:';
      return whatsappService.sendText(from, unavailMsg).then(() => showDateOptions(from, flowData.serviceName));
    }

    conversationService.clearFlow(from);
    const errMsg2 = lang === 'nl'
      ? 'Sorry, er ging iets mis bij het boeken. Probeer het later opnieuw of bel ons op +31 20 303 8395.'
      : 'Sorry, something went wrong with the booking. Please try again later or call us at +31 20 303 8395.';
    return whatsappService.sendText(from, errMsg2);
  }
}

module.exports = { start, continue: cont };
