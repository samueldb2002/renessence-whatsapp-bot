const { Pool } = require('pg');
const logger = require('../utils/logger');

// M2: validate SSL certs by default; set DB_SSL_SELF_SIGNED=true only for legacy self-signed cert DBs
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true'
    ? { rejectUnauthorized: process.env.DB_SSL_SELF_SIGNED !== 'true' }
    : false,
});

// M6: handle idle pool errors so they don't crash the process
pool.on('error', (err) => {
  logger.error('PostgreSQL pool error:', err.message);
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

      CREATE TABLE IF NOT EXISTS conversation_messages (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(20) NOT NULL,
        role VARCHAR(10) NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS paused_conversations (
        phone VARCHAR(20) PRIMARY KEY,
        paused_at TIMESTAMPTZ DEFAULT NOW(),
        customer_name VARCHAR(100)
      );

      CREATE TABLE IF NOT EXISTS media (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(64),
        mime VARCHAR(60),
        data BYTEA NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_conv_messages_phone ON conversation_messages(phone, created_at);
      CREATE INDEX IF NOT EXISTS idx_booking_events_created ON booking_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_booking_events_status ON booking_events(status);
      CREATE INDEX IF NOT EXISTS idx_conversations_started ON conversations(started_at);
      CREATE INDEX IF NOT EXISTS idx_escalations_resolved ON escalations(resolved);
      CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations(phone);
      CREATE INDEX IF NOT EXISTS idx_booking_events_phone ON booking_events(phone);
      CREATE INDEX IF NOT EXISTS idx_booking_events_mb_appointment ON booking_events(mindbody_appointment_id);
      CREATE INDEX IF NOT EXISTS idx_booking_events_stripe_session ON booking_events(stripe_session_id);
    `);

    // Webhook deduplication: survive server restarts across Meta retry windows (up to 24h)
    await client.query(`
      CREATE TABLE IF NOT EXISTS processed_webhook_ids (
        message_id VARCHAR(255) PRIMARY KEY,
        processed_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_processed_webhook_ids_at ON processed_webhook_ids(processed_at);
    `);
    // Prune IDs older than 24h — Meta never retries beyond that window
    await client.query(`DELETE FROM processed_webhook_ids WHERE processed_at < NOW() - INTERVAL '24 hours'`);

    // Migrations: add columns that may not exist in older deployments
    await client.query(`
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT FALSE;
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
    `);

    // Webchat uses "web_<sessionId>" (~40 chars) as the phone key, which
    // overflows the original phone VARCHAR(20) and silently dropped every
    // web message / booking_event / escalation insert. Widen phone columns.
    await client.query(`
      ALTER TABLE conversations          ALTER COLUMN phone TYPE VARCHAR(64);
      ALTER TABLE conversation_messages  ALTER COLUMN phone TYPE VARCHAR(64);
      ALTER TABLE booking_events         ALTER COLUMN phone TYPE VARCHAR(64);
      ALTER TABLE escalations            ALTER COLUMN phone TYPE VARCHAR(64);
      ALTER TABLE reminders              ALTER COLUMN phone TYPE VARCHAR(64);
      ALTER TABLE paused_conversations   ALTER COLUMN phone TYPE VARCHAR(64);
      ALTER TABLE faq_queries            ALTER COLUMN phone TYPE VARCHAR(64);
      ALTER TABLE unanswered_questions   ALTER COLUMN phone TYPE VARCHAR(64);
    `);
    logger.info('Database migrations applied');

    // M11: prune conversation_messages older than 90 days to prevent unbounded growth
    const pruneResult = await client.query(
      `DELETE FROM conversation_messages WHERE created_at < NOW() - INTERVAL '90 days'`
    );
    if (pruneResult.rowCount > 0) {
      logger.info(`Pruned ${pruneResult.rowCount} conversation messages older than 90 days`);
    }

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
    // Postgres does not allow ORDER BY/LIMIT directly on UPDATE — target the
    // most recent open conversation via a subquery on the primary key.
    await pool.query(
      `UPDATE conversations SET escalated = TRUE
       WHERE id = (
         SELECT id FROM conversations
         WHERE phone = $1 AND ended_at IS NULL
         ORDER BY started_at DESC
         LIMIT 1
       )`,
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

// Idempotency: find a fresh, non-cancelled booking for the same customer +
// session type + time. Used to stop the model from creating a duplicate when
// it re-fires book_appointment (e.g. after a transient "slot taken").
async function getRecentBooking(phone, sessionTypeId, startDateTime) {
  if (!phone || !sessionTypeId || !startDateTime) return null;
  try {
    const r = await pool.query(
      `SELECT * FROM booking_events
       WHERE phone = $1 AND session_type_id = $2 AND appointment_date = $3
         AND mindbody_appointment_id IS NOT NULL
         AND status NOT IN ('expired', 'cancelled')
         AND created_at > NOW() - INTERVAL '15 minutes'
       ORDER BY created_at DESC
       LIMIT 1`,
      [phone, sessionTypeId, startDateTime]
    );
    return r.rows[0] || null;
  } catch (err) {
    logger.error('DB getRecentBooking error:', err.message);
    return null;
  }
}

async function getBookingEventById(id) {
  if (!id) return null;
  try {
    const result = await pool.query('SELECT * FROM booking_events WHERE id = $1 LIMIT 1', [id]);
    return result.rows[0] || null;
  } catch (err) {
    logger.error('DB getBookingEventById error:', err.message);
    return null;
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

async function getBookingByStripeSession(stripeSessionId) {
  if (!stripeSessionId) return null;
  try {
    const result = await pool.query(
      'SELECT * FROM booking_events WHERE stripe_session_id = $1 LIMIT 1',
      [stripeSessionId]
    );
    return result.rows[0] || null;
  } catch (err) {
    logger.error('DB getBookingByStripeSession error:', err.message);
    return null;
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

// Safety-net: fetch unpaid bookings older than `minutes` that still hold a
// Mindbody appointment. Used by the expire-stale-bookings cron so expiry no
// longer depends on Stripe's webhook timing or on the AI threading the
// booking_event_id through send_payment.
async function getStaleUnpaidBookings(minutes) {
  try {
    const result = await pool.query(
      `SELECT * FROM booking_events
       WHERE status IN ('pending', 'confirmed', 'payment_sent')
         AND mindbody_appointment_id IS NOT NULL
         AND created_at < NOW() - ($1 || ' minutes')::interval
         AND created_at > NOW() - INTERVAL '24 hours'
         AND (appointment_date IS NULL OR appointment_date > NOW())
       ORDER BY created_at ASC
       LIMIT 50`,
      [String(minutes)]
    );
    return result.rows || [];
  } catch (err) {
    logger.error('DB getStaleUnpaidBookings error:', err.message);
    return [];
  }
}

// C8: look up a pending (unpaid) stripe session by Mindbody appointment ID
async function getPendingStripeSessionByAppointment(mindbodyAppointmentId) {
  if (!mindbodyAppointmentId) return null;
  try {
    const result = await pool.query(
      `SELECT stripe_session_id FROM booking_events
       WHERE mindbody_appointment_id = $1 AND status NOT IN ('paid', 'expired', 'cancelled')
       ORDER BY created_at DESC LIMIT 1`,
      [parseInt(mindbodyAppointmentId, 10)]
    );
    return result.rows[0]?.stripe_session_id || null;
  } catch (err) {
    logger.error('DB getPendingStripeSessionByAppointment error:', err.message);
    return null;
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

// --- Conversation Messages ---

// Store an inbound media file (e.g. a photo the customer sent). Returns its id.
async function saveMedia(phone, mime, buffer) {
  try {
    const r = await pool.query(
      `INSERT INTO media (phone, mime, data) VALUES ($1, $2, $3) RETURNING id`,
      [phone, mime || 'application/octet-stream', buffer]
    );
    return r.rows[0].id;
  } catch (err) {
    logger.error('DB saveMedia error:', err.message);
    return null;
  }
}

async function getMedia(id) {
  try {
    const r = await pool.query(`SELECT mime, data FROM media WHERE id = $1`, [parseInt(id, 10)]);
    return r.rows[0] || null;
  } catch (err) {
    logger.error('DB getMedia error:', err.message);
    return null;
  }
}

async function logMessage(phone, role, content) {
  try {
    await pool.query(
      `INSERT INTO conversation_messages (phone, role, content) VALUES ($1, $2, $3)`,
      [phone, role, content]
    );
  } catch (err) {
    logger.error('DB logMessage error:', err.message);
  }
}

async function getMessagesByPhone(phone, limit = 200) {
  try {
    const result = await pool.query(
      `SELECT role, content, created_at FROM conversation_messages WHERE phone = $1 ORDER BY created_at ASC LIMIT $2`,
      [phone, limit]
    );
    return result.rows;
  } catch (err) {
    logger.error('DB getMessagesByPhone error:', err.message);
    return [];
  }
}

async function getMessagesSince(phone, since) {
  try {
    const result = await pool.query(
      `SELECT role, content, created_at FROM conversation_messages WHERE phone = $1 AND created_at > $2 ORDER BY created_at ASC`,
      [phone, since]
    );
    return result.rows;
  } catch (err) {
    logger.error('DB getMessagesSince error:', err.message);
    return [];
  }
}

// --- Per-customer bot pause ---

async function pauseConversation(phone, customerName) {
  try {
    await pool.query(
      `INSERT INTO paused_conversations (phone, paused_at, customer_name)
       VALUES ($1, NOW(), $2)
       ON CONFLICT (phone) DO UPDATE SET paused_at = NOW(), customer_name = $2`,
      [phone, customerName || null]
    );
  } catch (err) {
    logger.error('DB pauseConversation error:', err.message);
  }
}

async function resumeConversation(phone) {
  try {
    const result = await pool.query(
      `DELETE FROM paused_conversations WHERE phone = $1 RETURNING paused_at`,
      [phone]
    );
    return result.rows[0]?.paused_at || null;
  } catch (err) {
    logger.error('DB resumeConversation error:', err.message);
    return null;
  }
}

async function isPaused(phone) {
  try {
    const result = await pool.query(
      `SELECT 1 FROM paused_conversations WHERE phone = $1`,
      [phone]
    );
    return result.rows.length > 0;
  } catch (err) {
    logger.error('DB isPaused error:', err.message);
    return false;
  }
}

async function getPausedConversations() {
  try {
    const result = await pool.query(
      `SELECT phone, paused_at, customer_name FROM paused_conversations ORDER BY paused_at DESC`
    );
    return result.rows;
  } catch (err) {
    logger.error('DB getPausedConversations error:', err.message);
    return [];
  }
}

// --- Archive ---

async function archiveConversation(phone) {
  await pool.query(
    `UPDATE conversations SET archived = TRUE, archived_at = NOW() WHERE phone = $1`,
    [phone]
  );
}

async function unarchiveConversation(phone) {
  await pool.query(
    `UPDATE conversations SET archived = FALSE, archived_at = NULL WHERE phone = $1`,
    [phone]
  );
}

// --- Webhook deduplication ---

async function isWebhookProcessed(messageId) {
  try {
    const result = await pool.query(
      `SELECT 1 FROM processed_webhook_ids WHERE message_id = $1`,
      [messageId]
    );
    return result.rows.length > 0;
  } catch (err) {
    logger.error('DB isWebhookProcessed error:', err.message);
    return false; // on DB error, let it through (better to double-process than to drop)
  }
}

async function markWebhookProcessed(messageId) {
  try {
    await pool.query(
      `INSERT INTO processed_webhook_ids (message_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [messageId]
    );
  } catch (err) {
    logger.error('DB markWebhookProcessed error:', err.message);
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
  // Messages
  logMessage,
  getMessagesByPhone,
  getMessagesSince,
  // Media (customer photos)
  saveMedia,
  getMedia,
  // Per-customer bot pause
  pauseConversation,
  resumeConversation,
  isPaused,
  getPausedConversations,
  // Bookings
  logBookingEvent,
  getRecentBooking,
  getBookingEventById,
  updateBookingEvent,
  getBookingByStripeSession,
  updateBookingByStripeSession,
  getStaleUnpaidBookings,
  getPendingStripeSessionByAppointment,
  // Archive
  archiveConversation,
  unarchiveConversation,
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
  // Webhook dedup
  isWebhookProcessed,
  markWebhookProcessed,
};
