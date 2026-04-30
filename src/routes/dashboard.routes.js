const express = require('express');
const router = express.Router();
const db = require('../data/database');
const dashboardAuth = require('../middleware/dashboard-auth');
const mindbodyService = require('../services/mindbody.service');
const { PRICE_MAP } = require('../services/payment.service');
const logger = require('../utils/logger');

router.use(dashboardAuth);

// --- Overview stats ---
router.get('/stats', async (req, res) => {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay() + 1).toISOString();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const [bookingsToday, bookingsWeek, bookingsMonth, revenueToday, revenueWeek, revenueMonth, conversationsToday, escalationsOpen, conversionData] = await Promise.all([
      db.query(`SELECT COUNT(*) as count FROM booking_events WHERE created_at >= $1 AND status IN ('confirmed','payment_sent','paid')`, [todayStart]),
      db.query(`SELECT COUNT(*) as count FROM booking_events WHERE created_at >= $1 AND status IN ('confirmed','payment_sent','paid')`, [weekStart]),
      db.query(`SELECT COUNT(*) as count FROM booking_events WHERE created_at >= $1 AND status IN ('confirmed','payment_sent','paid')`, [monthStart]),
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
    const { from, to, status, limit = 50, offset = 0 } = req.query;
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

    query += ` ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(query, params);

    const countQuery = `SELECT COUNT(*) as total FROM booking_events WHERE 1=1` +
      (from ? ` AND created_at >= '${from}'` : '') +
      (to ? ` AND created_at <= '${to}'` : '') +
      (status ? ` AND status = '${status}'` : '');
    const countResult = await db.query(countQuery);

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
    const { from, to, limit = 50, offset = 0 } = req.query;
    const dateFrom = from || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const dateTo = to || new Date().toISOString();

    const result = await db.query(
      `SELECT * FROM conversations WHERE started_at >= $1 AND started_at <= $2 ORDER BY started_at DESC LIMIT $3 OFFSET $4`,
      [dateFrom, dateTo, parseInt(limit), parseInt(offset)]
    );

    const stats = await db.query(
      `SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE escalated = TRUE) as escalated,
        COUNT(*) FILTER (WHERE resolved = TRUE) as resolved,
        COUNT(*) FILTER (WHERE language = 'nl') as dutch,
        COUNT(*) FILTER (WHERE language = 'en') as english
       FROM conversations WHERE started_at >= $1 AND started_at <= $2`,
      [dateFrom, dateTo]
    );

    const intentDist = await db.query(
      `SELECT intent, COUNT(*) as count FROM conversations WHERE started_at >= $1 AND started_at <= $2 AND intent IS NOT NULL GROUP BY intent ORDER BY count DESC`,
      [dateFrom, dateTo]
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
       FROM booking_events WHERE status IN ('confirmed', 'payment_sent', 'paid')
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
      memory: process.memoryUsage(),
      database: dbCheck ? 'connected' : 'error',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.json({
      status: 'degraded',
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      database: 'error',
      timestamp: new Date().toISOString(),
    });
  }
});

// --- Bot pause/resume ---
// In-memory flag — when paused, the webhook ignores incoming messages
let botPaused = false;

router.get('/bot-status', (req, res) => {
  res.json({ paused: botPaused });
});

router.post('/bot-stop', (req, res) => {
  const { password } = req.body;
  const stopPassword = process.env.BOT_STOP_PASSWORD || process.env.DASHBOARD_API_TOKEN;
  if (!password || password !== stopPassword) {
    return res.status(403).json({ error: 'Invalid password' });
  }
  botPaused = true;
  logger.info('Bot PAUSED via dashboard');
  res.json({ success: true, paused: true });
});

router.post('/bot-start', (req, res) => {
  const { password } = req.body;
  const stopPassword = process.env.BOT_STOP_PASSWORD || process.env.DASHBOARD_API_TOKEN;
  if (!password || password !== stopPassword) {
    return res.status(403).json({ error: 'Invalid password' });
  }
  botPaused = false;
  logger.info('Bot RESUMED via dashboard');
  res.json({ success: true, paused: false });
});

// --- Debug: list all Mindbody session types ---
router.get('/debug/session-types', async (req, res) => {
  try {
    const services = await mindbodyService.getServices();
    res.json(services.map(s => ({ Id: s.Id, Name: s.Name, Duration: s.DefaultTimeLength })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export for use in webhook handler
router.isBotPaused = () => botPaused;

module.exports = router;
