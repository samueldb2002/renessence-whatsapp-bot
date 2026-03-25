/**
 * Sync services from Mindbody to local cache.
 * Usage: node tools/sync-services.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://api.mindbodyonline.com/public/v6';
const OUTPUT = path.join(__dirname, '../src/data/services.json');

const api = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Content-Type': 'application/json',
    'Api-Key': process.env.MINDBODY_API_KEY,
    SiteId: process.env.MINDBODY_SITE_ID,
  },
});

async function main() {
  console.log('Syncing services from Mindbody...');

  try {
    // Get token
    const tokenRes = await api.post('/usertoken/issue', {
      Username: process.env.MINDBODY_USERNAME,
      Password: process.env.MINDBODY_PASSWORD,
    });
    const token = tokenRes.data.AccessToken;

    // Get services
    const res = await api.get('/site/sessiontypes', {
      headers: { authorization: token },
      params: { OnlineOnly: true },
    });

    const services = (res.data.SessionTypes || []).map((s) => ({
      Id: s.Id,
      Name: s.Name,
      DefaultTimeLength: s.DefaultTimeLength,
      Description: s.OnlineDescription || s.Description || '',
      Price: s.NumDeducted || null,
    }));

    fs.writeFileSync(OUTPUT, JSON.stringify(services, null, 2));
    console.log(`Synced ${services.length} services to ${OUTPUT}`);
    services.forEach((s) => console.log(`  - ${s.Name} (${s.DefaultTimeLength} min)`));
  } catch (err) {
    console.error('Sync failed:', err.response?.data || err.message);
  }
}

main();
