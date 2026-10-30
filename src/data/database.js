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

      CREATE TABLE IF NOT EXISTS intro_promo_sent (
        phone VARCHAR(64) PRIMARY KEY,
        sent_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Campaign intro messages (intro-promo.service): once per guest per
      -- campaign. intro_promo_sent above is the September 2026 campaign's.
      CREATE TABLE IF NOT EXISTS promo_messages_sent (
        campaign VARCHAR(64) NOT NULL,
        phone VARCHAR(64) NOT NULL,
        sent_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (campaign, phone)
      );

      -- The team's view of a guest, independent of the 30-minute conversation
      -- rows: does this guest need a reply from us, and who is on it.
      CREATE TABLE IF NOT EXISTS conversation_status (
        phone VARCHAR(64) PRIMARY KEY,
        needs_reply BOOLEAN NOT NULL DEFAULT FALSE,
        needs_reply_since TIMESTAMPTZ,
        needs_reply_reason TEXT,
        working_on_by VARCHAR(100),
        working_on_since TIMESTAMPTZ,
        reopen_sent_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Payment links the team sends from the dashboard, so their status
      -- (waiting / paid / expired) can be shown next to the chat.
      CREATE TABLE IF NOT EXISTS manual_payment_links (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(64) NOT NULL,
        stripe_session_id VARCHAR(255) UNIQUE NOT NULL,
        amount_cents INTEGER NOT NULL,
        description TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        paid_at TIMESTAMPTZ,
        expired_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_manual_payment_links_phone ON manual_payment_links(phone, created_at);

      -- Team replies written after WhatsApp's 24h window closed: held here and
      -- delivered the moment the guest answers the re-open template.
      CREATE TABLE IF NOT EXISTS queued_team_messages (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(64) NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        delivered_at TIMESTAMPTZ,
        attempts INTEGER NOT NULL DEFAULT 0,
        cancelled_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_queued_team_messages_phone ON queued_team_messages(phone) WHERE delivered_at IS NULL;

      CREATE TABLE IF NOT EXISTS conversation_state (
        phone VARCHAR(64) PRIMARY KEY,
        state JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Team-edited business facts (settings.service.js). Append-only: every
      -- save is a row; the latest row whose effective_from has passed is in
      -- force, a future one is a scheduled change.
      CREATE TABLE IF NOT EXISTS bot_settings_history (
        id SERIAL PRIMARY KEY,
        section VARCHAR(40) NOT NULL,
        value JSONB NOT NULL,
        effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        saved_by VARCHAR(60) NOT NULL,
        note VARCHAR(200),
        restored_from INTEGER,
        cancelled_at TIMESTAMPTZ,
        cancelled_by VARCHAR(60)
      );
      CREATE INDEX IF NOT EXISTS idx_bot_settings_section ON bot_settings_history(section, effective_from DESC, id DESC);

      -- Promotion posters uploaded on the dashboard. In the database because the
      -- container's files are wiped on every deploy; served on an unguessable
      -- public URL because WhatsApp fetches media without our token.
      CREATE TABLE IF NOT EXISTS campaign_images (
        id UUID PRIMARY KEY,
        mime VARCHAR(20) NOT NULL,
        bytes BYTEA NOT NULL,
        uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        uploaded_by VARCHAR(60) NOT NULL
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
    // Carry escalations of the last 7 days into conversation_status once, so
    // open follow-ups don't vanish when this table goes live. Older row-level
    // flags were never cleared and are not real open work.
    await client.query(`
      INSERT INTO conversation_status (phone, needs_reply, needs_reply_since, needs_reply_reason)
      SELECT DISTINCT ON (phone) phone, TRUE, last_message_at, 'Escalated'
      FROM conversations
      WHERE escalated = TRUE AND last_message_at > NOW() - INTERVAL '7 days'
      ORDER BY phone, last_message_at DESC
      ON CONFLICT (phone) DO NOTHING
    `);
    // Columns added after the tables first shipped.
    await client.query(`
      ALTER TABLE queued_team_messages ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
      ALTER TABLE conversation_status ADD COLUMN IF NOT EXISTS reopen_sent_at TIMESTAMPTZ;
      ALTER TABLE booking_events ADD COLUMN IF NOT EXISTS pay_first JSONB;
      ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS campaign_id VARCHAR(64);
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

async function markConversationEscalated(phone, reason = null) {
  await setNeedsReply(phone, reason || 'Escalated');
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

// --- Team status per guest (Needs reply / Working on / Done) ---

/**
 * The guest needs a reply from the team. Keeps the original "since" while the
 * flag is already up, so the inbox shows how long they have been waiting.
 * Best-effort: a status write must never break message handling.
 */
async function setNeedsReply(phone, reason = null) {
  try {
    await pool.query(
      `INSERT INTO conversation_status (phone, needs_reply, needs_reply_since, needs_reply_reason, updated_at)
       VALUES ($1, TRUE, NOW(), $2, NOW())
       ON CONFLICT (phone) DO UPDATE SET
         needs_reply = TRUE,
         needs_reply_since = CASE WHEN conversation_status.needs_reply THEN conversation_status.needs_reply_since ELSE NOW() END,
         needs_reply_reason = COALESCE($2, conversation_status.needs_reply_reason),
         updated_at = NOW()`,
      [phone, reason]
    );
  } catch (err) {
    logger.error('DB setNeedsReply error:', err.message);
  }
}

/** The team answered: the ball is in the guest's court again. */
async function clearNeedsReply(phone) {
  try {
    await pool.query(
      `UPDATE conversation_status SET needs_reply = FALSE, updated_at = NOW() WHERE phone = $1`,
      [phone]
    );
  } catch (err) {
    logger.error('DB clearNeedsReply error:', err.message);
  }
}

/** "I'm on it" (name) — or release the chat (null). */
async function setWorkingOn(phone, name) {
  // Separate params for the name and its timestamp: reusing one parameter
  // both as a varchar value and as ::text makes Postgres reject the query
  // ("inconsistent types deduced for parameter").
  const by = name || null;
  await pool.query(
    `INSERT INTO conversation_status (phone, working_on_by, working_on_since, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (phone) DO UPDATE SET
       working_on_by = EXCLUDED.working_on_by,
       working_on_since = EXCLUDED.working_on_since,
       updated_at = NOW()`,
    [phone, by, by ? new Date() : null]
  );
}

/**
 * Done: nothing left to do for this guest. Clears the status, resolves their
 * open escalation entries and the legacy row-level flags.
 */
async function markHandled(phone) {
  await pool.query(
    `INSERT INTO conversation_status (phone, needs_reply, updated_at) VALUES ($1, FALSE, NOW())
     ON CONFLICT (phone) DO UPDATE SET needs_reply = FALSE, needs_reply_reason = NULL,
       working_on_by = NULL, working_on_since = NULL, updated_at = NOW()`,
    [phone]
  );
  await pool.query(`UPDATE escalations SET resolved = TRUE, resolved_at = NOW() WHERE phone = $1 AND resolved = FALSE`, [phone]);
  await pool.query(`UPDATE conversations SET escalated = FALSE WHERE phone = $1 AND escalated = TRUE`, [phone]);
  // Done means nothing left to send either: a reply still parked for the
  // re-open would otherwise go out whenever the guest next writes, maybe weeks later.
  await cancelQueuedTeamMessages(phone);
}

async function getConversationStatus(phone) {
  try {
    const res = await pool.query(`SELECT * FROM conversation_status WHERE phone = $1`, [phone]);
    return res.rows[0] || null;
  } catch (err) {
    logger.error('DB getConversationStatus error:', err.message);
    return null;
  }
}

// --- Team-sent payment links ---

async function recordManualPaymentLink({ phone, sessionId, amountCents, description }) {
  try {
    await pool.query(
      `INSERT INTO manual_payment_links (phone, stripe_session_id, amount_cents, description)
       VALUES ($1, $2, $3, $4) ON CONFLICT (stripe_session_id) DO NOTHING`,
      [phone, sessionId, amountCents, description]
    );
  } catch (err) {
    logger.error('DB recordManualPaymentLink error:', err.message);
  }
}

/**
 * Move a team link out of 'pending' (to 'paid' or 'expired'). Returns the row
 * only on the actual transition, so a redelivered Stripe webhook does nothing
 * twice. A paid link never turns back into expired.
 */
async function settleManualPaymentLink(sessionId, status) {
  if (!['paid', 'expired'].includes(status)) throw new Error(`bad status ${status}`);
  try {
    const res = await pool.query(
      `UPDATE manual_payment_links
          SET status = $2,
              paid_at = CASE WHEN $3 THEN NOW() ELSE paid_at END,
              expired_at = CASE WHEN $3 THEN expired_at ELSE NOW() END
        WHERE stripe_session_id = $1 AND status = 'pending'
        RETURNING phone, amount_cents, description, status`,
      [sessionId, status, status === 'paid']
    );
    return res.rows[0] || null;
  } catch (err) {
    logger.error('DB settleManualPaymentLink error:', err.message);
    return null;
  }
}

async function getManualPaymentLinks(phone, limit = 10) {
  try {
    const res = await pool.query(
      `SELECT id, amount_cents, description, status, created_at, paid_at, expired_at
         FROM manual_payment_links WHERE phone = $1 ORDER BY created_at DESC LIMIT $2`,
      [phone, limit]
    );
    return res.rows;
  } catch (err) {
    logger.error('DB getManualPaymentLinks error:', err.message);
    return [];
  }
}

// --- Team replies queued until the guest re-opens the 24h window ---

async function queueTeamMessage(phone, content) {
  await pool.query(`INSERT INTO queued_team_messages (phone, content) VALUES ($1, $2)`, [phone, content]);
}

// A parked reply older than this is stale — it is no longer sent.
const QUEUED_REPLY_MAX_AGE = '7 days';

/**
 * Claim this guest's deliverable queued messages (oldest first). Claiming sets
 * delivered_at in the same statement, so two inbound messages arriving at once
 * can't both send them. Cancelled and stale (7 days) replies are never claimed
 * — the dashboard shows stale ones as not sent.
 *
 * There is deliberately no "give up after N failures": a reply that keeps
 * failing must keep holding back the ones after it (they'd arrive out of
 * order otherwise). Each failure flags the chat, and the team either retries
 * (Send now) or cancels it.
 */
async function claimQueuedTeamMessages(phone) {
  const res = await pool.query(
    `UPDATE queued_team_messages SET delivered_at = NOW(), attempts = attempts + 1
      WHERE phone = $1 AND delivered_at IS NULL AND cancelled_at IS NULL
        AND created_at > NOW() - INTERVAL '${QUEUED_REPLY_MAX_AGE}'
      RETURNING id, content, created_at`,
    [phone]
  );
  return res.rows.sort((a, b) => a.id - b.id);
}

// "Needs reply" reason when a parked team reply could not be sent.
const QUEUE_FAIL_REASON = 'A waiting team reply could not be sent';

/**
 * A parked reply failed: flag the chat. An existing reason is kept (a guest
 * message or escalation the team still has to see must not be overwritten).
 */
async function flagQueueFailure(phone) {
  try {
    await pool.query(
      `INSERT INTO conversation_status (phone, needs_reply, needs_reply_since, needs_reply_reason, updated_at)
       VALUES ($1, TRUE, NOW(), $2, NOW())
       ON CONFLICT (phone) DO UPDATE SET
         needs_reply_reason = CASE WHEN conversation_status.needs_reply THEN conversation_status.needs_reply_reason ELSE $2 END,
         needs_reply_since = CASE WHEN conversation_status.needs_reply THEN conversation_status.needs_reply_since ELSE NOW() END,
         needs_reply = TRUE,
         updated_at = NOW()`,
      [phone, QUEUE_FAIL_REASON]
    );
  } catch (err) {
    logger.error('DB flagQueueFailure error:', err.message);
  }
}

/**
 * The failed reply went out after all (or was cancelled): drop the flag — but
 * only if the failure was the sole reason for it and nothing that was tried
 * and failed is still waiting.
 */
async function clearQueueFailure(phone) {
  try {
    // Callers hold the guest's send lock, so nothing fails in between.
    const stillFailing = await pool.query(
      `SELECT id FROM queued_team_messages
        WHERE phone = $1 AND delivered_at IS NULL AND cancelled_at IS NULL AND attempts > 0 LIMIT 1`,
      [phone]
    );
    if (stillFailing.rows.length) return;
    await pool.query(
      `UPDATE conversation_status SET needs_reply = FALSE, needs_reply_reason = NULL, updated_at = NOW()
        WHERE phone = $1 AND needs_reply = TRUE AND needs_reply_reason = $2`,
      [phone, QUEUE_FAIL_REASON]
    );
  } catch (err) {
    logger.error('DB clearQueueFailure error:', err.message);
  }
}

/** Cancel one parked reply (dashboard) — or all of a guest's (Done). */
async function cancelQueuedTeamMessages(phone, id = null) {
  const res = await pool.query(
    `UPDATE queued_team_messages SET cancelled_at = NOW()
      WHERE phone = $1 AND delivered_at IS NULL AND cancelled_at IS NULL
        AND ($2::int IS NULL OR id = $2::int)
      RETURNING id`,
    [phone, id]
  );
  return res.rows.length;
}

/** The re-open invitation went out now (one per closed window — they cost money). */
async function markReopenSent(phone) {
  await pool.query(
    `INSERT INTO conversation_status (phone, reopen_sent_at, updated_at) VALUES ($1, NOW(), NOW())
     ON CONFLICT (phone) DO UPDATE SET reopen_sent_at = NOW(), updated_at = NOW()`,
    [phone]
  );
}

/**
 * Put claimed messages back. `tried` is the one whose send failed and keeps
 * its attempt; the others were never tried, so claiming them must not count.
 */
async function releaseQueuedTeamMessage(id, tried = true) {
  await pool.query(
    `UPDATE queued_team_messages SET delivered_at = NULL, attempts = attempts - $2 WHERE id = $1`,
    [id, tried ? 0 : 1]
  );
}

async function getPendingQueuedTeamMessages(phone) {
  try {
    // `stuck`: will not go out any more (the guest didn't answer within 7 days).
    const res = await pool.query(
      `SELECT id, content, created_at, attempts,
              (created_at <= NOW() - INTERVAL '${QUEUED_REPLY_MAX_AGE}') AS stuck
         FROM queued_team_messages
        WHERE phone = $1 AND delivered_at IS NULL AND cancelled_at IS NULL ORDER BY id`,
      [phone]
    );
    return res.rows;
  } catch (err) {
    logger.error('DB getPendingQueuedTeamMessages error:', err.message);
    return [];
  }
}

// --- Guest language ---

/**
 * The bot detects the guest's language per reply, but it was never written to
 * conversations.language (logConversation always got null), so the dashboard's
 * language badge and Dutch/English stats stayed empty. Best-effort.
 */
async function setConversationLanguage(phone, language) {
  if (!['en', 'nl'].includes(language)) return;
  try {
    await pool.query(
      `UPDATE conversations SET language = $2
        WHERE id = (SELECT id FROM conversations WHERE phone = $1 ORDER BY started_at DESC LIMIT 1)
          AND (language IS NULL OR language <> $2)`,
      [phone, language]
    );
  } catch (err) {
    logger.error('DB setConversationLanguage error:', err.message);
  }
}

/** Best guess of the guest's language: the bot's saved state, else the latest row. */
async function getGuestLanguage(phone) {
  try {
    const st = await pool.query(`SELECT state->>'lang' AS lang FROM conversation_state WHERE phone = $1`, [phone]);
    if (st.rows[0]?.lang) return st.rows[0].lang;
    const row = await pool.query(
      `SELECT language FROM conversations WHERE phone = $1 AND language IS NOT NULL ORDER BY started_at DESC LIMIT 1`,
      [phone]
    );
    return row.rows[0]?.language || null;
  } catch (err) {
    logger.error('DB getGuestLanguage error:', err.message);
    return null;
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
async function getRecentBooking(phone, sessionTypeId, startDateTime, matches = null) {
  if (!phone || !sessionTypeId || !startDateTime) return null;
  try {
    const r = await pool.query(
      `SELECT * FROM booking_events
       WHERE phone = $1 AND session_type_id = $2 AND appointment_date = $3
         AND mindbody_appointment_id IS NOT NULL
         AND status NOT IN ('expired', 'cancelled')
         AND created_at > NOW() - INTERVAL '15 minutes'
       ORDER BY created_at DESC
       LIMIT 20`,
      [phone, sessionTypeId, startDateTime]
    );
    // Several guests in one chat can share treatment + time: the caller says
    // which row is "this person's" (newest first).
    return (matches ? r.rows.find(matches) : r.rows[0]) || null;
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
  // Same rule as updateBookingByStripeSession: a pay-first row only becomes
  // 'paid' together with its Mindbody appointment.
  const paidGuard = updates.status === 'paid' && !updates.mindbodyAppointmentId
    ? ` AND (pay_first IS NULL OR mindbody_appointment_id IS NOT NULL)` : '';
  try {
    await pool.query(`UPDATE booking_events SET ${fields.join(', ')} WHERE id = $${idx}${paidGuard}`, values);
  } catch (err) {
    logger.error('DB updateBookingEvent error:', err.message);
  }
}

// ── Pay-first bookings (massages, facial, NSR, Let It Go) ────────────────────
// The row exists BEFORE any Mindbody appointment: status 'awaiting_payment'
// with the booking details in pay_first (JSONB). The Stripe webhook claims it
// ('booking'), books in Mindbody and settles it as 'paid' (with the
// appointment id) or 'paid_unbooked' (the team rebooks or refunds).

/** New awaiting-payment row. Returns its id, or null when it could not be written. */
async function insertPayFirstRow({ phone, customerName, sessionTypeId, serviceName, staffName, amountCents, appointmentDate, payFirst }) {
  try {
    const r = await pool.query(
      `INSERT INTO booking_events (phone, customer_name, session_type_id, service_name, staff_name, status, amount_cents, appointment_date, pay_first)
       VALUES ($1, $2, $3, $4, $5, 'awaiting_payment', $6, $7, $8::jsonb) RETURNING id`,
      [phone, customerName || null, sessionTypeId, serviceName || null, staffName || null, amountCents, appointmentDate || null, JSON.stringify(payFirst || {})]
    );
    return r.rows[0]?.id || null;
  } catch (err) {
    logger.error('DB insertPayFirstRow error:', err.message);
    return null;
  }
}

/** Merge fields into a row's pay_first JSON. true / null (DB error). */
async function mergePayFirst(id, patch) {
  try {
    await pool.query(`UPDATE booking_events SET pay_first = COALESCE(pay_first, '{}'::jsonb) || $2::jsonb WHERE id = $1`, [id, JSON.stringify(patch || {})]);
    return true;
  } catch (err) {
    logger.error('DB mergePayFirst error:', err.message);
    return null;
  }
}

/**
 * This guest's pay-first rows that still matter (open, in progress, paid, or
 * paid but not booked), newest first. null on a DB error — callers that are
 * about to take money must treat that as "unknown" and stop.
 */
async function getPayFirstRowsForPhone(phone) {
  try {
    const r = await pool.query(
      `SELECT * FROM booking_events
        WHERE phone = $1 AND pay_first IS NOT NULL
          AND status IN ('awaiting_payment', 'booking', 'paid', 'paid_unbooked')
          AND created_at > NOW() - INTERVAL '30 days'
        ORDER BY created_at DESC LIMIT 20`,
      [phone]
    );
    return r.rows;
  } catch (err) {
    logger.error('DB getPayFirstRowsForPhone error:', err.message);
    return null;
  }
}

/**
 * Other guests' open pay-first checkouts — a soft hold on their therapist and
 * room while they pay (nothing is held in Mindbody yet). Advisory: [] on error.
 */
async function getActivePayFirstHolds(excludePhone) {
  try {
    const r = await pool.query(
      `SELECT id, phone, session_type_id, status, pay_first FROM booking_events
        WHERE pay_first IS NOT NULL AND status IN ('awaiting_payment', 'booking')
          AND created_at > NOW() - INTERVAL '40 minutes'
          AND phone <> $1`,
      [excludePhone || '']
    );
    return r.rows;
  } catch (err) {
    logger.error('DB getActivePayFirstHolds error:', err.message);
    return [];
  }
}

async function getPayFirstRowBySession(sessionId) {
  if (!sessionId) return null;
  try {
    const r = await pool.query(`SELECT * FROM booking_events WHERE stripe_session_id = $1 ORDER BY id DESC LIMIT 1`, [sessionId]);
    return r.rows[0] || null;
  } catch (err) {
    logger.error('DB getPayFirstRowBySession error:', err.message);
    throw err;
  }
}

/**
 * Claim a paid pay-first row for booking (one winner per payment, however
 * often Stripe delivers the event). The money facts are written in the same
 * statement, so a row in 'booking' can always be refunded from the DB.
 * true = claimed, false = not claimable (re-read to see why), null = DB error.
 */
async function claimPayFirst(id, sessionId, { paymentIntent, amountCents, paymentMethod }) {
  try {
    const r = await pool.query(
      `UPDATE booking_events
          SET status = 'booking', paid_at = COALESCE(paid_at, NOW()),
              stripe_payment_intent = COALESCE($3, stripe_payment_intent),
              amount_cents = COALESCE($4, amount_cents),
              payment_method = COALESCE($5, payment_method)
        WHERE id = $1 AND stripe_session_id = $2 AND pay_first IS NOT NULL
          AND status IN ('awaiting_payment', 'expired')
        RETURNING id`,
      [id, sessionId, paymentIntent || null, amountCents ?? null, paymentMethod || null]
    );
    return r.rowCount > 0;
  } catch (err) {
    logger.error('DB claimPayFirst error:', err.message);
    return null;
  }
}

/** Rows the expiry cron must look after: open links, stuck bookings, unresolved money. */
async function getPayFirstRowsForSweep() {
  try {
    const r = await pool.query(
      `SELECT * FROM booking_events
        WHERE pay_first IS NOT NULL AND status IN ('awaiting_payment', 'booking', 'paid_unbooked')
          AND created_at > NOW() - INTERVAL '14 days'
        ORDER BY created_at ASC LIMIT 100`
    );
    return r.rows;
  } catch (err) {
    logger.error('DB getPayFirstRowsForSweep error:', err.message);
    return [];
  }
}

async function getBookingEventByPaymentIntent(paymentIntent) {
  if (!paymentIntent) return null;
  try {
    const r = await pool.query(`SELECT * FROM booking_events WHERE stripe_payment_intent = $1 ORDER BY id DESC LIMIT 1`, [paymentIntent]);
    return r.rows[0] || null;
  } catch (err) {
    logger.error('DB getBookingEventByPaymentIntent error:', err.message);
    throw err;
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
  // the only transition allowed to overwrite — except on a pay-first row that
  // has no appointment yet: 'paid' there would claim a booking that doesn't
  // exist (only the pay-first finalize may mark those).
  const paidGuard = updates.status && updates.status !== 'paid'
    ? ` AND status <> 'paid'`
    : (updates.status === 'paid' ? ` AND (pay_first IS NULL OR mindbody_appointment_id IS NOT NULL)` : '');
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
async function tombstoneByAppointment(mindbodyAppointmentId, phone) {
  if (!mindbodyAppointmentId) return 0;
  try {
    // The phone filter matters for CLASSES: class rows share the class id
    // across customers, and a tombstone must never touch another customer's
    // in-flight enrolment row.
    const result = await pool.query(
      `UPDATE booking_events
       SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = 'insert_unconfirmed'
       WHERE mindbody_appointment_id = $1 AND status IN ('pending', 'pay_on_location')
         AND ($2::text IS NULL OR phone = $2)
       RETURNING id`,
      [parseInt(mindbodyAppointmentId, 10), phone || null]
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

// Returns true only when the flag row is CONFIRMED written. Review flags are
// the terminal state the whole safety net funnels into; a caller that changes
// state based on "the team has been flagged" must check this return — a flip
// to needs_review after a LOST flag write removes the booking from every sweep
// with nobody told (round-9 devil's-advocate finding).
async function logError(type, message, stack, context) {
  try {
    await pool.query(
      `INSERT INTO errors (type, message, stack, context) VALUES ($1, $2, $3, $4)`,
      [type, message, stack, typeof context === 'string' ? context : JSON.stringify(context)]
    );
    return true;
  } catch (err) {
    // Don't recurse — just console.error
    console.error('DB logError failed:', err.message);
    return false;
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

async function getLastReminderAt(phone) {
  try {
    const res = await pool.query(`SELECT MAX(sent_at) AS last_at FROM reminders WHERE phone = $1`, [phone]);
    return res.rows[0]?.last_at || null;
  } catch (err) {
    logger.error('DB getLastReminderAt error:', err.message);
    return null;
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

/**
 * Timestamp of the most recent message in a conversation, ANY role — used to
 * detect whether an inbound message starts a fresh conversation (gap) or
 * lands mid-flow. Returns null for a brand-new phone or on error.
 */
async function getLastMessageAt(phone) {
  try {
    const res = await pool.query(
      `SELECT MAX(created_at) AS last_at FROM conversation_messages WHERE phone = $1`,
      [phone]
    );
    return res.rows[0]?.last_at || null;
  } catch (err) {
    logger.error('DB getLastMessageAt error:', err.message);
    return null;
  }
}

/**
 * This customer's OPEN bot bookings for one visit day: how many, and their
 * combined price. "Open" = booked but not yet settled online (pending,
 * payment_sent, pay_on_location) — paid, cancelled and expired rows are not
 * part of an order still being placed. The team-routing gate uses this next to
 * the in-memory cart, because the cart only lives 30 minutes while customers
 * add treatments hours or days later. Fails OPEN (zeros): on a DB error the
 * gate falls back to the cart alone.
 */
async function getOpenJourneyForDay(phone, dayIso) {
  try {
    const res = await pool.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount_cents), 0)::int AS total_cents
       FROM booking_events
       WHERE phone = $1
         AND status IN ('pending', 'payment_sent', 'pay_on_location', 'awaiting_payment', 'booking')
         AND (appointment_date AT TIME ZONE 'Europe/Amsterdam')::date = $2::date`,
      [phone, String(dayIso).slice(0, 10)]
    );
    const row = res.rows[0] || {};
    return { count: row.count || 0, totalCents: row.total_cents || 0 };
  } catch (err) {
    logger.error('DB getOpenJourneyForDay error:', err.message);
    return { count: 0, totalCents: 0 };
  }
}

/**
 * WhatsApp conversations whose LAST message is a customer message sent inside
 * [sinceIso, untilIso] — i.e. nobody (bot or team) has answered it. Rows whose
 * content is in `ignoreContents` are not counted as answers (the outage
 * holding message is logged as an assistant row but is not a reply). Used to
 * replay messages the assistant missed while it was down. Fails open ([]).
 */
async function getUnansweredConversations(sinceIso, untilIso, ignoreContents = []) {
  try {
    const res = await pool.query(
      `WITH last_msg AS (
         SELECT DISTINCT ON (phone) phone, role, content, created_at
         FROM conversation_messages
         WHERE phone NOT LIKE 'web\\_%'
           AND NOT (role <> 'user' AND content = ANY($3::text[]))
           -- a photo/sticker placeholder is not a question to replay: look
           -- past it to what the guest actually wrote (or the last answer)
           AND NOT (role = 'user' AND (content LIKE '[image:#%]' OR content LIKE '[% message]'))
         ORDER BY phone, created_at DESC
       )
       SELECT l.phone, l.content, l.created_at AS last_user_at,
              -- the guest's latest message of any kind (a photo also re-opens
              -- WhatsApp's 24h window, even though it isn't the question)
              (SELECT MAX(m2.created_at) FROM conversation_messages m2
                WHERE m2.phone = l.phone AND m2.role = 'user') AS last_inbound_at,
              (SELECT c.customer_name FROM conversations c
                WHERE c.phone = l.phone ORDER BY c.started_at DESC LIMIT 1) AS customer_name
       FROM last_msg l
       WHERE l.role = 'user' AND l.created_at >= $1 AND l.created_at <= $2
       ORDER BY l.created_at ASC`,
      [sinceIso, untilIso, ignoreContents]
    );
    return res.rows;
  } catch (err) {
    logger.error('DB getUnansweredConversations error:', err.message);
    return [];
  }
}

/**
 * Guard state that must outlive the 30-minute in-memory conversation TTL and
 * server restarts: the slots this customer was genuinely offered (the
 * offered-slot gate checks bookings against them) and their language.
 * Deliberately NOT the cart or the confirmation gates — money state has its
 * own durable home in booking_events, and a confirmation must stay fresh.
 * Both helpers are best-effort: losing this only costs a re-check round.
 */
async function saveConversationState(phone, state) {
  try {
    await pool.query(
      `INSERT INTO conversation_state (phone, state, updated_at) VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (phone) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`,
      [phone, JSON.stringify(state || {})]
    );
  } catch (err) {
    logger.warn('DB saveConversationState error:', err.message);
  }
}

/** Returns the saved state if it is younger than 14 days, else null. */
async function loadConversationState(phone) {
  const res = await pool.query(
    `SELECT state FROM conversation_state WHERE phone = $1 AND updated_at > NOW() - INTERVAL '14 days'`,
    [phone]
  );
  return res.rows[0]?.state || null;
}

/**
 * Has this customer's current conversation been handed to a human (handoff
 * requested) or is the bot paused for them? Used to stop automated payment
 * pressure / releases while the team is handling the customer. Fails OPEN
 * (false): on a DB error the automation behaves as it always did.
 */
async function isHumanHandling(phone) {
  // Staff signals only: the bot is paused, or a team member clicked "I'm on it"
  // in the last 24h. A guest can raise "needs reply" themselves (asking for a
  // person, a gift-card question) — counting that would let anyone dodge the
  // release of an unpaid booking.
  try {
    const res = await pool.query(
      `SELECT
         EXISTS (SELECT 1 FROM paused_conversations WHERE phone = $1) AS paused,
         EXISTS (SELECT 1 FROM conversation_status
                 WHERE phone = $1 AND working_on_by IS NOT NULL
                   AND working_on_since > NOW() - INTERVAL '24 hours') AS team`,
      [phone]
    );
    const row = res.rows[0] || {};
    return !!(row.paused || row.team);
  } catch (err) {
    logger.error('DB isHumanHandling error:', err.message);
    return false;
  }
}

// --- Team-edited settings (settings.service.js) ---
// These throw instead of returning a fallback: a save the team believes went
// through must never be silently lost.

/**
 * Per section the last few rows in force (newest first wins; older ones are
 * the fallback if a hand-edited row is malformed), plus every scheduled row
 * not cancelled.
 */
async function getSettingsRows() {
  const res = await pool.query(`
    SELECT * FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY section ORDER BY effective_from DESC, id DESC) AS rn
      FROM bot_settings_history WHERE cancelled_at IS NULL AND effective_from <= NOW()
    ) cur WHERE rn <= 5
    UNION ALL
    SELECT *, 0 AS rn FROM bot_settings_history WHERE cancelled_at IS NULL AND effective_from > NOW()
  `);
  return res.rows;
}

async function insertSettingsRow({ section, value, effectiveFrom, savedBy, note, restoredFrom }) {
  const res = await pool.query(
    `INSERT INTO bot_settings_history (section, value, effective_from, saved_by, note, restored_from)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [section, JSON.stringify(value), effectiveFrom, savedBy, note, restoredFrom]
  );
  return res.rows[0];
}

async function getSettingsHistory(section, limit) {
  const res = await pool.query(
    `SELECT * FROM bot_settings_history WHERE section = $1 ORDER BY id DESC LIMIT $2`,
    [section, limit]
  );
  return res.rows;
}

async function getSettingsRowById(id) {
  const res = await pool.query(`SELECT * FROM bot_settings_history WHERE id = $1`, [Number(id)]);
  return res.rows[0] || null;
}

/** Cancel a scheduled change — only while it hasn't started. */
async function cancelSettingsRow(id, by) {
  const res = await pool.query(
    `UPDATE bot_settings_history SET cancelled_at = NOW(), cancelled_by = $2
     WHERE id = $1 AND cancelled_at IS NULL AND effective_from > NOW() RETURNING *`,
    [Number(id), by]
  );
  return res.rows[0] || null;
}

// Promotion posters (settings.service.js promotions, intro-promo.service.js).
// Like the settings queries these throw: the caller tells the team.
async function insertCampaignImage({ id, mime, bytes, uploadedBy }) {
  await pool.query(
    `INSERT INTO campaign_images (id, mime, bytes, uploaded_by) VALUES ($1, $2, $3, $4)`,
    [id, mime, bytes, uploadedBy]
  );
}

async function getCampaignImage(id) {
  const res = await pool.query(`SELECT mime, bytes FROM campaign_images WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

async function campaignImageExists(id) {
  const res = await pool.query(`SELECT 1 FROM campaign_images WHERE id = $1`, [id]);
  return res.rows.length > 0;
}

/**
 * Atomically claim the one-time intro promo for a phone. Returns true exactly
 * once per phone (the caller that wins the INSERT sends the promo); false when
 * already claimed. Fails CLOSED on DB errors — better to skip a marketing
 * message than risk spamming it on every message while the DB is flaky.
 */
async function claimPromoMessage(campaign, phone) {
  try {
    const res = await pool.query(
      `INSERT INTO promo_messages_sent (campaign, phone) VALUES ($1, $2) ON CONFLICT (campaign, phone) DO NOTHING RETURNING phone`,
      [campaign, phone]
    );
    return res.rows.length > 0;
  } catch (err) {
    logger.error('DB claimPromoMessage error:', err.message);
    return false;
  }
}

// campaignId marks a promotion intro (intro-promo.service.js), so it is
// recognised as one even after the team edits the text.
async function logMessage(phone, role, content, { campaignId = null } = {}) {
  try {
    await pool.query(
      `INSERT INTO conversation_messages (phone, role, content, campaign_id) VALUES ($1, $2, $3, $4)`,
      [phone, role, content, campaignId]
    );
  } catch (err) {
    logger.error('DB logMessage error:', err.message);
  }
}

async function getMessagesByPhone(phone, limit = 500, opts = {}) {
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
      `SELECT role, content, created_at, campaign_id FROM (
         SELECT role, content, created_at, campaign_id FROM conversation_messages
         WHERE phone = $1 ORDER BY created_at DESC LIMIT $2
       ) sub ORDER BY created_at ASC`,
      [phone, limit]
    );
    return result.rows;
  } catch (err) {
    logger.error('DB getMessagesByPhone error:', err.message);
    // strict: the agent's context restore must tell "no history" apart from
    // "history unavailable" — an empty list here once made it greet a customer
    // from scratch mid-booking. Dashboard callers keep the lenient default.
    if (opts.strict) throw err;
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
  insertPayFirstRow, mergePayFirst, getPayFirstRowsForPhone, getActivePayFirstHolds, getPayFirstRowBySession,
  claimPayFirst, getPayFirstRowsForSweep, getBookingEventByPaymentIntent,
  flagQueueFailure, clearQueueFailure, QUEUE_FAIL_REASON,
  initialize,
  query,
  pool,
  // Team-edited settings
  getSettingsRows,
  insertSettingsRow,
  getSettingsHistory,
  getSettingsRowById,
  cancelSettingsRow,
  insertCampaignImage,
  getCampaignImage,
  campaignImageExists,
  // Conversations
  logConversation,
  endConversation,
  markConversationEscalated,
  // Messages
  logMessage,
  getMessagesByPhone,
  getMessagesSince,
  getLastInboundMessageAt,
  getLastMessageAt,
  claimPromoMessage,
  saveConversationState,
  loadConversationState,
  isHumanHandling,
  getUnansweredConversations,
  getOpenJourneyForDay,
  setNeedsReply,
  clearNeedsReply,
  setWorkingOn,
  markHandled,
  getConversationStatus,
  recordManualPaymentLink,
  settleManualPaymentLink,
  getManualPaymentLinks,
  queueTeamMessage,
  claimQueuedTeamMessages,
  cancelQueuedTeamMessages,
  markReopenSent,
  releaseQueuedTeamMessage,
  getPendingQueuedTeamMessages,
  setConversationLanguage,
  getGuestLanguage,
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
  getLastReminderAt,
  hasReminderBeenSent,
  // Webhook dedup
  isWebhookProcessed,
  markWebhookProcessed,
};
