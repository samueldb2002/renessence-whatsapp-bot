require('dotenv').config();
const mindbody = require('../src/services/mindbody.service');

const start = process.argv[2] || '2026-06-11';
const end = process.argv[3] || '2026-06-12';
const ids = (process.argv[4] || '68,65,77,67,76').split(',').map(Number);

(async () => {
  for (const id of ids) {
    try {
      const items = await mindbody.getBookableItems(id, start, end);
      console.log(`\n=== sessionType ${id}: ${items.length} bookable item(s) ===`);
      items.slice(0, 5).forEach(it => {
        console.log(`  ${it.StartDateTime} → ${it.EndDateTime}  staff=${it.Staff?.Name || it.Staff?.Id || '-'}  st=${it.SessionType?.Id}`);
      });
    } catch (err) {
      console.log(`\n=== sessionType ${id}: ERROR ${err.message} ===`);
    }
  }
  process.exit(0);
})();
