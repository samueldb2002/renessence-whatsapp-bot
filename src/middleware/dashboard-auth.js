function dashboardAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const expectedToken = process.env.DASHBOARD_API_TOKEN;

  if (!expectedToken) {
    return res.status(500).json({ error: 'DASHBOARD_API_TOKEN not configured' });
  }

  if (!token || token !== expectedToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

module.exports = dashboardAuth;
