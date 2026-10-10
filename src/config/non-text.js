/**
 * Guest messages the bot can't read as text (photos without caption, stickers,
 * voice notes it couldn't transcribe…). They are logged as placeholder rows and
 * get a short automatic acknowledgement.
 *
 * Neither is a real exchange: the outage catch-up must not treat an ack as
 * "answered" (it would hide the guest's real question before it) and must
 * never replay a placeholder to the AI as if it were the question.
 */
const TEXT_ONLY_ACK = {
  en: 'Sorry, I can only process text messages.',
  nl: 'Sorry, ik kan alleen tekstberichten verwerken.',
};
const VOICE_ACK = "Sorry, I couldn't understand your voice message. Could you type your message instead?";
const PHOTO_ACK = 'Bedankt voor je foto! 📸 Ik heb deze met ons team gedeeld. Kan ik je verder ergens mee helpen?';

const NON_TEXT_ACKS = [TEXT_ONLY_ACK.en, TEXT_ONLY_ACK.nl, VOICE_ACK, PHOTO_ACK];

/** "[image:#12]", "[sticker message]", "[voice message]" … */
function isPlaceholder(content) {
  return /^\[(?:image:#\d+|[\w-]+ message)\]$/.test(String(content || '').trim());
}

module.exports = { TEXT_ONLY_ACK, VOICE_ACK, PHOTO_ACK, NON_TEXT_ACKS, isPlaceholder };
