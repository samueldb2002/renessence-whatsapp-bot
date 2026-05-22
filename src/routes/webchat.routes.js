const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { runWeb } = require('../agents/renessence.agent');
const db = require('../data/database');
const logger = require('../utils/logger');

// H13: active server-issued session IDs — only these are accepted in /message
// Uses a Set so stale sessions don't accumulate forever (capped and auto-expired)
const activeSessions = new Map(); // sessionId → createdAt
const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const MAX_SESSIONS = 500;

function pruneOldSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, createdAt] of activeSessions.entries()) {
    if (createdAt < cutoff) activeSessions.delete(id);
  }
}

// GET /webchat/init — returns a server-generated session ID
router.get('/init', (req, res) => {
  pruneOldSessions();
  if (activeSessions.size >= MAX_SESSIONS) {
    return res.status(429).json({ error: 'Too many active sessions' });
  }
  const sessionId = crypto.randomBytes(16).toString('hex');
  activeSessions.set(sessionId, Date.now());
  res.json({ sessionId });
});

// POST /webchat/message
router.post('/message', async (req, res) => {
  const { sessionId, message } = req.body;
  if (!sessionId || !message) {
    return res.status(400).json({ error: 'sessionId and message required' });
  }

  // H13: only accept server-issued session IDs
  pruneOldSessions();
  if (!activeSessions.has(sessionId)) {
    return res.status(403).json({ error: 'Invalid or expired session' });
  }
  // Refresh TTL on activity
  activeSessions.set(sessionId, Date.now());

  try {
    db.logMessage(`web_${sessionId}`, 'user', message);
    const response = await runWeb(sessionId, message);
    res.json(response);
  } catch (err) {
    logger.error('Webchat error:', err.message);
    res.status(500).json({ message: 'Something went wrong. Please try again.', ui_type: 'text' });
  }
});

module.exports = router;
