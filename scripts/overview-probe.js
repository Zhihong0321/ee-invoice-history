'use strict';
const { pool } = require('../src/db');
const { routerPool } = require('../src/routerDb');
async function q(l, sql, p) {
  try { const r = await pool.query(sql, p); console.log(`\n=== ${l} ===\n` + JSON.stringify(r.rows).slice(0,3000)); }
  catch (e) { console.log(`\n=== ${l} ERR ${e.message}`); }
}
(async () => {
  await q('activity_log app x entity_type (7d)',
    `SELECT app, entity_type, count(*) n, max(occurred_at) last FROM activity_log
     WHERE occurred_at > now() - interval '30 days' GROUP BY 1,2 ORDER BY n DESC LIMIT 40`);
  await q('activity_log all-time app', `SELECT app, count(*) n, max(occurred_at) last FROM activity_log GROUP BY 1 ORDER BY n DESC`);
  await q('invoice_audit_log entity 30d',
    `SELECT entity_type, count(*) n, max(edited_at) last FROM invoice_audit_log
     WHERE edited_at > now() - interval '30 days' GROUP BY 1 ORDER BY n DESC`);
  await q('ai_activity_log apps', `SELECT app, count(*) n, max(created_at) last FROM ai_activity_log GROUP BY 1 ORDER BY n DESC LIMIT 20`);
  await q('ai_activity_log cols', `SELECT string_agg(column_name,', ' ORDER BY ordinal_position) c FROM information_schema.columns WHERE table_name='ai_activity_log'`);
  try {
    const r = await routerPool.query(`SELECT count(*) n, max(created_at) last FROM request_logs`);
    console.log('\n=== router request_logs ===\n' + JSON.stringify(r.rows));
  } catch (e) { console.log('\n=== router ERR ' + e.message); }
  process.exit(0);
})();
