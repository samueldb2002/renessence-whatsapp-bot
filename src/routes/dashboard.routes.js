const express = require('express');
const router = express.Router();
const db = require('../data/database');
const dashboardAuth = require('../middleware/dashboard-auth');
const mindbodyService = require('../services/mindbody.service');
const { PRICE_MAP } = require('../services/payment.service');
const whatsappService = require('../services/whatsapp.service');
const logger = require('../utils/logger');

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
      db.query(`SELECT COUNT(*) as count FROM booking_events WHERE created_at >= $1 AND status IN ('pending','confirmed','payment_sent','paid')`, [todayStart]),
      db.query(`SELECT COUNT(*) as count FROM booking_events WHERE created_at >= $1 AND status IN ('pending','confirmed','payment_sent','paid')`, [weekStart]),
      db.query(`SELECT COUNT(*) as count FROM booking_events WHERE created_at >= $1 AND status IN ('pending','confirmed','payment_sent','paid')`, [monthStart]),
      db.query(`SELECT COALESCE(SUM(amount_cents), 0) as total FROM booking_events WHERE paid_at >= $1 AND status = 'paid'`, [todayStart]),
      db.query(`SELECT COALESCE(SUM(amount_cents), 0) as total FROM booking_events WHERE paid_at >= $1 AND status = 'paid'`, [weekStart]),
      db.query(`SELECT COALESCE(SUM(amount_cents), 0) as total FROM booking_events WHERE paid_at >= $1 AND status = 'paid'`, [monthStart]),
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
      `SELECT DATE_TRUNC($1, paid_at) as period, SUM(amount_cents) as total, COUNT(*) as count
       FROM booking_events WHERE status = 'paid' AND paid_at >= $2 AND paid_at <= $3
       GROUP BY period ORDER BY period`,
      [trunc, dateFrom, dateTo]
    );

    const byService = await db.query(
      `SELECT service_name, SUM(amount_cents) as total, COUNT(*) as count
       FROM booking_events WHERE status = 'paid' AND paid_at >= $1 AND paid_at <= $2
       GROUP BY service_name ORDER BY total DESC`,
      [dateFrom, dateTo]
    );

    const totals = await db.query(
      `SELECT SUM(amount_cents) as total, COUNT(*) as count, AVG(amount_cents) as avg
       FROM booking_events WHERE status = 'paid' AND paid_at >= $1 AND paid_at <= $2`,
      [dateFrom, dateTo]
    );

    res.json({
      timeline: result.rows,
      byService: byService.rows,
      totals: {
        total: parseInt(totals.rows[0]?.total || 0),
        count: parseInt(totals.rows[0]?.count || 0),
        average: Math.round(parseFloat(totals.rows[0]?.avg || 0)),
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
      `SELECT service_name, COUNT(*) as count, SUM(CASE WHEN status = 'paid' THEN amount_cents ELSE 0 END) as revenue
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
         SELECT DISTINCT ON (c.phone) c.*, (p.phone IS NOT NULL) AS bot_paused
         FROM conversations c
         LEFT JOIN paused_conversations p ON p.phone = c.phone
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
        COUNT(DISTINCT phone) FILTER (WHERE escalated = TRUE) as escalated,
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
      conversations: result.rows,
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
       FROM booking_events WHERE status IN ('pending', 'confirmed', 'payment_sent', 'paid')
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
    const limit = parseInt(req.query.limit) || 100;
    const rows = await db.getMessagesByPhone(phone, limit);
    const paused = await db.isPaused(phone);
    res.json({ messages: rows, paused });
  } catch (err) {
    logger.error('Dashboard get messages error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /conversations/:phone/pause — pause bot for this customer
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
        ? 'Onze bot is nog in training en heeft zelf ook af en toe wat hersteltijd nodig 🌿 Je bent nu in handen van een echt persoon uit het Renessence-team. Waarmee kunnen we je verder helpen?'
        : 'Our bot is still in training and even it needs a little recovery time now and then 🌿 You\'re now in the hands of a real person from the Renessence team. How can we help you?';
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

    // Send via WhatsApp
    await whatsappService.sendText(phone, message.trim());
    // Save to conversation history as a team message
    await db.logMessage(phone, 'team', message.trim());
    logger.info(`Team message sent to ${phone}`);
    res.json({ success: true });
  } catch (err) {
    logger.error('Dashboard send error:', err.message);
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
