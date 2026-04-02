const claudeService = require('../services/claude.service');
const conversationService = require('../services/conversation.service');
const whatsappService = require('../services/whatsapp.service');
const mindbodyService = require('../services/mindbody.service');
const bookingHandler = require('./booking.handler');
const cancelHandler = require('./cancel.handler');
const rescheduleHandler = require('./reschedule.handler');
const faqHandler = require('./faq.handler');
const { INTENTS } = require('../config/constants');
const { formatDutchDate, formatDutchTime, formatDateISO, addDays } = require('../utils/date');
const { t } = require('../config/i18n');
const emailService = require('../services/email.service');
const config = require('../config');
const logger = require('../utils/logger');
const db = require('../data/database');

function getLang(from) {
  const conv = conversationService.get(from);
  return conv?.lang || 'en';
}

function setLang(from, lang) {
  conversationService.update(from, { lang });
}

async function handle(incomingMessage) {
  const { from, name, text, buttonReply, listReply } = incomingMessage;
  const userInput = text || buttonReply?.title || listReply?.title || '[non-text]';

  logger.info(`Message from ${from} (${name}): ${userInput}`);

  // Log conversation to DB
  db.logConversation(from, name, null, null);

  // Ensure conversation exists
  if (!conversationService.get(from)) {
    conversationService.set(from, { userName: name, lang: 'en' });
  }

  const conversation = conversationService.get(from);

  // Double massage — always redirect to JotForm regardless of flow state
  const doubleMassageKeywords = ['double massage', 'duo massage', 'duomassage', 'double massages', 'massage voor twee', 'massage duo', 'koppelmassage', 'couple massage', 'couples massage', 'massage met z\'n tween', 'massage 2 personen'];
  if (text && doubleMassageKeywords.some(k => text.toLowerCase().includes(k))) {
    const lang = getLang(from);
    const msg = lang === 'nl'
      ? `Een duomassage kun je niet online boeken. Vul dit formulier in en we nemen contact met je op:\n\nhttps://form.jotform.com/Renessence/double-massage-form-request`
      : `Double massages can't be booked online. Please fill in this form and we'll get back to you:\n\nhttps://form.jotform.com/Renessence/double-massage-form-request`;
    return whatsappService.sendText(from, msg);
  }

  // If user is in a multi-step flow, continue that flow
  if (conversation?.activeFlow) {
    const userInput = buttonReply?.id || listReply?.id || text;

    // Allow user to break out of flow
    const breakWords = ['stop', 'annuleer', 'terug', 'reset', 'opnieuw', 'overnieuw', 'start over', 'begin opnieuw', 'back', 'nee', 'no'];
    if (text && breakWords.some((w) => text.toLowerCase().trim() === w)) {
      conversationService.clearFlow(from);
      return whatsappService.sendText(from, t('conversationReset', getLang(from)));
    }

    // Handle global menu buttons BEFORE flow handlers — these always break the flow
    if (buttonReply?.id === 'menu_book') {
      conversationService.clearFlow(from);
      return bookingHandler.start(from, name, {});
    }
    if (buttonReply?.id === 'menu_appointments') {
      conversationService.clearFlow(from);
      return checkAppointments(from);
    }
    if (buttonReply?.id === 'menu_info') {
      conversationService.clearFlow(from);
      return showInfoMenu(from);
    }

    // If it's a button/list reply, continue the flow (user clicked a flow-specific UI element)
    if (buttonReply?.id || listReply?.id) {
      switch (conversation.activeFlow) {
        case 'booking':
          return bookingHandler.continue(from, userInput, conversation);
        case 'cancel':
          return cancelHandler.continue(from, userInput, conversation);
        case 'reschedule':
          return rescheduleHandler.continue(from, userInput, conversation);
      }
    }

    // Free text during a flow: use AI to understand what the user wants
    if (text) {
      const flowContext = {
        step: conversation.flowStep || 'unknown',
        serviceName: conversation.flowData?.serviceName || null,
        date: conversation.flowData?.date || null,
        time: conversation.flowData?.time || null,
        clientName: conversation.flowData?.clientFullName || conversation.flowData?.clientName || null,
        clientEmail: conversation.flowData?.clientEmail || null,
      };

      const result = await claudeService.detectFlowIntent(text, name, flowContext);
      logger.info('Flow AI decision:', JSON.stringify(result));

      // Update language
      if (result.detectedLanguage) {
        setLang(from, result.detectedLanguage);
      }

      switch (result.action) {
        case 'cancel_flow':
        case 'decline':
          conversationService.clearFlow(from);
          return whatsappService.sendText(from, t('conversationReset', getLang(from)));

        case 'want_info':
          conversationService.clearFlow(from);
          return showInfoMenu(from);

        case 'greeting':
          // Don't break flow for a greeting, just respond and continue
          return sendGreeting(from, name, null);

        case 'human_handoff':
          conversationService.clearFlow(from);
          return requestHumanHandoff(from, text);

        case 'change_treatment': {
          conversationService.clearFlow(from);
          const service = result.value || null;
          return bookingHandler.start(from, name, { service });
        }

        case 'change_name':
          conversationService.update(from, {
            flowStep: 'collect_name',
            flowData: { ...conversation.flowData, clientId: null },
          });
          return whatsappService.sendText(from, getLang(from) === 'nl'
            ? 'Wat is de juiste naam? (voor- en achternaam)'
            : 'What is the correct name? (first and last name)');

        case 'change_date':
          conversationService.update(from, { flowStep: 'select_date' });
          if (result.value) {
            // AI extracted a date — pass it to the booking handler
            return bookingHandler.continue(from, result.value, conversationService.get(from));
          }
          return bookingHandler.continue(from, 'show_dates', conversationService.get(from));

        case 'change_time':
          conversationService.update(from, { flowStep: 'select_date' });
          return bookingHandler.continue(from, conversation.flowData?.date || 'date_week', conversationService.get(from));

        case 'confirm':
          // Pass confirmation to the flow handler
          return bookingHandler.continue(from, 'confirm_yes', conversationService.get(from));

        case 'continue_flow':
        default:
          // AI says this is a regular flow answer — pass to the appropriate handler
          const flowInput = result.value || text;
          switch (conversation.activeFlow) {
            case 'booking':
              return bookingHandler.continue(from, flowInput, conversation);
            case 'cancel':
              return cancelHandler.continue(from, flowInput, conversation);
            case 'reschedule':
              return rescheduleHandler.continue(from, flowInput, conversation);
          }
      }
    }
  }

  // Handle free question from "Other" info option
  if (text && conversation?.awaitingFreeQuestion) {
    conversationService.update(from, { awaitingFreeQuestion: false });
    const result = await claudeService.detectIntent(text, name);
    if (result.detectedLanguage) setLang(from, result.detectedLanguage);
    if (result.freeformAnswer) {
      return whatsappService.sendText(from, result.freeformAnswer);
    }
    return faqHandler.answer(from, result.faqTopic, result.freeformAnswer);
  }

  // Handle menu button clicks directly (skip intent detection)
  const buttonId = buttonReply?.id || listReply?.id;
  if (buttonId === 'menu_book') {
    return bookingHandler.start(from, name, {});
  }
  if (buttonId === 'menu_appointments') {
    return checkAppointments(from);
  }
  if (buttonId === 'menu_info') {
    return showInfoMenu(from);
  }
  // Handle FAQ category buttons
  if (buttonId === 'info_other') {
    // Set a flag so next free text message gets answered by GPT
    conversationService.update(from, { awaitingFreeQuestion: true });
    const lang = getLang(from);
    return whatsappService.sendText(from, lang === 'nl' ? 'Wat is je vraag? Typ het hieronder en ik help je verder.' : "What's your question? Type it below and I'll help you out.");
  }
  if (buttonId?.startsWith('info_')) {
    const topic = buttonId.replace('info_', '');
    return handleInfoTopic(from, topic);
  }

  // No active flow - detect intent with Claude
  const userMessage = buttonReply?.title || listReply?.title || text;
  if (!userMessage) {
    const lang = getLang(from);
    const msg = lang === 'nl'
      ? 'Sorry, ik kan alleen tekstberichten verwerken. Hoe kan ik je helpen?'
      : "Sorry, I can only process text messages. How can I help you?";
    return whatsappService.sendText(from, msg);
  }

  const result = await claudeService.detectIntent(userMessage, name);
  logger.debug('Claude intent result:', JSON.stringify(result));

  // Update language if detected
  if (result.detectedLanguage) {
    setLang(from, result.detectedLanguage);
  }

  // Log intent to DB
  db.logConversation(from, name, result.detectedLanguage, result.intent);

  switch (result.intent) {
    case INTENTS.BOOK:
      return bookingHandler.start(from, name, result.entities);

    case INTENTS.CANCEL:
      return cancelHandler.start(from, name);

    case INTENTS.RESCHEDULE:
      return rescheduleHandler.start(from, name);

    case INTENTS.CHECK:
      return checkAppointments(from);

    case INTENTS.FAQ:
      return faqHandler.answer(from, result.faqTopic, result.freeformAnswer);

    case INTENTS.GREETING:
      return sendGreeting(from, name, result.freeformAnswer);

    case INTENTS.HUMAN:
      return requestHumanHandoff(from, text);

    default:
      // If GPT-4o provided a freeform answer, use it instead of generic fallback
      if (result.freeformAnswer) {
        return whatsappService.sendText(from, result.freeformAnswer);
      }
      db.logUnansweredQuestion(from, name, userMessage, result.intent || 'unknown');
      return sendFallback(from);
  }
}

