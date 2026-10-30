/**
 * The knowledge base's FAQ answers the team edits in the dashboard ("Bot
 * content" → FAQ). Answers the code enforces or rewrites stay out: the
 * 24-hour cancellation rule and the treatment credit are what the cancel tool
 * and the refund emails do, and the membership answers follow the Passes &
 * Memberships section (system-prompt.js withNewOffering).
 */
const kb = require('../data/knowledge-base.json');

const LOCKED_FAQ_KEYS = [
  'cancellation', 'cancellation_credit',
  'annual_membership_discount', 'can_i_share_membership', 'pause_membership',
  'membership_includes', 'treatment_limits_membership', 'additional_experiences_membership',
];

// How the team sees each topic in the dashboard.
const TOPICS = {
  what_is_renessence: 'What is Renessence?',
  what_to_bring: 'What to bring',
  arrival_time: 'When to arrive',
  can_shower_after: 'Showering after a session',
  pregnancy: 'Pregnancy',
  medical_health: 'Health and medical conditions',
  can_i_bring_guest: 'Bringing a guest',
  invoice_for_company: 'Company invoices',
  parking: 'Parking',
  lockers: 'Lockers and changing rooms',
  no_laptop_rule: 'Laptops',
  kids: 'Children and minimum age',
  pets: 'Pets',
  loyalty_points_check: 'Loyalty points',
  gift_card_online_issue: 'Gift card problems online',
  treatment_order_oxygen_sauna: 'Order of oxygen and sauna',
};

const DEFAULT_FAQ = {
  items: Object.entries(kb.faq || {})
    .filter(([key]) => !LOCKED_FAQ_KEYS.includes(key))
    .map(([key, answer]) => ({ key, topic: TOPICS[key] || key.replace(/_/g, ' '), answer })),
};

/** "Towels and robes" → "towels_and_robes": the key a new topic gets in the knowledge base. */
const faqKey = (topic) => String(topic).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50);

module.exports = { DEFAULT_FAQ, LOCKED_FAQ_KEYS, faqKey };
