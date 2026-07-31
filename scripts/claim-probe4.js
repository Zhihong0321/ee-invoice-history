'use strict';
const { pool } = require('../src/db');
const Q = [
  ['F1 activity_log rows for claim-system', `SELECT app, app_env, action, entity_type, count(*) n, min(occurred_at) f, max(occurred_at) l FROM activity_log WHERE app='claim-system' OR entity_type='claim_receipt' GROUP BY 1,2,3,4 ORDER BY n DESC`],
  ['F2 claim_receipt status/currency mix', `SELECT status, currency, count(*) n, sum(amount) total FROM claim_receipt GROUP BY 1,2 ORDER BY n DESC`],
  ['F3 claim_receipt category + submitters', `SELECT category, submitted_by, count(*) n FROM claim_receipt GROUP BY 1,2 ORDER BY n DESC`],
  ['F4 claim_receipt all rows brief', `SELECT id, vendor, item, amount, currency, category, status, submitted_by, receipt_date, created_at, (file_url IS NOT NULL) AS has_file FROM claim_receipt ORDER BY created_at DESC`],
];
(async () => {
  for (const [t, sql] of Q) {
    console.log('\n=============== ' + t + ' ===============');
    try { const r = await pool.query(sql); console.log(JSON.stringify(r.rows, null, 1)); }
    catch (e) { console.log('ERROR: ' + e.message); }
  }
  await pool.end();
})();
