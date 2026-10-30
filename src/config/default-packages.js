/**
 * Multi-session packages, until the team saves its own list in the dashboard
 * ("Bot content" → Packages). The oxygen 5x was its own block in the prompt;
 * the infrared 5x and Nervous System Reset 3x were knowledge-base prices.
 */
const DEFAULT_PACKAGES = [
  {
    name: '5x Hyperbaric Oxygen Hydroxy (60 min)',
    text: 'Five 60-minute Hyperbaric Oxygen Hydroxy sessions for €350 (vs €475 for 5 separate sessions, so €70 per session), valid for 1 year. Mention it when a customer is interested in oxygen therapy or asks about deals or multiple sessions. It is bought at https://renessence.com/hyperbaric-oxygen-hydroxy, then the customer books the individual sessions.',
  },
  { name: '5x Infrared Sauna (25 min)', text: 'Five 25-minute Infrared Sauna sessions for €125.' },
  { name: '3x Nervous System Reset', text: 'Three Nervous System Reset sessions for €360.' },
];

module.exports = { DEFAULT_PACKAGES };
