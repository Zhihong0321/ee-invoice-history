'use strict';
const { pool } = require('../src/db');
(async () => {
  const q = async (t, sql) => { console.log('\n=== '+t+' ==='); try { const r = await pool.query(sql); console.log(JSON.stringify(r.rows,null,1)); } catch(e){ console.log('ERROR: '+e.message); } };
  await q('U1 approved -> 59% crossing', `
    WITH ev AS (
      SELECT a.invoice_id, a.edited_at, c->>'after' AS af
      FROM invoice_audit_log a, LATERAL jsonb_array_elements(a.changes) c
      WHERE a.entity_type='seda' AND lower(c->>'field')='seda_status'
    ),
    ms AS (SELECT invoice_id, min(edited_at) FILTER (WHERE af ILIKE 'approved%') AS t_approved FROM ev GROUP BY 1),
    pay AS (
      SELECT i.id AS invoice_id, p.payment_date,
             sum(p.amount) OVER (PARTITION BY i.id ORDER BY p.payment_date, p.id) AS cum,
             i.total_amount
      FROM invoice i JOIN payment p ON p.linked_invoice = i.bubble_id
      WHERE i.total_amount > 0 AND p.payment_date IS NOT NULL AND p.amount IS NOT NULL
    ),
    x AS (SELECT invoice_id, min(payment_date) AS t_59 FROM pay WHERE cum >= 0.59*total_amount GROUP BY 1)
    SELECT count(*) AS n_pairs,
      count(*) FILTER (WHERE x.t_59 >= ms.t_approved) AS after_approval,
      round(avg(extract(epoch FROM (x.t_59-ms.t_approved))/86400.0)::numeric,2) AS avg_days_all,
      round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (x.t_59-ms.t_approved))/86400.0))::numeric,2) AS median_all
    FROM ms JOIN x USING (invoice_id) WHERE ms.t_approved IS NOT NULL`);
  await q('U2 kwp coverage via package+product', `
    SELECT count(*) AS seda_invoices,
      count(pr.solar_output_rating) AS has_watt,
      count(p.panel_qty) AS has_qty,
      count(*) FILTER (WHERE p.panel_qty IS NOT NULL AND pr.solar_output_rating IS NOT NULL) AS computable_kwp
    FROM invoice i
    LEFT JOIN package p ON p.bubble_id = i.linked_package
    LEFT JOIN product pr ON pr.bubble_id = p.panel
    WHERE i.linked_seda_registration IS NOT NULL`);
  await pool.end();
})();
