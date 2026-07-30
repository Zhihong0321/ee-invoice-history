const { pool } = require('../src/db');
const { loadSedaActivity, loadSedaCycleTimes } = require('../src/repo/activityLogV2');
(async () => {
  const c = await pool.connect();
  const stats = await loadSedaCycleTimes(c);
  console.log('CYCLE:', JSON.stringify(stats));
  const rows = await loadSedaActivity(c, { limit: 6 });
  console.log('ROWS:', rows.length);
  console.log(JSON.stringify(rows.slice(0,4), null, 1));
  const backfill = await loadSedaActivity(c, { limit: 5, kinds: ['status'], includeBackfill: true });
  console.log('STATUS+BACKFILL:', backfill.length, backfill[0] && backfill[0].summary);
  const docs = await loadSedaActivity(c, { limit: 3, kinds: ['documents'] });
  console.log('DOCS:', docs.length, docs[0] && docs[0].summary);
  await pool.end();
})();
