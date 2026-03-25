const OpenAI = require('openai');
const config = require('../config');
const { buildSystemPrompt } = require('../config/constants');
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

// Load services list for the system prompt
function getServicesList() {
  try {
    const servicesPath = path.join(__dirname, '../data/services.json');
    const services = JSON.parse(fs.readFileSync(servicesPath, 'utf-8'));
    if (services.length === 0) return null;
    return services
      .map((s) => `- ${s.Name} (${s.DefaultTimeLength} min) - EUR ${s.Price || 'n.v.t.'}`)
      .join('\n');
  } catch {
    return null;
  }
}

async function detectIntent(userMessage, userName) {
  const servicesList = getServicesList();
  const systemPrompt = buildSystemPrompt(servicesList);

  try {
    const response = await openai.chat.completions.create({
      model: config.OPENAI_MODEL,
      max_tokens: 1024,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Klant "${userName}" zegt: "${userMessage}"` },
      ],
    });

    const text = response.choices[0].message.content;

    // Try to parse JSON from the response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('OpenAI returned non-JSON response:', text);
      return { intent: 'unknown', confidence: 0, entities: {}, faqTopic: null, freeformAnswer: null };
    }

    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    logger.error('OpenAI API error:', err.message);
    return { intent: 'unknown', confidence: 0, entities: {}, faqTopic: null, freeformAnswer: null };
  }
}

module.exports = { detectIntent };
