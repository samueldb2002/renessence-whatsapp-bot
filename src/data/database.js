const { Pool } = require('pg');
const logger = require('../utils/logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function initialize() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(20) NOT NULL,
        customer_name VARCHAR(100),
        language VARCHAR(5),
        started_at TIMESTAMPTZ DEFAULT NOW(),
        ended_at TIMESTAMPTZ,
        message_count INTEGER DEFAULT 1,
        intent VARCHAR(50),
        resolved BOOLEAN DEFAULT FALSE,
        escalated BOOLEAN DEFAULT FALSE,
        last_message_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS booking_events (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(20) NOT NULL,
        customer_name VARCHAR(100),
        session_type_id INTEGER,
        service_name VARCHAR(100),
        staff_name VARCHAR(100),
        appointment_date TIMESTAMPTZ,
        status VARCHAR(20) DEFAULT 'started',
        stripe_session_id VARCHAR(255),
        stripe_payment_intent VARCHAR(255),
        amount_cents INTEGER,
        currency VARCHAR(3) DEFAULT 'eur',
        payment_method VARCHAR(20),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        paid_at TIMESTAMPTZ,
        cancelled_at TIMESTAMPTZ,
        cancel_reason VARCHAR(50),
        no_show BOOLEAN DEFAULT FALSE,
        no_show_marked_at TIMESTAMPTZ,
        mindbody_appointment_id INTEGER
      );

      CREATE TABLE IF NOT EXISTS escalations (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(20) NOT NULL,
        customer_name VARCHAR(100),
        reason TEXT,
        message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        resolved BOOLEAN DEFAULT FALSE,
        resolved_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS faq_queries (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(20),
        topic VARCHAR(50),
        question TEXT,
        answered BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS unanswered_questions (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(20),
        customer_name VARCHAR(100),
        question TEXT NOT NULL,
        intent VARCHAR(50),
        occurrences INTEGER DEFAULT 1,
        first_asked_at TIMESTAMPTZ DEFAULT NOW(),
        last_asked_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_unanswered_occurrences ON unanswered_questions(occurrences DESC);

      CREATE TABLE IF NOT EXISTS errors (
        id SERIAL PRIMARY KEY,
        type VARCHAR(50),
        message TEXT,
        stack TEXT,
        context TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS reminders (
        id SERIAL PRIMARY KEY,
        appointment_id INTEGER,
        phone VARCHAR(20),
        type VARCHAR(10),
        sent_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_booking_events_created ON booking_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_booking_events_status ON booking_events(status);
      CREATE INDEX IF NOT EXISTS idx_conversations_started ON conversations(started_at);
      CREATE INDEX IF NOT EXISTS idx_escalations_resolved ON escalations(resolved);
      CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations(phone);
      CREATE INDEX IF NOT EXISTS idx_booking_events_phone ON booking_events(phone);
    `);
    logger.info('Database tables initialized');
  } finally {
    client.release();
  }
}

// --- Conversations ---

async function logConversation(phone, customerName, language, intent) {
  try {
    // Try to find an active conversation (last message within 30 min)
    const existing = await pool.query(
      `SELECT id FROM conversations WHERE phone = $1 AND ended_at IS NULL AND last_message_at > NOW() - INTERVAL '30 minutes' ORDER BY started_at DESC LIMIT 1`,
      [phone]
    );
    if (existing.rows.length > 0) {
      await pool.query(
        `UPDATE conversations SET message_count = message_count + 1, last_message_at = NOW(), intent = COALESCE($2, intent), customer_name = COALESCE($3, customer_name), language = COALESCE($4, language) WHERE id = $1`,
        [existing.rows[0].id, intent, customerName, language]
      );
      return existing.rows[0].id;
    }
    const result = await pool.query(
      `INSERT INTO conversations (phone, customer_name, language, intent) VALUES ($1, $2, $3, $4) RETURNING id`,
      [phone, customerName, language, intent]
    );
    return result.rows[0].id;
  } catch (err) {
    logger.error('DB logConversation error:', err.message);
  }
}

async function endConversation(phone) {
  try {
    await pool.query(
      `UPDATE conversations SET ended_at = NOW(), resolved = TRUE WHERE phone = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
      [phone]
    );
  } catch (err) {
    logger.error('DB endConversation error:', err.message);
  }
}

async function markConversationEscalated(phone) {
  try {
    await pool.query(
      `UPDATE conversations SET escalated = TRUE WHERE phone = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
      [phone]
    );
  } catch (err) {
    logger.error('DB markConversationEscalated error:', err.message);
  }
}

// --- Booking Events ---

async function logBookingEvent({ phone, customerName, sessionTypeId, serviceName, status, amountCents }) {
  try {
    const result = await pool.query(
      `INSERT INTO booking_events (phone, customer_name, session_type_id, service_name, status, amount_cents) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [phone, customerName, sessionTypeId, serviceName, status || 'started', amountCents]
    );
    return result.rows[0].id;
  } catch (err) {
    logger.error('DB logBookingEvent error:', err.message);
  }
}

async function updateBookingEvent(id, updates) {
  if (!id) return;
  const fields = [];
  const values = [];
  let idx = 1;
  for (const [key, val] of Object.entries(updates)) {
    const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    fields.push(`${col} = $${idx}`);
    values.push(val);
    idx++;
  }
  if (fields.length === 0) return;
  values.push(id);
  try {
    await pool.query(`UPDATE booking_events SET ${fields.join(', ')} WHERE id = $${idx}`, values);
  } catch (err) {
    logger.error('DB updateBookingEvent error:', err.message);
  }
}

async function updateBookingByStripeSession(stripeSessionId, updates) {
  if (!stripeSessionId) return;
  const fields = [];
  const values = [];
  let idx = 1;
  for (const [key, val] of Object.entries(updates)) {
    const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    fields.push(`${col} = $${idx}`);
    values.push(val);
    idx++;
  }
  if (fields.length === 0) return;
  values.push(stripeSessionId);
  try {
    await pool.query(`UPDATE booking_events SET ${fields.join(', ')} WHERE stripe_session_id = $${idx}`, values);
  } catch (err) {
    logger.error('DB updateBookingByStripeSession error:', err.message);
  }
}

// --- Escalations ---

async function logEscalation(phone, customerName, reason, message) {
  try {
    await pool.query(
      `INSERT INTO escalations (phone, customer_name, reason, message) VALUES ($1, $2, $3, $4)`,
      [phone, customerName, reason, message]
    );
  } catch (err) {
    logger.error('DB logEscalation error:', err.message);
  }
}

async function resolveEscalation(id) {
  try {
    await pool.query(`UPDATE escalations SET resolved = TRUE, resolved_at = NOW() WHERE id = $1`, [id]);
  } catch (err) {
    logger.error('DB resolveEscalation error:', err.message);
  }
}

// --- FAQ ---

async function logFaqQuery(phone, topic, question) {
  try {
    await pool.query(
      `INSERT INTO faq_queries (phone, topic, question) VALUES ($1, $2, $3)`,
      [phone, topic, question]
    );
  } catch (err) {
    logger.error('DB logFaqQuery error:', err.message);
  }
}

// --- Unanswered Questions ---

async function logUnansweredQuestion(phone, customerName, question, intent) {
  try {
    // Check if a similar question already exists (fuzzy match on first 100 chars)
    const short = (question || '').substring(0, 100).toLowerCase().trim();
    const existing = await pool.query(
      `SELECT id FROM unanswered_questions WHERE LOWER(LEFT(question, 100)) = $1 LIMIT 1`,
      [short]
    );
    if (existing.rows.length > 0) {
      await pool.query(
        `UPDATE unanswered_questions SET occurrences = occurrences + 1, last_asked_at = NOW() WHERE id = $1`,
        [existing.rows[0].id]
      );
    } else {
      await pool.query(
        `INSERT INTO unanswered_questions (phone, customer_name, question, intent) VALUES ($1, $2, $3, $4)`,
        [phone, customerName, question, intent]
      );
    }
  } catch (err) {
    logger.error('DB logUnansweredQuestion error:', err.message);
  }
}

// --- Errors ---

async function logError(type, message, stack, context) {
  try {
    await pool.query(
      `INSERT INTO errors (type, message, stack, context) VALUES ($1, $2, $3, $4)`,
      [type, message, stack, typeof context === 'string' ? context : JSON.stringify(context)]
    );
  } catch (err) {
    // Don't recurse — just console.error
    console.error('DB logError failed:', err.message);
  }
}

// --- Reminders ---

async function logReminder(appointmentId, phone, type) {
  try {
    await pool.query(
      `INSERT INTO reminders (appointment_id, phone, type) VALUES ($1, $2, $3)`,
      [appointmentId, phone, type]
    );
  } catch (err) {
    logger.error('DB logReminder error:', err.message);
  }
}

async function hasReminderBeenSent(appointmentId, type) {
  try {
    const result = await pool.query(
      `SELECT id FROM reminders WHERE appointment_id = $1 AND type = $2 LIMIT 1`,
      [appointmentId, type]
    );
    return result.rows.length > 0;
  } catch (err) {
    logger.error('DB hasReminderBeenSent error:', err.message);
    return false;
  }
}

// --- Query helpers for dashboard ---

async function query(text, params) {
  return pool.query(text, params);
}

module.exports = {
  initialize,
  query,
  pool,
  // Conversations
  logConversation,
  endConversation,
  markConversationEscalated,
  // Bookings
  logBookingEvent,
  updateBookingEvent,
  updateBookingByStripeSession,
  // Escalations
  logEscalation,
  resolveEscalation,
  // FAQ
  logFaqQuery,
  // Unanswered
  logUnansweredQuestion,
  // Errors
  logError,
  // Reminders
  logReminder,
  hasReminderBeenSent,
};