async function checkAppointments(from) {
  const lang = getLang(from);
  try {
    // Find ALL clients linked to this phone number
    const clients = await mindbodyService.getAllClientsByPhone(from);
    if (!clients || clients.length === 0) {
      return whatsappService.sendText(from, t('noAppointments', lang));
    }

    const today = formatDateISO(new Date());
    const futureDate = formatDateISO(addDays(new Date(), 90));

    // Check appointments for ALL matching clients
    let allAppointments = [];
    for (const client of clients) {
      const appts = await mindbodyService.getStaffAppointments(today, futureDate, client.Id);
      allAppointments = allAppointments.concat(appts);
    }

    // Sort by date
    allAppointments.sort((a, b) => new Date(a.StartDateTime) - new Date(b.StartDateTime));

    if (allAppointments.length === 0) {
      const msg = lang === 'nl'
        ? 'Je hebt geen aankomende afspraken.'
        : "You don't have any upcoming appointments.";
      return whatsappService.sendButtons(from, msg, [
        { id: 'menu_book', title: lang === 'nl' ? 'Afspraak maken' : 'Book appointment' },
        { id: 'menu_info', title: lang === 'nl' ? 'Informatie' : 'Information' },
      ]);
    }

    const list = allAppointments
      .slice(0, 5)
      .map((apt) => {
        const dateStr = formatDutchDate(apt.StartDateTime);
        const timeStr = formatDutchTime(apt.StartDateTime);
        const atWord = lang === 'nl' ? 'om' : 'at';
        const treatmentName = apt.SessionType?.Name || apt.Staff?.DisplayName || apt.Staff?.Name || 'Treatment';
        return `- ${treatmentName}: ${dateStr} ${atWord} ${timeStr}`;
      })
      .join('\n');

    const header = lang === 'nl' ? 'Je aankomende afspraken:' : 'Your upcoming appointments:';
    return whatsappService.sendText(from, `${header}\n\n${list}`);
  } catch (err) {
    logger.error('Check appointments error:', err.message);
    const msg = lang === 'nl'
      ? 'Er ging iets mis bij het ophalen van je afspraken. Probeer het later opnieuw.'
      : 'Something went wrong while fetching your appointments. Please try again later.';
    return whatsappService.sendText(from, msg);
  }
}

