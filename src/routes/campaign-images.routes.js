/**
 * /public: promotion posters uploaded on the dashboard, then the files in
 * public/. WhatsApp fetches a poster without our token when it delivers the
 * intro message. An uploaded poster's address is an unguessable id, and it
 * never changes after upload (a new upload gets a new id), so browsers and
 * WhatsApp may cache it forever.
 *
 * The dashboard shows posters from another site: helmet's same-origin
 * resource policy made the browser block them, so /public allows that.
 */
const path = require('path');
const express = require('express');
const db = require('../data/database');
const logger = require('../utils/logger');

const router = express.Router();
const FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(jpg|png)$/;

// A poster goes to every new conversation while its promotion runs: keep the
// few in use in memory instead of reading up to 2 MB from Postgres each time.
const cache = new Map();
const CACHE_MAX = 10;

router.get('/campaign/:file', async (req, res) => {
  const m = FILE.exec(req.params.file);
  if (!m) return res.status(404).end();
  try {
    let image = cache.get(m[1]);
    if (!image) {
      image = await db.getCampaignImage(m[1]);
      if (!image) return res.status(404).end();
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(m[1], image);
    }
    res.set({
      'Content-Type': image.mime,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    res.send(image.bytes);
  } catch (err) {
    logger.error('Campaign image error:', err.message);
    res.status(500).end();
  }
});

router.use(express.static(path.join(__dirname, '../../public'), {
  setHeaders: (res) => res.set('Cross-Origin-Resource-Policy', 'cross-origin'),
}));

module.exports = router;
