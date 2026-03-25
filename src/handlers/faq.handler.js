const whatsappService = require('../services/whatsapp.service');
const config = require('../config');
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');

// Load FAQ data
const faqPath = path.join(__dirname, '../data/faq.json');
let faqData = {};
try {
  faqData = JSON.parse(fs.readFileSync(faqPath, 'utf-8'));
} catch {
  logger.warn('Could not load FAQ data');
}

const db = require('../data/database');

async function answer(from, faqTopic, freeformAnswer) {
  // Log FAQ query to DB
  db.logFaqQuery(from, faqTopic, freeformAnswer ? 'ai_answer' : faqTopic);

  // If Claude already generated an answer, use it
  if (freeformAnswer) {
    return whatsappService.sendText(from, freeformAnswer);
  }

  // Otherwise look up from static FAQ data
  if (faqTopic && faqData[faqTopic]) {
    let answer = faqData[faqTopic];
    // Replace placeholders
    answer = answer.replace('{SPA_ADDRESS}', config.SPA_ADDRESS);
    answer = answer.replace('{SPA_PHONE}', config.SPA_PHONE);
    answer = answer.replace('{SPA_NAME}', config.SPA_NAME);
    return whatsappService.sendText(from, answer);
  }

  // Fallback
  return whatsappService.sendText(
    from,
    `Ik heb helaas geen antwoord op die vraag. Je kunt ons bereiken op ${config.SPA_PHONE} voor meer informatie.`
  );
}

module.exports = { answer };
