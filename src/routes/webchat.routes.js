const express = require('express');
const router = express.Router();
const { runWeb } = require('../agents/renessence.agent');
const db = require('../data/database');
const logger = require('../utils/logger');

// POST /webchat/message
router.post('/message', async (req, res) => {
  const { sessionId, message } = req.body;
  if (!sessionId || !message) {
    return res.status(400).json({ error: 'sessionId and message required' });
  }

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
