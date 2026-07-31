'use strict';
const { pool } = require('../src/db');
const Q = [
  ['E1 activity_log columns', `SELECT column_name, data_type FROM information_schema.columns WHERE table_name='activity_log' AND table_schema='public' ORDER BY ordinal_position`],
  ['E2 activity_log total + claim rows', `SELECT count(*) AS total, count(*) FILTER (WHERE to_jsonb(t)::text ILIKE '%claim%') AS claim_rows FROM activity_log t`],
  ['E3 claim rows in activity_log (latest 12)', `SELECT * FROM activity_log t WHERE to_jsonb(t)::text ILIKE '%claim%' ORDER BY 1 DESC LIMIT 12`],
  ['E4 claim_receipt now', `SELECT count(*) AS n, max(id) AS max_id FROM claim_receipt`],
  ['E5 claim_receipt #24', `SELECT * FROM claim_receipt WHERE id=24`],
];
(async () => {
  for (const [t, sql] of Q) {
    console.log('\n=============== ' + t + ' ===============');
    try { const r = await pool.query(sql); console.log(JSON.stringify(r.rows, null, 1)); }
    catch (e) { console.log('ERROR: ' + e.message); }
  }
  await pool.end();
})();
