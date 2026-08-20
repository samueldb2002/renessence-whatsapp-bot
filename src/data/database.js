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

      CREATE TABLE IF NOT EXISTS blocked_numbers (
        phone VARCHAR(64) PRIMARY KEY,
        reason TEXT,
        blocked_at TIMESTAMPTZ DEFAULT NOW()
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

    // M11: prune conversation_messages older than 6 months to prevent unbounded growth
    const pruneResult = await client.query(
      `DELETE FROM conversation_messages WHERE created_at < NOW() - INTERVAL '6 months'`
    );
    if (pruneResult.rowCount > 0) {
      logger.info(`Pruned ${pruneResult.rowCount} conversation messages older than 6 months`);
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

// appointmentDate and mindbodyAppointmentId ride the INSERT itself. They used
// to be attached in a second write whose failure was swallowed — and a row
// without an appointment id is invisible to every safety-net query, so one
// transient fault produced a permanently untracked live appointment (round-5
// verify finding). One atomic write, or no row at all (and the caller's
// no-audit-row rollback handles "no row").
async function logBookingEvent({ phone, customerName, sessionTypeId, serviceName, status, amountCents, appointmentDate, mindbodyAppointmentId }) {
  try {
    const result = await pool.query(
      `INSERT INTO booking_events (phone, customer_name, session_type_id, service_name, status, amount_cents, appointment_date, mindbody_appointment_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [phone, customerName, sessionTypeId, serviceName, status || 'started', amountCents, appointmentDate || null, mindbodyAppointmentId || null]
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

/**
 * Latest booking_events row for a Mindbody appointment. Used by the payment
 * timelines before cancelling: an appointment whose row reads 'paid' must never
 * be cancelled by an unpaid DUPLICATE session's timeout.
 */
async function getBookingEventByAppointment(mindbodyAppointmentId) {
  if (!mindbodyAppointmentId) return null;
  try {
    const result = await pool.query(
      `SELECT * FROM booking_events WHERE mindbody_appointment_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [parseInt(mindbodyAppointmentId, 10)]
    );
    return result.rows[0] || null;
  } catch (err) {
    logger.error('DB getBookingEventByAppointment error:', err.message);
    return null;
  }
}

/**
 * Compare-and-swap status update for the money pipeline.
 *
 * updateBookingEvent() swallows errors, which let a silently-failed
 * 'payment_sent' write resurrect a booking into a second Stripe session. This
 * variant updates ONLY while the row is still in an expected status and
 * reports what happened, so callers can react instead of assuming:
 *   true  → row updated
 *   false → row exists but its status changed underneath us (e.g. the paid
 *           webhook won a race) — the caller must NOT proceed as if it billed
 *   null  → DB unreachable / row unknown — the caller must treat the write as
 *           UNCONFIRMED, never as done
 *
 * expectedSessionId (optional): additionally require the row to still carry
 * this stripe_session_id, closing the read→write window in which a rollback +
 * re-mint could hand the row to a newer session.
 */
async function updateBookingEventIfStatus(id, allowedStatuses, updates, expectedSessionId) {
  if (!id) return null;
  const fields = [];
  const values = [];
  let idx = 1;
  for (const [key, val] of Object.entries(updates)) {
    const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    fields.push(`${col} = $${idx}`);
    values.push(val);
    idx++;
  }
  if (fields.length === 0) return null;
  values.push(id);
  values.push(allowedStatuses);
  let where = `id = $${idx} AND status = ANY($${idx + 1})`;
  if (expectedSessionId) {
    values.push(expectedSessionId);
    where += ` AND stripe_session_id = $${idx + 2}`;
  }
  try {
    const result = await pool.query(
      `UPDATE booking_events SET ${fields.join(', ')} WHERE ${where} RETURNING id`,
      values
    );
    return result.rowCount > 0;
  } catch (err) {
    logger.error('DB updateBookingEventIfStatus error:', err.message);
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
  // A session-wide write must never demote a paid row: marking a session
  // 'expired' while one of its rows was paid via a race would erase the paid
  // record and expose the appointment to cancellation. Marking rows 'paid' is
  // the only transition allowed to overwrite.
  const paidGuard = updates.status && updates.status !== 'paid' ? ` AND status <> 'paid'` : '';
  try {
    await pool.query(`UPDATE booking_events SET ${fields.join(', ')} WHERE stripe_session_id = $${idx}${paidGuard}`, values);
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

/**
 * Unpaid pay-online bookings whose appointment has ALREADY STARTED and that
 * never got a payment link. getStaleUnpaidBookings deliberately skips these
 * (cancelling a session in progress helps no one), which made them invisible:
 * a booking made <~36 min before its start that missed its one billing window
 * was never billed, never released, never flagged. The cron flags these for
 * the team instead of cancelling (verify finding: postpone path 1).
 */
async function getUnpaidStartedBookings(minutes) {
  try {
    const result = await pool.query(
      `SELECT * FROM booking_events
       WHERE status = 'pending'
         AND stripe_session_id IS NULL
         AND mindbody_appointment_id IS NOT NULL
         AND created_at < NOW() - ($1 || ' minutes')::interval
         AND created_at > NOW() - INTERVAL '24 hours'
         AND appointment_date IS NOT NULL AND appointment_date <= NOW()
       ORDER BY created_at ASC
       LIMIT 50`,
      [String(minutes)]
    );
    return result.rows || [];
  } catch (err) {
    logger.error('DB getUnpaidStartedBookings error:', err.message);
    return [];
  }
}

/**
 * The reconciliation net: rows that reached 'payment_sent' but whose
 * appointment has ALREADY STARTED without the row resolving to paid/expired.
 * Every stranded-row failure mode ends here — an aborted mint whose write
 * landed despite reporting failure, a webhook that could not read the row, a
 * release that failed after the session died. The cron asks Stripe what the
 * session really is: paid → repair; anything else → flag for the team.
 */
async function getAttendedUnresolvedBookings() {
  try {
    // Two shapes converge here: a started appointment whose payment never
    // resolved, and a row MISSING its appointment_date (legacy pre-atomic-
    // insert rows) that has sat in-flight for 2+ hours — with no date, the
    // started/future split cannot be made, so age stands in for it. Neither
    // requires mindbody_appointment_id: a row without one is exactly the row
    // most in need of flagging (round-5 verify finding).
    const result = await pool.query(
      `SELECT * FROM booking_events
       WHERE status = 'payment_sent'
         AND created_at > NOW() - INTERVAL '24 hours'
         AND (
           (appointment_date IS NOT NULL AND appointment_date <= NOW())
           OR (appointment_date IS NULL AND created_at < NOW() - INTERVAL '2 hours')
         )
       ORDER BY created_at ASC
       LIMIT 50`
    );
    return result.rows || [];
  } catch (err) {
    logger.error('DB getAttendedUnresolvedBookings error:', err.message);
    return [];
  }
}

/**
 * In-flight rows that fell off the 24h edge of every safety-net query.
 * All sweeps share a 24h floor; a row that is STILL unresolved as it crosses
 * it would go permanently silent. Flag it on the way out — the 24-48h band
 * tolerates up to a day of cron downtime, and the needs_review status flip
 * means each row is flagged exactly once.
 */
async function getAgingUnresolvedBookings() {
  try {
    const result = await pool.query(
      `SELECT * FROM booking_events
       WHERE status IN ('pending', 'payment_sent')
         AND created_at <= NOW() - INTERVAL '24 hours'
         AND created_at > NOW() - INTERVAL '48 hours'
       ORDER BY created_at ASC
       LIMIT 50`
    );
    return result.rows || [];
  } catch (err) {
    logger.error('DB getAgingUnresolvedBookings error:', err.message);
    return [];
  }
}

/**
 * Tombstone for the ghost-row case: an INSERT that COMMITTED on the server
 * while the client read a failure. The caller has just rolled the Mindbody
 * booking back, so any row still claiming that appointment must not survive as
 * 'pending' — a retry's idempotency lookup would reuse it and bill a customer
 * for the appointment the rollback cancelled (final-gate finding). Returns the
 * number of rows tombstoned, or null when the write itself could not run (the
 * caller must then flag for manual review — the ghost may still be live).
 */
async function tombstoneByAppointment(mindbodyAppointmentId) {
  if (!mindbodyAppointmentId) return 0;
  try {
    const result = await pool.query(
      `UPDATE booking_events
       SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = 'insert_unconfirmed'
       WHERE mindbody_appointment_id = $1 AND status IN ('pending', 'pay_on_location')
       RETURNING id`,
      [parseInt(mindbodyAppointmentId, 10)]
    );
    return result.rowCount;
  } catch (err) {
    logger.error('DB tombstoneByAppointment error:', err.message);
    return null;
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

/**
 * Was the team already notified about this customer very recently?
 * Used to stop duplicate escalation/forward emails flooding welcome@ when a
 * customer keeps messaging about the same issue (one morning produced ~12
 * identical "Customer needs help" emails for a single person).
 *
 * `reason` is the notification TYPE ('human_handoff', 'gift_card_request', …).
 * Pass `message` to only match content-identical repeats (used for the forward
 * tools, so a genuinely updated request still reaches the team).
 *
 * On any DB error this returns false — never suppress on uncertainty; a
 * duplicate email is far better than a lost escalation.
 */
async function hasRecentTeamNotification(phone, reason, minutes, message = null) {
  try {
    const params = [phone, reason, String(minutes)];
    let sql = `SELECT 1 FROM escalations
               WHERE phone = $1 AND reason = $2
                 AND created_at > NOW() - ($3 || ' minutes')::interval`;
    if (message !== null) {
      params.push(message);
      sql += ` AND message = $4`;
    }
    const r = await pool.query(sql + ' LIMIT 1', params);
    return (r.rowCount || 0) > 0;
  } catch (err) {
    logger.error('DB hasRecentTeamNotification error:', err.message);
    return false;
  }
}

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

async function getMessagesByPhone(phone, limit = 500) {
  try {
    // Return the MOST RECENT `limit` messages, in chronological order.
    // Previously this ordered created_at ASC with a LIMIT, which returns the
    // OLDEST N messages — so in a long conversation the dashboard showed only
    // old messages and cut off every NEW one, and a team reply that was just
    // sent (the newest row) fell outside the window and looked like it
    // "disappeared". The agent's "restore last 10 messages" context load hit the
    // same bug, restoring the oldest 10 after a restart. Take the newest N, then
    // re-sort ascending for display.
    const result = await pool.query(
      `SELECT role, content, created_at FROM (
         SELECT role, content, created_at FROM conversation_messages
         WHERE phone = $1 ORDER BY created_at DESC LIMIT $2
       ) sub ORDER BY created_at ASC`,
      [phone, limit]
    );
    return result.rows;
  } catch (err) {
    logger.error('DB getMessagesByPhone error:', err.message);
    return [];
  }
}

// Timestamp of the customer's most recent INBOUND ('user') message. Used to
// check WhatsApp's 24-hour customer-service window: outside it, free-form team
// replies are silently dropped by WhatsApp (the team thinks it sent, the
// customer never gets it). Returns null if the customer has never messaged.
async function getLastInboundMessageAt(phone) {
  try {
    const r = await pool.query(
      `SELECT created_at FROM conversation_messages WHERE phone = $1 AND role = 'user' ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );
    return r.rows[0]?.created_at || null;
  } catch (err) {
    logger.error('DB getLastInboundMessageAt error:', err.message);
    return null;
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

// --- Blocked numbers (fraud): the bot ignores these entirely ---
async function blockNumber(phone, reason) {
  try {
    await pool.query(
      `INSERT INTO blocked_numbers (phone, reason) VALUES ($1, $2)
       ON CONFLICT (phone) DO UPDATE SET reason = EXCLUDED.reason, blocked_at = NOW()`,
      [phone, reason || null]
    );
    return true;
  } catch (err) {
    logger.error('DB blockNumber error:', err.message);
    return false;
  }
}

async function unblockNumber(phone) {
  try {
    await pool.query(`DELETE FROM blocked_numbers WHERE phone = $1`, [phone]);
    return true;
  } catch (err) {
    logger.error('DB unblockNumber error:', err.message);
    return false;
  }
}

// Fails OPEN (returns false on error): a DB hiccup must never silently drop a
// real customer's messages — better to answer a blocked number once than to
// black-hole everyone.
async function isBlocked(phone) {
  try {
    const result = await pool.query(`SELECT 1 FROM blocked_numbers WHERE phone = $1`, [phone]);
    return result.rows.length > 0;
  } catch (err) {
    logger.error('DB isBlocked error:', err.message);
    return false;
  }
}

async function getBlockedNumbers() {
  try {
    const result = await pool.query(`SELECT phone, reason, blocked_at FROM blocked_numbers ORDER BY blocked_at DESC`);
    return result.rows;
  } catch (err) {
    logger.error('DB getBlockedNumbers error:', err.message);
    return [];
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
  getLastInboundMessageAt,
  // Media (customer photos)
  saveMedia,
  getMedia,
  // Per-customer bot pause
  pauseConversation,
  blockNumber,
  unblockNumber,
  isBlocked,
  getBlockedNumbers,
  resumeConversation,
  isPaused,
  getPausedConversations,
  // Bookings
  logBookingEvent,
  getRecentBooking,
  getBookingEventById,
  getBookingEventByAppointment,
  updateBookingEventIfStatus,
  getUnpaidStartedBookings,
  getAttendedUnresolvedBookings,
  getAgingUnresolvedBookings,
  tombstoneByAppointment,
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
  hasRecentTeamNotification,
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
