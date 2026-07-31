'use strict';
const { pool } = require('../src/db');
const Q = [
  ['D1 claim_receipt columns', `SELECT column_name, data_type FROM information_schema.columns WHERE table_name='claim_receipt' AND table_schema='public' ORDER BY ordinal_position`],
  ['D2 claim_receipt volume', `SELECT count(*) AS n FROM claim_receipt`],
  ['D3 claim_receipt sample', `SELECT * FROM claim_receipt LIMIT 3`],
];
(async () => {
  for (const [t, sql] of Q) {
    console.log('\n=============== ' + t + ' ===============');
    try { const r = await pool.query(sql); console.log(JSON.stringify(r.rows, null, 1)); }
    catch (e) { console.log('ERROR: ' + e.message); }
  }
  await pool.end();
})();