async function sendGreeting(from, name, freeformAnswer) {
  const lang = getLang(from);

  if (freeformAnswer) {
    // Send the GPT-generated greeting, then show buttons
    await whatsappService.sendText(from, freeformAnswer);
  }

  const greeting = freeformAnswer
    ? (lang === 'nl' ? 'Wat kan ik voor je doen?' : 'What can I do for you?')
    : (name
        ? (lang === 'nl' ? `Hallo ${name}! Welkom bij ${config.SPA_NAME}. Hoe kan ik je helpen?` : `Hello ${name}! Welcome to ${config.SPA_NAME}. How can I help you?`)
        : (lang === 'nl' ? `Hallo! Welkom bij ${config.SPA_NAME}. Hoe kan ik je helpen?` : `Hello! Welcome to ${config.SPA_NAME}. How can I help you?`));

  const buttons = lang === 'nl'
    ? [
        { id: 'menu_book', title: 'Afspraak maken' },
        { id: 'menu_appointments', title: 'Mijn afspraken' },
        { id: 'menu_info', title: 'Informatie' },
      ]
    : [
        { id: 'menu_book', title: 'Book appointment' },
        { id: 'menu_appointments', title: 'My appointments' },
        { id: 'menu_info', title: 'Information' },
      ];

  return whatsappService.sendButtons(from, freeformAnswer ? greeting : greeting, buttons);
}

