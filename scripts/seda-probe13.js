'use strict';
const { pool } = require('../src/db');
(async () => {
  const q = async (t, sql) => { console.log('\n=== '+t+' ==='); try { const r = await pool.query(sql); console.log(JSON.stringify(r.rows,null,1)); } catch(e){ console.log('ERROR: '+e.message); } };
  await q('S1 package.panel values', `
    SELECT panel, count(*) AS n FROM package GROUP BY 1 ORDER BY n DESC LIMIT 15`);
  await q('S2 watt columns anywhere', `
    SELECT table_name, column_name FROM information_schema.columns
    WHERE column_name ILIKE '%watt%' OR column_name ILIKE '%_w' OR column_name ILIKE '%wp%'
    ORDER BY table_name LIMIT 30`);
  await q('S3 payment linkage + 59% crossing feasibility', `
    WITH pay AS (
      SELECT i.id AS invoice_id, i.total_amount, p.payment_date, p.amount,
             sum(p.amount) OVER (PARTITION BY i.id ORDER BY p.payment_date, p.id) AS cum
      FROM invoice i JOIN payment p ON p.linked_invoice = i.bubble_id
      WHERE i.total_amount > 0 AND p.payment_date IS NOT NULL AND p.amount IS NOT NULL
    ),
    cross59 AS (
      SELECT invoice_id, min(payment_date) AS t_59
      FROM pay WHERE cum >= 0.59 * total_amount GROUP BY 1
    )
    SELECT (SELECT count(DISTINCT invoice_id) FROM pay) AS invoices_with_payments,
           (SELECT count(*) FROM cross59) AS invoices_crossed_59`);
  await pool.end();
})();
