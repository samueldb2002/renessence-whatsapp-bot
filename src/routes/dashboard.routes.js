const express = require('express');
const router = express.Router();
const db = require('../data/database');
const dashboardAuth = require('../middleware/dashboard-auth');
const mindbodyService = require('../services/mindbody.service');
const { PRICE_MAP, createCustomPaymentLink } = require('../services/payment.service');
const whatsappService = require('../services/whatsapp.service');
const logger = require('../utils/logger');
const { withSendLock } = require('../utils/user-lock');
const teamQueue = require('../services/team-queue.service');

router.use(dashboardAuth);

// --- Media (customer photos shown in the conversation view) ---
router.get('/media/:id', async (req, res) => {
  try {
    const m = await db.getMedia(req.params.id);
    if (!m) return res.status(404).end();
    res.set('Content-Type', m.mime || 'application/octet-stream');
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(m.data);
  } catch (err) {
    logger.error('Dashboard media error:', err.message);
    res.status(500).end();
  }
});

// --- Overview stats ---
router.get('/stats', async (req, res) => {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay() + 1).toISOString();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const [bookingsToday, bookingsWeek, bookingsMonth, revenueToday, revenueWeek, revenueMonth, conversationsToday, escalationsOpen, conversionData] = await Promise.all([
      db.query(`SELECT COUNT(*) as count FROM booking_events WHERE created_at >= $1 AND status IN ('pending','confirmed','payment_sent','paid','pay_on_location')`, [todayStart]),
      db.query(`SELECT COUNT(*) as count FROM booking_events WHERE created_at >= $1 AND status IN ('pending','confirmed','payment_sent','paid','pay_on_location')`, [weekStart]),
      db.query(`SELECT COUNT(*) as count FROM booking_events WHERE created_at >= $1 AND status IN ('pending','confirmed','payment_sent','paid','pay_on_location')`, [monthStart]),
      db.query(`SELECT COALESCE(SUM(amount_cents), 0) as total FROM booking_events WHERE COALESCE(paid_at, created_at) >= $1 AND status IN ('paid', 'pay_on_location')`, [todayStart]),
      db.query(`SELECT COALESCE(SUM(amount_cents), 0) as total FROM booking_events WHERE COALESCE(paid_at, created_at) >= $1 AND status IN ('paid', 'pay_on_location')`, [weekStart]),
      db.query(`SELECT COALESCE(SUM(amount_cents), 0) as total FROM booking_events WHERE COALESCE(paid_at, created_at) >= $1 AND status IN ('paid', 'pay_on_location')`, [monthStart]),
      db.query(`SELECT COUNT(*) as count FROM conversations WHERE started_at >= $1`, [todayStart]),
      db.query(`SELECT COUNT(*) as count FROM escalations WHERE resolved = FALSE`),
      db.query(`SELECT
        COUNT(*) FILTER (WHERE true) as total_conversations,
        COUNT(*) FILTER (WHERE intent = 'book_appointment') as booking_intents,
        COUNT(*) FILTER (WHERE escalated = TRUE) as escalated
        FROM conversations WHERE started_at >= $1`, [monthStart]),
    ]);

    const paidMonth = await db.query(
      `SELECT COUNT(*) as count FROM booking_events WHERE created_at >= $1 AND status = 'paid'`, [monthStart]
    );

    const totalConv = parseInt(conversionData.rows[0]?.total_conversations || 0);
    const bookingIntents = parseInt(conversionData.rows[0]?.booking_intents || 0);
    const paidCount = parseInt(paidMonth.rows[0]?.count || 0);

    res.json({
      bookings: {
        today: parseInt(bookingsToday.rows[0].count),
        week: parseInt(bookingsWeek.rows[0].count),
        month: parseInt(bookingsMonth.rows[0].count),
      },
      revenue: {
        today: parseInt(revenueToday.rows[0].total),
        week: parseInt(revenueWeek.rows[0].total),
        month: parseInt(revenueMonth.rows[0].total),
      },
      conversations: {
        today: parseInt(conversationsToday.rows[0].count),
      },
      escalations: {
        open: parseInt(escalationsOpen.rows[0].count),
      },
      conversion: {
        totalConversations: totalConv,
        bookingIntents,
        paid: paidCount,
        rate: totalConv > 0 ? ((paidCount / totalConv) * 100).toFixed(1) : 0,
      },
    });
  } catch (err) {
    logger.error('Dashboard stats error:', err.message);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// --- Bookings list ---
router.get('/bookings', async (req, res) => {
  try {
    const { from, to, status, search, limit = 50, offset = 0 } = req.query;
    let query = `SELECT * FROM booking_events WHERE 1=1`;
    const params = [];
    let idx = 1;

    if (from) {
      query += ` AND created_at >= $${idx}`;
      params.push(from);
      idx++;
    }
    if (to) {
      query += ` AND created_at <= $${idx}`;
      params.push(to);
      idx++;
    }
    if (status) {
      query += ` AND status = $${idx}`;
      params.push(status);
      idx++;
    }
    if (search) {
      // Search across customer name, treatment and phone
      query += ` AND (customer_name ILIKE $${idx} OR service_name ILIKE $${idx} OR phone ILIKE $${idx})`;
      params.push(`%${search}%`);
      idx++;
    }

    query += ` ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(query, params);

    let countQuery = `SELECT COUNT(*) as total FROM booking_events WHERE 1=1`;
    const countParams = [];
    let countIdx = 1;
    if (from)   { countQuery += ` AND created_at >= $${countIdx++}`; countParams.push(from); }
    if (to)     { countQuery += ` AND created_at <= $${countIdx++}`; countParams.push(to); }
    if (status) { countQuery += ` AND status = $${countIdx++}`;      countParams.push(status); }
    if (search) { countQuery += ` AND (customer_name ILIKE $${countIdx} OR service_name ILIKE $${countIdx} OR phone ILIKE $${countIdx})`; countParams.push(`%${search}%`); countIdx++; }
    const countResult = await db.query(countQuery, countParams);

    res.json({
      bookings: result.rows,
      total: parseInt(countResult.rows[0].total),
    });
  } catch (err) {
    logger.error('Dashboard bookings error:', err.message);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

// --- Revenue ---
router.get('/revenue', async (req, res) => {
  try {
    const { from, to, groupBy = 'day' } = req.query;
    const dateFrom = from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const dateTo = to || new Date().toISOString();

    const trunc = groupBy === 'month' ? 'month' : groupBy === 'week' ? 'week' : 'day';

    const result = await db.query(
      `SELECT DATE_TRUNC($1, COALESCE(paid_at, created_at)) as period, SUM(amount_cents) as total, COUNT(*) as count
       FROM booking_events WHERE status IN ('paid', 'pay_on_location') AND COALESCE(paid_at, created_at) >= $2 AND COALESCE(paid_at, created_at) <= $3
       GROUP BY period ORDER BY period`,
      [trunc, dateFrom, dateTo]
    );

    const byService = await db.query(
      `SELECT service_name, SUM(amount_cents) as total, COUNT(*) as count
       FROM booking_events WHERE status IN ('paid', 'pay_on_location') AND COALESCE(paid_at, created_at) >= $1 AND COALESCE(paid_at, created_at) <= $2
       GROUP BY service_name ORDER BY total DESC`,
      [dateFrom, dateTo]
    );

    const totals = await db.query(
      `SELECT SUM(amount_cents) as total, COUNT(*) as count, AVG(amount_cents) as avg,
              COALESCE(SUM(amount_cents) FILTER (WHERE status = 'paid'), 0) as online,
              COALESCE(SUM(amount_cents) FILTER (WHERE status = 'pay_on_location'), 0) as on_location
       FROM booking_events WHERE status IN ('paid', 'pay_on_location') AND COALESCE(paid_at, created_at) >= $1 AND COALESCE(paid_at, created_at) <= $2`,
      [dateFrom, dateTo]
    );

    res.json({
      timeline: result.rows,
      byService: byService.rows,
      totals: {
        total: parseInt(totals.rows[0]?.total || 0),
        count: parseInt(totals.rows[0]?.count || 0),
        average: Math.round(parseFloat(totals.rows[0]?.avg || 0)),
        online: parseInt(totals.rows[0]?.online || 0),
        onLocation: parseInt(totals.rows[0]?.on_location || 0),
      },
    });
  } catch (err) {
    logger.error('Dashboard revenue error:', err.message);
    res.status(500).json({ error: 'Failed to fetch revenue' });
  }
});

// --- Popular services ---
router.get('/popular-services', async (req, res) => {
  try {
    const { from, to } = req.query;
    const dateFrom = from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const dateTo = to || new Date().toISOString();

    const result = await db.query(
      `SELECT service_name, COUNT(*) as count, SUM(CASE WHEN status IN ('paid', 'pay_on_location') THEN amount_cents ELSE 0 END) as revenue
       FROM booking_events WHERE created_at >= $1 AND created_at <= $2 AND service_name IS NOT NULL
       GROUP BY service_name ORDER BY count DESC LIMIT 15`,
      [dateFrom, dateTo]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error('Dashboard popular-services error:', err.message);
    res.status(500).json({ error: 'Failed to fetch popular services' });
  }
});

// --- Conversations ---
router.get('/conversations', async (req, res) => {
  try {
    const { limit = 50, offset = 0, archived = 'false', search } = req.query;
    const showArchived = archived === 'true';

    // Optional server-side search by name/phone so older conversations (beyond
    // the recency limit) remain findable — the dashboard otherwise only loads
    // the most recent N and couldn't reach anything older.
    const params = [showArchived];
    let searchClause = '';
    if (search && String(search).trim()) {
      params.push(`%${String(search).trim()}%`);
      searchClause = ` AND (c.customer_name ILIKE $${params.length} OR c.phone ILIKE $${params.length})`;
    }
    params.push(parseInt(limit));
    params.push(parseInt(offset));
    const limitIdx = params.length - 1;
    const offsetIdx = params.length;

    // Use DISTINCT ON (phone) to show only the most recent conversation per customer
    const result = await db.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (c.phone) c.*, (p.phone IS NOT NULL) AS bot_paused,
                COALESCE(s.needs_reply, FALSE) AS needs_reply, s.needs_reply_since, s.needs_reply_reason,
                s.working_on_by, s.working_on_since
         FROM conversations c
         LEFT JOIN paused_conversations p ON p.phone = c.phone
         LEFT JOIN conversation_status s ON s.phone = c.phone
         WHERE c.archived = $1${searchClause}
         ORDER BY c.phone, c.last_message_at DESC NULLS LAST
       ) sub
       ORDER BY last_message_at DESC NULLS LAST
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );

    const stats = await db.query(
      `SELECT
        COUNT(DISTINCT phone) as total,
        (SELECT COUNT(DISTINCT s.phone) FROM conversation_status s
          JOIN conversations c2 ON c2.phone = s.phone
          WHERE s.needs_reply AND c2.archived = $1) as escalated,
        COUNT(DISTINCT phone) FILTER (WHERE resolved = TRUE) as resolved,
        COUNT(DISTINCT phone) FILTER (WHERE language = 'nl') as dutch,
        COUNT(DISTINCT phone) FILTER (WHERE language = 'en') as english
       FROM conversations WHERE archived = $1`,
      [showArchived]
    );

    const intentDist = await db.query(
      `SELECT intent, COUNT(*) as count FROM (
         SELECT DISTINCT ON (phone) phone, intent FROM conversations
         WHERE intent IS NOT NULL AND archived = $1
         ORDER BY phone, last_message_at DESC NULLS LAST
       ) sub GROUP BY intent ORDER BY count DESC`,
      [showArchived]
    );

    res.json({
      // `escalated` is the per-guest "needs a reply from us" status (it used to
      // live on a 30-minute conversation row and vanished when the guest wrote again).
      conversations: result.rows.map(r => ({ ...r, escalated: !!r.needs_reply })),
      stats: stats.rows[0],
      intentDistribution: intentDist.rows,
    });
  } catch (err) {
    logger.error('Dashboard conversations error:', err.message);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// --- Send message from dashboard ---
router.post('/send-message', async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });
    await whatsappService.sendText(phone, message);
    await db.logMessage(phone, 'agent', message);
    logger.info('Dashboard sent message to', phone);
    res.json({ sent: true });
  } catch (err) {
    logger.error('Dashboard send-message error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Escalations ---
router.get('/escalations', async (req, res) => {
  try {
    const { resolved, limit = 50 } = req.query;
    let query = `SELECT * FROM escalations`;
    const params = [];

    if (resolved === 'true') {
      query += ` WHERE resolved = TRUE`;
    } else if (resolved === 'false') {
      query += ` WHERE resolved = FALSE`;
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit));

    const result = await db.query(query, params);
    const openCount = await db.query(`SELECT COUNT(*) as count FROM escalations WHERE resolved = FALSE`);

    res.json({
      escalations: result.rows,
      openCount: parseInt(openCount.rows[0].count),
    });
  } catch (err) {
    logger.error('Dashboard escalations error:', err.message);
    res.status(500).json({ error: 'Failed to fetch escalations' });
  }
});

// --- Resolve escalation ---
router.post('/escalations/:id/resolve', async (req, res) => {
  try {
    // Only the escalation entry itself. "Needs reply" can come from other
    // sources (a message on a paused chat, a failed cancel, a refund) and
    // "I'm on it" holds payment automation — both are cleared by Done in the chat.
    await db.resolveEscalation(req.params.id);
    res.json({ success: true });
  } catch (err) {
    logger.error('Dashboard resolve escalation error:', err.message);
    res.status(500).json({ error: 'Failed to resolve escalation' });
  }
});

// --- Mark no-show ---
router.post('/bookings/:id/no-show', async (req, res) => {
  try {
    await db.updateBookingEvent(req.params.id, {
      status: 'no_show',
      noShow: true,
      noShowMarkedAt: new Date().toISOString(),
    });
    res.json({ success: true });
  } catch (err) {
    logger.error('Dashboard no-show error:', err.message);
    res.status(500).json({ error: 'Failed to mark no-show' });
  }
});

// --- FAQ stats ---
router.get('/faq-stats', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT topic, COUNT(*) as count FROM faq_queries WHERE topic IS NOT NULL GROUP BY topic ORDER BY count DESC`
    );
    res.json(result.rows);
  } catch (err) {
    logger.error('Dashboard faq-stats error:', err.message);
    res.status(500).json({ error: 'Failed to fetch FAQ stats' });
  }
});