async function requestHumanHandoff(from, originalMessage) {
  const lang = getLang(from);
  const conv = conversationService.get(from);
  const customerName = conv?.userName || 'Unknown';

  // Log escalation to DB
  db.logEscalation(from, customerName, 'human_handoff', originalMessage || 'Customer requested to speak with a team member');
  db.markConversationEscalated(from);

  // Send escalation email to the team
  emailService.sendEscalationEmail({
    customerName,
    customerPhone: from,
    message: originalMessage || 'Customer requested to speak with a team member',
  }).catch((err) => logger.error('Escalation email error:', err.message));

  // Let the customer know
  const msg = lang === 'nl'
    ? 'Ik heb je vraag doorgegeven aan ons team. Een medewerker neemt zo snel mogelijk contact met je op via WhatsApp of telefoon.\n\nJe kunt ons ook direct bereiken:\n📧 welcome@renessence.com\n📞 +31 20 303 8395'
    : "I've forwarded your request to our team. A team member will get back to you as soon as possible via WhatsApp or phone.\n\nYou can also reach us directly:\n📧 welcome@renessence.com\n📞 +31 20 303 8395";

  return whatsappService.sendText(from, msg);
}

async function sendFallback(from) {
  const lang = getLang(from);
  const msg = lang === 'nl'
    ? 'Sorry, ik begreep je niet helemaal. Waar kan ik je mee helpen?'
    : "Sorry, I didn't quite understand. How can I help you?";
  const buttons = lang === 'nl'
    ? [
        { id: 'menu_book', title: 'Afspraak maken' },
        { id: 'menu_appointments', title: 'Mijn afspraken' },
        { id: 'menu_info', title: 'Informatie' },
      ]
    : [
        { id: 'menu_book', title: 'Book appointment' },
        { id: 'menu_appointments', title: 'My appointments' },
        { id: 'menu_info', title: 'Information' },
      ];

  return whatsappService.sendButtons(from, msg, buttons);
}

async function showInfoMenu(from) {
  const lang = getLang(from);
  const msg = lang === 'nl' ? 'Waar wil je meer over weten?' : 'What would you like to know more about?';
  const rows = lang === 'nl'
    ? [
        { id: 'info_openingstijden', title: 'Openingstijden', description: 'Wanneer zijn we open?' },
        { id: 'info_locatie', title: 'Locatie & bereikbaarheid', description: 'Adres, parkeren, OV' },
        { id: 'info_behandelingen', title: 'Behandelingen', description: 'Wat bieden we aan?' },
        { id: 'info_prijzen', title: 'Prijzen', description: 'Wat kost een behandeling?' },
        { id: 'info_voorbereiding', title: 'Voorbereiding', description: 'Wat moet ik meenemen?' },
        { id: 'info_huisregels', title: 'Huisregels', description: 'Onze afspraken' },
        { id: 'info_cadeaubon', title: 'Cadeaubonnen', description: 'Een behandeling cadeau geven' },
        { id: 'info_corporate', title: 'Corporate & events', description: 'Zakelijke mogelijkheden' },
        { id: 'info_other', title: 'Andere vraag', description: 'Stel je eigen vraag' },
      ]
    : [
        { id: 'info_openingstijden', title: 'Opening hours', description: 'When are we open?' },
        { id: 'info_locatie', title: 'Location & directions', description: 'Address, parking, transit' },
        { id: 'info_behandelingen', title: 'Treatments', description: 'What do we offer?' },
        { id: 'info_prijzen', title: 'Prices', description: 'How much does a treatment cost?' },
        { id: 'info_voorbereiding', title: 'Preparation', description: 'What should I bring?' },
        { id: 'info_huisregels', title: 'House rules', description: 'Our guidelines' },
        { id: 'info_cadeaubon', title: 'Gift cards', description: 'Give a treatment as a gift' },
        { id: 'info_corporate', title: 'Corporate & events', description: 'Business options' },
        { id: 'info_other', title: 'Other question', description: 'Ask your own question' },
      ];

  const btnLabel = lang === 'nl' ? 'Bekijk onderwerpen' : 'View topics';
  const sectionTitle = lang === 'nl' ? 'Informatie' : 'Information';

  return whatsappService.sendList(from, msg, btnLabel, [{ title: sectionTitle, rows }]);
}

async function handleInfoTopic(from, topic) {
  // Use Claude/GPT to generate an answer from the knowledge base
  const lang = getLang(from);
  const result = await claudeService.detectIntent(topic, conversationService.get(from)?.userName || '');

  if (result.freeformAnswer) {
    return whatsappService.sendText(from, result.freeformAnswer);
  }

  // Fallback to FAQ handler
  return faqHandler.answer(from, topic, null);
}

module.exports = { handle };
