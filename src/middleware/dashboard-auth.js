const crypto = require('crypto');

function dashboardAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const expectedToken = process.env.DASHBOARD_API_TOKEN;

  if (!expectedToken) {
    return res.status(500).json({ error: 'DASHBOARD_API_TOKEN not configured' });
  }

  // M1: timing-safe comparison to prevent timing attacks
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const a = Buffer.from(token.padEnd(expectedToken.length));
    const b = Buffer.from(expectedToken.padEnd(token.length));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

module.exports = dashboardAuth;