// --- Unanswered questions ---
router.get('/unanswered', async (req, res) => {
  try {
    const { limit = 30 } = req.query;
    const result = await db.query(
      `SELECT * FROM unanswered_questions ORDER BY occurrences DESC, last_asked_at DESC LIMIT $1`,
      [parseInt(limit)]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error('Dashboard unanswered error:', err.message);
    res.status(500).json({ error: 'Failed to fetch unanswered questions' });
  }
});

// --- Errors ---
router.get('/errors', async (req, res) => {
  try {
    const { from, to, limit = 50 } = req.query;
    const dateFrom = from || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const dateTo = to || new Date().toISOString();

    const result = await db.query(
      `SELECT * FROM errors WHERE created_at >= $1 AND created_at <= $2 ORDER BY created_at DESC LIMIT $3`,
      [dateFrom, dateTo, parseInt(limit)]
    );
    const count = await db.query(
      `SELECT COUNT(*) as count FROM errors WHERE created_at >= $1 AND created_at <= $2`,
      [dateFrom, dateTo]
    );
    res.json({ errors: result.rows, total: parseInt(count.rows[0].count) });
  } catch (err) {
    logger.error('Dashboard errors error:', err.message);
    res.status(500).json({ error: 'Failed to fetch errors' });
  }
});

// --- Upcoming appointments (from Mindbody) ---
router.get('/upcoming', async (req, res) => {
  try {
    const now = new Date();
    const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const startDate = now.toISOString().split('T')[0];
    const endDate = nextWeek.toISOString().split('T')[0];

    const appointments = await mindbodyService.getStaffAppointments(startDate, endDate);

    const formatted = (appointments || []).map(apt => ({
      id: apt.Id,
      clientName: apt.Client ? `${apt.Client.FirstName} ${apt.Client.LastName}` : 'Unknown',
      clientPhone: apt.Client?.MobilePhone || '',
      service: apt.SessionType?.Name || 'Unknown',
      staffName: apt.Staff?.DisplayName || apt.Staff?.Name || 'Unknown',
      startDateTime: apt.StartDateTime,
      endDateTime: apt.EndDateTime,
      status: apt.Status,
    }));

    res.json(formatted);
  } catch (err) {
    logger.error('Dashboard upcoming error:', err.message);
    res.status(500).json({ error: 'Failed to fetch upcoming appointments' });
  }
});

// --- Busiest days ---
router.get('/busiest-days', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT EXTRACT(DOW FROM created_at) as day_of_week, COUNT(*) as count
       FROM booking_events WHERE status IN ('pending', 'confirmed', 'payment_sent', 'paid', 'pay_on_location')
       GROUP BY day_of_week ORDER BY day_of_week`
    );
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const formatted = result.rows.map(r => ({
      day: dayNames[parseInt(r.day_of_week)],
      dayIndex: parseInt(r.day_of_week),
      count: parseInt(r.count),
    }));
    res.json(formatted);
  } catch (err) {
    logger.error('Dashboard busiest-days error:', err.message);
    res.status(500).json({ error: 'Failed to fetch busiest days' });
  }
});

// --- Health ---
router.get('/health', async (req, res) => {
  try {
    const dbCheck = await db.query('SELECT 1');
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      database: dbCheck ? 'connected' : 'error',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    // L4: removed process.memoryUsage() — exposes system info to any authenticated caller
    res.json({
      status: 'degraded',
      uptime: process.uptime(),
      database: 'error',
      timestamp: new Date().toISOString(),
    });
  }
});

// --- Bot pause/resume ---
// In-memory flag — global kill-switch. Exported so message.handler.js can check it.
let botPaused = false;
function isBotPaused() { return botPaused; }
module.exports.isBotPaused = isBotPaused;

router.get('/bot-status', (req, res) => {
  res.json({ paused: botPaused });
});

router.post('/bot-stop', (req, res) => {
  const { password } = req.body;
  // M4: BOT_STOP_PASSWORD must be set independently — never fall back to DASHBOARD_API_TOKEN
  const stopPassword = process.env.BOT_STOP_PASSWORD;
  if (!stopPassword) return res.status(500).json({ error: 'BOT_STOP_PASSWORD not configured' });
  if (!password || password !== stopPassword) {
    return res.status(403).json({ error: 'Invalid password' });
  }
  botPaused = true;
  logger.info('Bot PAUSED globally via dashboard');
  res.json({ success: true, paused: true });
});

router.post('/bot-start', (req, res) => {
  const { password } = req.body;
  // M4: BOT_STOP_PASSWORD must be set independently — never fall back to DASHBOARD_API_TOKEN
  const stopPassword = process.env.BOT_STOP_PASSWORD;
  if (!stopPassword) return res.status(500).json({ error: 'BOT_STOP_PASSWORD not configured' });
  if (!password || password !== stopPassword) {
    return res.status(403).json({ error: 'Invalid password' });
  }
  botPaused = false;
  logger.info('Bot RESUMED globally via dashboard');
  res.json({ success: true, paused: false });
});

// --- Per-customer human takeover (pause / resume / send) ---

// GET /conversations/:phone/messages — full message history for a conversation
router.get('/conversations/:phone/messages', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    // Default high so long conversations show recent history — the query now
    // returns the most-recent N (not the oldest N), so new messages always show.
    const limit = parseInt(req.query.limit) || 500;
    const rows = await db.getMessagesByPhone(phone, limit);
    const paused = await db.isPaused(phone);
    const blocked = await db.isBlocked(phone);
    const status = await db.getConversationStatus(phone);
    const [paymentLinks, queuedMessages, guestLanguage, lastInbound, payFirstRows] = await Promise.all([
      db.getManualPaymentLinks(phone),
      db.getPendingQueuedTeamMessages(phone),
      db.getGuestLanguage(phone),
      db.getLastInboundMessageAt(phone),
      db.getPayFirstRowsForPhone ? db.getPayFirstRowsForPhone(phone) : Promise.resolve([]),
    ]);
    // Massages/facials paid before booking: what is waiting, paid, or needs the team.
    const payFirstBookings = (payFirstRows || []).slice(0, 5).map(r => ({
      id: r.id,
      service: r.service_name,
      start: r.pay_first?.startDateTime || null,
      status: r.status,
      amountCents: r.amount_cents,
      therapist: r.pay_first?.bookedStaffName || r.pay_first?.staffName || null,
      appointmentId: r.mindbody_appointment_id || null,
      reason: r.status === 'paid_unbooked' ? (r.cancel_reason || null) : null,
      paidAt: r.paid_at || null,
    }));
    const windowOpen = !!lastInbound && (Date.now() - new Date(lastInbound).getTime()) <= 24 * 3_600_000;
    res.json({
      messages: rows,
      paused,
      blocked,
      paymentLinks,
      payFirstBookings,
      queuedMessages,
      guestLanguage,
      lastInboundAt: lastInbound || null,
      windowOpen,
      reopenAvailable: !!process.env.WHATSAPP_REOPEN_TEMPLATE,
      reopenPending: invitationPending(status, lastInbound),
      reopenSentAt: status?.reopen_sent_at || null,
      needsReply: !!status?.needs_reply,
      needsReplySince: status?.needs_reply_since || null,
      needsReplyReason: status?.needs_reply_reason || null,
      workingOnBy: status?.working_on_by || null,
      workingOnSince: status?.working_on_since || null,
    });
  } catch (err) {
    logger.error('Dashboard get messages error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /conversations/:phone/pay-first/:id/resolve { resolution: 'rebooked'|'refunded', appointmentId? }
// The team settled a "paid, not booked" massage/facial by hand.
router.post('/conversations/:phone/pay-first/:id/resolve', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, error: 'bad id' });
    const row = await db.getBookingEventById(id);
    if (!row || row.phone !== phone) return res.status(404).json({ success: false, error: 'Booking not found for this chat.' });
    const { resolution, appointmentId } = req.body || {};
    const result = await require('../services/pay-first.service').resolvePaidUnbooked(id, { resolution, appointmentId });
    if (!result.ok) return res.json({ success: false, error: result.error });
    logger.info(`Pay-first row ${id} resolved by the team: ${resolution}${appointmentId ? ` (apt ${appointmentId})` : ''}`);
    res.json({ success: true });
  } catch (err) {
    logger.error('Dashboard pay-first resolve error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /conversations/:phone/pause — pause bot for this customer
/**
 * Replay customer messages the assistant missed in a time window (an outage).
 * Body: { since: ISO, until?: ISO, dryRun?: boolean (default TRUE — pass
 * false to actually send), template?: { name, language, useNameParam } for
 * customers outside WhatsApp's 24h window }. Returns what was/would be done.
 */
router.post('/outage/catch-up', async (req, res) => {
  try {
    const { since, until, dryRun, template } = req.body || {};
    if (!since || Number.isNaN(Date.parse(since))) {
      return res.status(400).json({ error: 'since (ISO datetime) is required' });
    }
    const sinceIso = new Date(since).toISOString();
    const untilIso = until && !Number.isNaN(Date.parse(until)) ? new Date(until).toISOString() : new Date().toISOString();
    if (Date.parse(untilIso) - Date.parse(sinceIso) > 7 * 24 * 3600 * 1000) {
      return res.status(400).json({ error: 'window may not exceed 7 days' });
    }
    const { runCatchUp } = require('../services/catch-up.service');
    const results = await runCatchUp({
      since: sinceIso,
      until: untilIso,
      dryRun: dryRun !== false,
      template: template && template.name ? template : undefined,
    });
    logger.info(`Catch-up via dashboard (${results.dryRun ? 'DRY RUN' : 'LIVE'}): ${results.answered.length} answered, ${results.unreachable.length} unreachable, ${results.templated.length} templated`);
    res.json(results);
  } catch (err) {
    logger.error('Catch-up route error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /conversations/:phone/working-on { name } — "I'm on it" (name: null releases it)
router.post('/conversations/:phone/working-on', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    const raw = req.body?.name;
    const name = raw == null ? null : String(raw).trim().slice(0, 60);
    if (raw != null && !name) return res.status(400).json({ error: 'name is required' });
    await db.setWorkingOn(phone, name);
    logger.info(`Working on ${phone}: ${name || '(released)'}`);
    res.json({ success: true, workingOnBy: name });
  } catch (err) {
    logger.error('Dashboard working-on error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /conversations/:phone/handled — "Done": nothing left to do for this guest
router.post('/conversations/:phone/handled', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    // Under the send lock: a parked reply being sent right now finishes first,
    // so Done can't miss it and it can't come back later.
    await withSendLock(phone, () => db.markHandled(phone));
    logger.info(`Conversation ${phone} marked handled`);
    res.json({ success: true });
  } catch (err) {
    logger.error('Dashboard handled error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** An invitation went out within the last 24h and the guest hasn't written since. */
function invitationPending(status, lastInbound) {
  const sent = status?.reopen_sent_at ? new Date(status.reopen_sent_at).getTime() : 0;
  if (!sent || Date.now() - sent > 24 * 3_600_000) return false;
  return !lastInbound || new Date(lastInbound).getTime() < sent;
}

// POST /conversations/:phone/queued/:id/cancel — drop a reply waiting for the re-open
router.post('/conversations/:phone/queued/:id/cancel', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, error: 'bad id' });
    // Waits for a delivery in progress, so "already sent" is the truth.
    const n = await withSendLock(phone, async () => {
      const cancelled = await db.cancelQueuedTeamMessages(phone, id);
      // Cancelling the reply that kept failing resolves that flag too.
      if (cancelled > 0) await db.clearQueueFailure(phone);
      return cancelled;
    });
    if (n === 0) return res.json({ success: false, alreadySent: true, error: 'Too late to cancel — that reply was already sent (or cancelled).' });
    res.json({ success: true });
  } catch (err) {
    logger.error('Dashboard cancel queued error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /conversations/:phone/queued/deliver — the window is open again: send
// the parked replies now (e.g. after an earlier delivery attempt failed)
router.post('/conversations/:phone/queued/deliver', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    const lastInbound = await db.getLastInboundMessageAt(phone);
    if (!lastInbound || Date.now() - new Date(lastInbound).getTime() > 24 * 3_600_000) {
      return res.json({ success: false, error: 'The 24-hour window is closed — these go out when the guest answers.' });
    }
    const result = await teamQueue.deliverQueuedTeamMessages(phone);
    res.json({ success: !result.failed, sent: result.sent, ...(result.failed ? { error: `Sending failed${result.error ? ` (${String(result.error).slice(0, 120)})` : ''} — try again in a moment, or cancel that reply.` } : {}) });
  } catch (err) {
    logger.error('Dashboard deliver queued error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Re-open template (must be approved in WhatsApp Manager first). Same name
// in several languages: WHATSAPP_REOPEN_TEMPLATE_LANGS="en,nl".
function reopenTemplateConfig() {
  const name = process.env.WHATSAPP_REOPEN_TEMPLATE;
  if (!name) return null;
  const langs = String(process.env.WHATSAPP_REOPEN_TEMPLATE_LANGS || 'en').split(',').map(x => x.trim()).filter(Boolean);
  return { name, langs: langs.length ? langs : ['en'], useNameParam: process.env.WHATSAPP_REOPEN_TEMPLATE_HAS_NAME === 'true' };
}

/**
 * POST /conversations/:phone/reopen { message? } — the guest's 24-hour window
 * has closed, so a normal reply can't reach them. Send the approved re-open
 * template ("we have an update — reply to continue"), park the team's reply
 * until the guest answers (then it is delivered automatically), and pause the
 * bot so that answer reaches the team instead of the bot.
 */
router.post('/conversations/:phone/reopen', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    if (String(phone).startsWith('web_')) {
      return res.status(400).json({ success: false, error: 'Web chats have no WhatsApp window to re-open.' });
    }
    const message = req.body?.message ? String(req.body.message).trim() : '';
    if (message.length > 4000) return res.status(400).json({ success: false, error: 'Message too long (max 4000 characters).' });

    const tpl = reopenTemplateConfig();
    if (!tpl) {
      return res.json({
        success: false,
        notConfigured: true,
        error: 'Re-opening needs an approved WhatsApp template. Create it in WhatsApp Manager, then set WHATSAPP_REOPEN_TEMPLATE in Coolify.',
      });
    }

    const lastInbound = await db.getLastInboundMessageAt(phone);
    if (lastInbound && (Date.now() - new Date(lastInbound).getTime()) <= 24 * 3_600_000) {
      return res.json({ success: false, windowOpen: true, error: 'The 24-hour window is still open — just send your message normally.' });
    }

    // Invitation already out and the guest hasn't answered: every template
    // costs money, so further replies only join the queue.
    const status = await db.getConversationStatus(phone);
    if (invitationPending(status, lastInbound)) {
      if (!message) return res.json({ success: false, error: 'The re-open invitation was already sent — waiting for the guest to answer.' });
      await db.queueTeamMessage(phone, message);
      return res.json({ success: true, queued: true, templateSent: false, paused: await db.isPaused(phone) });
    }

    const guestLang = await db.getGuestLanguage(phone);
    const lang = guestLang && tpl.langs.includes(guestLang) ? guestLang : tpl.langs[0];
    const nameRow = await db.query(
      `SELECT customer_name FROM conversations WHERE phone = $1 AND customer_name IS NOT NULL ORDER BY started_at DESC LIMIT 1`,
      [phone]
    );
    const customerName = nameRow.rows[0]?.customer_name || null;
    // WhatsApp rejects template parameters with newlines/tabs or empty text.
    const firstName = String(customerName || '').replace(/[\r\n\t]+/g, ' ').trim().split(/\s+/)[0]?.slice(0, 30)
      || (lang === 'nl' ? 'daar' : 'there');

    await whatsappService.sendTemplate(phone, tpl.name, lang, tpl.useNameParam ? [firstName] : []);
    await db.markReopenSent(phone);
    if (message) await db.queueTeamMessage(phone, message);
    // The guest's answer is meant for the team: keep the bot out of it.
    if (!(await db.isPaused(phone))) await db.pauseConversation(phone, customerName);
    await db.logMessage(phone, 'team', `📨 Re-open request sent (WhatsApp template)${message ? ' — the reply below is delivered as soon as the guest answers' : ''}. Bot paused for this chat.`);
    await db.clearNeedsReply(phone);
    logger.info(`Re-open template "${tpl.name}" (${lang}) sent to ${phone}${message ? ' with a queued reply' : ''}`);
    res.json({ success: true, queued: !!message, templateSent: true, paused: true });
  } catch (err) {
    const metaErr = err.response?.data?.error?.message;
    logger.error('Dashboard reopen error:', metaErr || err.message);
    // A refusal from WhatsApp is a normal outcome to show the team (like the
    // send route's delivery warnings); anything else is a server error.
    if (metaErr) return res.json({ success: false, error: `WhatsApp refused the re-open template: ${metaErr}` });
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /translate { text, target: 'en'|'nl' } — for the team, nothing is sent
router.post('/translate', async (req, res) => {
  const { text, target } = req.body || {};
  if (!['en', 'nl'].includes(target)) return res.status(400).json({ error: "target must be 'en' or 'nl'" });
  try {
    const translated = await require('../services/translation.service').translate(text, target);
    res.json({ translated });
  } catch (err) {
    const userError = /too long|Nothing to translate|Unsupported/.test(err.message);
    logger.warn('Dashboard translate error:', err.message);
    res.status(userError ? 400 : 502).json({ error: userError ? err.message : 'Translation failed — please try again.' });
  }
});

router.post('/conversations/:phone/pause', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    const { customer_name } = req.body;
    const wasPaused = await db.isPaused(phone);
    await db.pauseConversation(phone, customer_name);
    logger.info(`Bot PAUSED for ${phone} via dashboard`);

    // Let the customer know a real person has taken over — only on WhatsApp,
    // and only the first time it's paused (don't re-send if already paused).
    if (!wasPaused && !String(phone).startsWith('web_')) {
      const conversationService = require('../services/conversation.service');
      const lang = conversationService.get(phone)?.lang || 'en';
      const msg = lang === 'nl'
        ? 'Bedankt voor je geduld! Je spreekt nu met een echt persoon uit het Renessence-team 🌿 Waarmee kunnen we je helpen?'
        : 'Thank you for your patience! You\'re now speaking with a real person from the Renessence team 🌿 How can we help you?';
      whatsappService.sendText(phone, msg)
        .then(() => db.logMessage(phone, 'team', msg))
        .catch(err => logger.warn('Pause handoff message failed:', err.message));
    }

    res.json({ success: true, paused: true });
  } catch (err) {
    logger.error('Dashboard pause error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /conversations/:phone/send — team sends a WhatsApp message while bot is paused
router.post('/conversations/:phone/send', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'message required' });

    // Special command: reset the bot's in-memory conversation context
    if (message.trim().toLowerCase() === 'reset conversation') {
      const conversationService = require('../services/conversation.service');
      conversationService.clear(phone);
      logger.info(`Conversation reset for ${phone} via dashboard command`);
      return res.json({ success: true, reset: true });
    }

    // WhatsApp only delivers free-form replies within 24 hours of the customer's
    // last message. Outside that window WhatsApp silently drops the message — the
    // team sees it as sent, but the customer never receives it (real incident).
    // Block and warn instead of pretending it was delivered.
    const lastInbound = await db.getLastInboundMessageAt(phone);
    const hoursSince = lastInbound ? (Date.now() - new Date(lastInbound).getTime()) / 3_600_000 : Infinity;
    if (hoursSince > 24) {
      logger.warn(`Team message to ${phone} NOT sent — outside WhatsApp 24h window (${lastInbound ? hoursSince.toFixed(1) + 'h' : 'no inbound'})`);
      return res.json({
        success: false,
        outsideWindow: true,
        hoursSince: lastInbound ? Math.round(hoursSince) : null,
        error: lastInbound
          ? `Not delivered: this customer last messaged about ${Math.round(hoursSince)} hours ago. WhatsApp only allows free replies within 24 hours of the customer's last message, so this wouldn't reach them. Contact them another way (email/phone), or wait until they message again.`
          : `Not delivered: there is no incoming message from this customer, so WhatsApp won't allow a free reply. Contact them another way.`,
      });
    }

    // Replies parked for the re-open go first — a direct reply must not
    // overtake them. If one of them can't be sent, don't send this one either.
    // All under the guest's send lock, so a delivery already running (the
    // guest just wrote) finishes before this reply goes out.
    const out = await withSendLock(phone, async () => {
      const flushed = await teamQueue.deliverQueuedUnlocked(phone);
      if (flushed.failed) return { held: true };
      await whatsappService.sendText(phone, message.trim());
      await db.logMessage(phone, 'team', message.trim());
      return { held: false };
    });
    if (out.held) {
      return res.json({ success: false, error: 'An earlier reply that was waiting to be sent could not be delivered, so this one was held back too (to keep the order). Try again in a moment, or cancel the waiting reply.' });
    }
    await db.clearNeedsReply(phone);
    logger.info(`Team message sent to ${phone}`);
    res.json({ success: true });
  } catch (err) {
    logger.error('Dashboard send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /conversations/:phone/payment-link — team sends a manual Stripe payment link
router.post('/conversations/:phone/payment-link', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    const { amount, description, customer_email } = req.body;

    const amountNum = parseFloat(amount);
    if (!(amountNum > 0) || amountNum > 5000) {
      return res.status(400).json({ error: 'Enter a valid amount between €0 and €5000.' });
    }
    if (!description?.trim()) {
      return res.status(400).json({ error: 'Add a short description of what the payment is for.' });
    }

    // Same WhatsApp 24-hour window as team text messages: outside it the link
    // won't be delivered, so don't create a Stripe session that never reaches them.
    const lastInbound = await db.getLastInboundMessageAt(phone);
    const hoursSince = lastInbound ? (Date.now() - new Date(lastInbound).getTime()) / 3_600_000 : Infinity;
    if (hoursSince > 24) {
      return res.json({
        success: false,
        outsideWindow: true,
        error: lastInbound
          ? `Not delivered: this customer last messaged about ${Math.round(hoursSince)} hours ago, outside WhatsApp's 24-hour window. Reach them another way.`
          : `Not delivered: there is no incoming message from this customer, so WhatsApp won't allow the link to be sent.`,
      });
    }

    const amountCents = Math.round(amountNum * 100);
    const desc = description.trim().substring(0, 200);
    const conversationService = require('../services/conversation.service');
    const lang = conversationService.get(phone)?.lang || 'en';
    const priceLabel = `€${amountNum.toFixed(2)}`;
    const bodyText = lang === 'nl'
      ? `Hier is je betaallink voor ${desc} (${priceLabel}) 💳`
      : `Here is your payment link for ${desc} (${priceLabel}) 💳`;

    // Like a direct reply: parked replies go first, and if one can't be sent
    // the link waits too (no Stripe session is created then).
    const out = await withSendLock(phone, async () => {
      const flushed = await teamQueue.deliverQueuedUnlocked(phone);
      if (flushed.failed) return { held: true };
      const payment = await createCustomPaymentLink({ amountCents, description: desc, customerEmail: customer_email, from: phone });
      await whatsappService.sendCTAButton(phone, bodyText, lang === 'nl' ? 'Betaal Nu' : 'Pay Now', payment.paymentUrl);
      // Track its status (waiting / paid / expired) for the dashboard.
      await db.recordManualPaymentLink({ phone, sessionId: payment.sessionId, amountCents, description: desc });
      // Record it in the conversation so the team sees what was sent.
      await db.logMessage(phone, 'team', `${bodyText}\n${payment.paymentUrl}`);
      return { held: false, payment };
    });
    if (out.held) {
      return res.json({ success: false, error: 'An earlier reply that was waiting to be sent could not be delivered, so the payment link was held back too (to keep the order). Try again in a moment, or cancel the waiting reply.' });
    }
    logger.info(`Manual payment link sent to ${phone}: ${priceLabel} (${desc})`);
    res.json({ success: true, paymentUrl: out.payment.paymentUrl });
  } catch (err) {
    logger.error('Manual payment link error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /conversations/:phone/block — block a number (fraud); the bot goes silent for it
router.post('/conversations/:phone/block', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    const { reason } = req.body || {};
    await db.blockNumber(phone, reason);
    logger.info(`Number BLOCKED via dashboard: ${phone}${reason ? ` (${reason})` : ''}`);
    res.json({ success: true, blocked: true });
  } catch (err) {
    logger.error('Dashboard block error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /conversations/:phone/unblock — unblock a number
router.post('/conversations/:phone/unblock', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    await db.unblockNumber(phone);
    logger.info(`Number UNBLOCKED via dashboard: ${phone}`);
    res.json({ success: true, blocked: false });
  } catch (err) {
    logger.error('Dashboard unblock error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /conversations/:phone/resume — re-enable bot (always silent)
router.post('/conversations/:phone/resume', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);

    await db.resumeConversation(phone);
    logger.info(`Bot RESUMED for ${phone} via dashboard`);

    // Clear in-memory session so the agent starts fresh on next customer message
    const conversationService = require('../services/conversation.service');
    conversationService.clear(phone);

    res.json({ success: true, paused: false });
  } catch (err) {
    logger.error('Dashboard resume error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /conversations/:phone/archive
router.post('/conversations/:phone/archive', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    await db.archiveConversation(phone);
    logger.info(`Conversation archived: ${phone}`);
    res.json({ success: true, archived: true });
  } catch (err) {
    logger.error('Dashboard archive error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /conversations/:phone/unarchive
router.post('/conversations/:phone/unarchive', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    await db.unarchiveConversation(phone);
    logger.info(`Conversation unarchived: ${phone}`);
    res.json({ success: true, archived: false });
  } catch (err) {
    logger.error('Dashboard unarchive error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// L3: only available in development — exposes internal Mindbody IDs
if (process.env.NODE_ENV !== 'production') {
  router.get('/debug/session-types', async (req, res) => {
    try {
      const services = await mindbodyService.getServices();
      res.json(services.map(s => ({ Id: s.Id, Name: s.Name, Duration: s.DefaultTimeLength })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

// Export for use in webhook handler
router.isBotPaused = () => botPaused;

module.exports = router;
