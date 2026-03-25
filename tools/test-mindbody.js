/**
 * Test Mindbody API connectivity and credentials.
 * Usage: node tools/test-mindbody.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const axios = require('axios');

const BASE_URL = 'https://api.mindbodyonline.com/public/v6';

const api = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Content-Type': 'application/json',
    'Api-Key': process.env.MINDBODY_API_KEY,
    SiteId: process.env.MINDBODY_SITE_ID,
  },
});

async function main() {
  console.log('Testing Mindbody connection...');
  console.log(`Site ID: ${process.env.MINDBODY_SITE_ID}`);
  console.log('');

  // Step 1: Get user token
  console.log('1. Requesting user token...');
  try {
    const tokenRes = await api.post('/usertoken/issue', {
      Username: process.env.MINDBODY_USERNAME,
      Password: process.env.MINDBODY_PASSWORD,
    });
    const token = tokenRes.data.AccessToken;
    console.log('   Token obtained successfully');

    // Step 2: Get session types / services
    console.log('2. Fetching services (session types)...');
    const servicesRes = await api.get('/site/sessiontypes', {
      headers: { authorization: token },
    });
    const services = servicesRes.data.SessionTypes || [];
    console.log(`   Found ${services.length} services:`);
    services.forEach((s) => {
      console.log(`   - ${s.Name} (ID: ${s.Id}, ${s.DefaultTimeLength} min)`);
    });

    // Step 3: Get staff
    console.log('3. Fetching staff...');
    const staffRes = await api.get('/staff/staff', {
      headers: { authorization: token },
    });
    const staff = staffRes.data.StaffMembers || [];
    console.log(`   Found ${staff.length} staff members:`);
    staff.forEach((s) => {
      console.log(`   - ${s.FirstName} ${s.LastName} (ID: ${s.Id})`);
    });

    console.log('\nAll tests passed!');
  } catch (err) {
    console.error('Error:', err.response?.data || err.message);
  }
}

main();
