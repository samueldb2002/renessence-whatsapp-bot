// Bilingual messages: English (default) and Dutch
const messages = {
  // Greetings & general
  welcome: {
    en: 'Welcome to Renessence! How can I help you today?',
    nl: 'Welkom bij Renessence! Hoe kan ik je vandaag helpen?',
  },
  unknownIntent: {
    en: "I'm not sure what you mean. I can help you with:\n\n• Book an appointment\n• Check your appointments\n• Answer questions about our treatments\n\nWhat would you like to do?",
    nl: 'Ik weet niet precies wat je bedoelt. Ik kan je helpen met:\n\n• Een afspraak boeken\n• Je afspraken bekijken\n• Vragen beantwoorden over onze behandelingen\n\nWat wil je doen?',
  },
  humanHandoff: {
    en: 'For questions about memberships and subscriptions, please visit our website at renessence.com or email us at welcome@renessence.com.',
    nl: 'Voor vragen over memberships en abonnementen, bezoek onze website op renessence.com of mail ons via welcome@renessence.com.',
  },

  // Booking flow - categories
  pickCategory: {
    en: 'Which category of treatment are you looking for?',
    nl: 'Welke categorie behandeling zoek je?',
  },
  categoryNotFound: {
    en: 'Category not found. Please try again.',
    nl: 'Categorie niet gevonden. Probeer opnieuw.',
  },
  chooseTreatment: {
    en: (cat) => `Choose a ${cat} treatment:`,
    nl: (cat) => `Kies een ${cat} behandeling:`,
  },
  viewOptions: {
    en: 'View options',
    nl: 'Bekijk opties',
  },

  // Booking flow - service
  serviceNotFound: {
    en: "I couldn't find that treatment. Please choose a treatment from the list:",
    nl: 'Die behandeling heb ik niet gevonden. Kies een behandeling uit de lijst:',
  },

  // Booking flow - date
  pickDate: {
    en: (service) => `When would you like to book ${service}?`,
    nl: (service) => `Wanneer wil je ${service} boeken?`,
  },
  today: { en: 'Today', nl: 'Vandaag' },
  tomorrow: { en: 'Tomorrow', nl: 'Morgen' },
  thisWeek: { en: 'This week', nl: 'Deze week' },

  // Booking flow - time
  noTimesAvailable: {
    en: 'Unfortunately, there are no times available in that period. Would you like to try another day?',
    nl: 'Helaas zijn er geen tijden beschikbaar in die periode. Wil je een andere dag proberen?',
  },
  chooseTimeSlot: {
    en: 'Choose an available time slot:',
    nl: 'Kies een beschikbaar tijdslot:',
  },
  viewTimes: {
    en: 'View times',
    nl: 'Tijden bekijken',
  },
  availableTimes: {
    en: 'Available times',
    nl: 'Beschikbare tijden',
  },
  available: {
    en: 'Available',
    nl: 'Beschikbaar',
  },
  chooseFromList: {
    en: 'Please choose a time from the list above by tapping "View times".',
    nl: 'Kies alsjeblieft een tijd uit de lijst hierboven door op "Tijden bekijken" te tappen.',
  },
  errorFetchingTimes: {
    en: 'Something went wrong while fetching available times. Please try again later.',
    nl: 'Er ging iets mis bij het ophalen van beschikbare tijden. Probeer het later opnieuw.',
  },

  // Booking flow - collect client info
  askName: {
    en: "I need your details to make the booking. What is your full name?",
    nl: 'Ik heb je gegevens nodig om de boeking te maken. Wat is je volledige naam?',
  },
  askEmail: {
    en: (name) => `Thanks ${name}! What is your email address?`,
    nl: (name) => `Bedankt ${name}! Wat is je e-mailadres?`,
  },
  invalidEmail: {
    en: "That doesn't look like a valid email address. Please try again:",
    nl: 'Dat lijkt geen geldig e-mailadres. Probeer opnieuw:',
  },

  // Booking flow - confirm
  confirmBooking: {
    en: (service, date, time) => `Please confirm your booking:\n\n*${service}*\n📅 ${date}\n🕐 ${time}\n\nWould you like to confirm?`,
    nl: (service, date, time) => `Bevestig je boeking:\n\n*${service}*\n📅 ${date}\n🕐 ${time}\n\nWil je bevestigen?`,
  },
  confirm: { en: 'Confirm', nl: 'Bevestigen' },
  cancel: { en: 'Cancel', nl: 'Annuleren' },
  bookingConfirmed: {
    en: (service, date, time) =>
      `Your appointment is confirmed! ✅\n\n${service}\n${date} at ${time}\n\nYou will receive a reminder 24 hours and 2 hours before your appointment.\nSee you at Renessence!`,
    nl: (service, date, time) =>
      `Je afspraak is bevestigd! ✅\n\n${service}\n${date} om ${time}\n\nJe ontvangt een herinnering 24 uur en 2 uur van tevoren.\nTot dan bij Renessence!`,
  },
  bookingCancelled: {
    en: 'Booking cancelled. Is there anything else I can help you with?',
    nl: 'Boeking geannuleerd. Kan ik je ergens anders mee helpen?',
  },

  // Booking errors
  timeNotAvailable: {
    en: "Unfortunately, this time slot is no longer available. Please choose another date/time:",
    nl: 'Helaas is dit tijdslot net niet meer beschikbaar. Kies een andere datum/tijd:',
  },
  bookingError: {
    en: 'Sorry, something went wrong with the booking. Please try again or contact us at welcome@renessence.com.',
    nl: 'Sorry, er ging iets mis bij het boeken. Probeer het opnieuw of neem contact op via welcome@renessence.com.',
  },

  // Check appointments
  noAppointments: {
    en: "I couldn't find any appointments for this phone number. Would you like to book a treatment?",
    nl: 'Ik kan geen afspraken vinden voor dit telefoonnummer. Wil je een behandeling boeken?',
  },

  // Reset
  conversationReset: {
    en: 'No problem! What can I help you with?',
    nl: 'Geen probleem! Waar kan ik je mee helpen?',
  },
};

/**
 * Get a message in the correct language
 * @param {string} key - Message key
 * @param {string} lang - 'en' or 'nl' (defaults to 'en')
 * @param  {...any} args - Arguments for template functions
 */
function t(key, lang = 'en', ...args) {
  const msg = messages[key];
  if (!msg) return key;
  const text = msg[lang] || msg.en;
  if (typeof text === 'function') return text(...args);
  return text;
}

module.exports = { t, messages };
