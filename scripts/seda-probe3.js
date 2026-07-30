'use strict';
const { pool } = require('../src/db');

// per-invoice first timestamp of each SEDA milestone
const MILESTONES = `
WITH seda_ev AS (
  SELECT a.invoice_id, a.edited_at, c->>'field' AS f, c->>'before' AS b, c->>'after' AS af
  FROM invoice_audit_log a, LATERAL jsonb_array_elements(a.changes) c
  WHERE a.entity_type='seda' AND lower(c->>'field')='seda_status'
),
ms AS (
  SELECT invoice_id,
    min(edited_at) FILTER (WHERE af='Pending')   AS t_pending,
    min(edited_at) FILTER (WHERE af='Submitted') AS t_submitted,
    min(edited_at) FILTER (WHERE af ILIKE 'approved%') AS t_approved
  FROM seda_ev GROUP BY invoice_id
)`;

const Q = [
    ['F1 milestone coverage per invoice', MILESTONES + `
        SELECT count(*) AS invoices_with_seda_status,
               count(t_pending) AS has_pending,
               count(t_submitted) AS has_submitted,
               count(t_approved) AS has_approved,
               count(*) FILTER (WHERE t_submitted IS NOT NULL AND t_approved IS NOT NULL) AS sub_and_appr,
               count(*) FILTER (WHERE t_pending IS NOT NULL AND t_submitted IS NOT NULL) AS pend_and_sub
        FROM ms`],
    ['F2 submitted -> approved durations', MILESTONES + `
        SELECT round(extract(epoch FROM (t_approved - t_submitted))/86400.0, 2) AS days,
               invoice_id
        FROM ms WHERE t_submitted IS NOT NULL AND t_approved IS NOT NULL
        ORDER BY 1`],
    ['F3 pending -> submitted durations (summary)', MILESTONES + `
        SELECT count(*) AS n,
               round(avg(extract(epoch FROM (t_submitted - t_pending))/86400.0),2) AS avg_days,
               round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (t_submitted - t_pending))/86400.0))::numeric,2) AS median_days,
               round(min(extract(epoch FROM (t_submitted - t_pending))/86400.0),2) AS min_days,
               round(max(extract(epoch FROM (t_submitted - t_pending))/86400.0),2) AS max_days
        FROM ms WHERE t_pending IS NOT NULL AND t_submitted IS NOT NULL`],
    ['G1 payment event inventory', `
        SELECT entity_type, action_type, count(*) AS n,
               min(edited_at)::date AS first_seen, max(edited_at)::date AS last_seen,
               count(DISTINCT invoice_id) AS invoices
        FROM invoice_audit_log
        WHERE entity_type IN ('payment','submitted_payment','verified_payment')
        GROUP BY 1,2 ORDER BY n DESC`],
    ['G2 first payment vs seda submitted — overlap + durations', MILESTONES + `,
    pay AS (
      SELECT invoice_id, min(edited_at) AS t_first_pay
      FROM invoice_audit_log
      WHERE (entity_type='submitted_payment' AND action_type='insert')
         OR (entity_type='payment' AND action_type='verify')
         OR (entity_type='verified_payment')
      GROUP BY 1
    )
    SELECT count(*) AS invoices_with_both_pay_and_submitted,
           round(avg(extract(epoch FROM (ms.t_submitted - pay.t_first_pay))/86400.0),2) AS avg_days,
           round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (ms.t_submitted - pay.t_first_pay))/86400.0))::numeric,2) AS median_days,
           round(min(extract(epoch FROM (ms.t_submitted - pay.t_first_pay))/86400.0),2) AS min_days,
           round(max(extract(epoch FROM (ms.t_submitted - pay.t_first_pay))/86400.0),2) AS max_days,
           count(*) FILTER (WHERE ms.t_submitted < pay.t_first_pay) AS submitted_before_payment
    FROM ms JOIN pay USING (invoice_id) WHERE ms.t_submitted IS NOT NULL`],
    ['G3 first-payment coverage vs seda invoices', MILESTONES + `,
    pay AS (
      SELECT invoice_id, min(edited_at) AS t_first_pay
      FROM invoice_audit_log
      WHERE (entity_type='submitted_payment' AND action_type='insert')
         OR (entity_type='payment' AND action_type='verify')
         OR (entity_type='verified_payment')
      GROUP BY 1
    )
    SELECT count(*) AS seda_invoices, count(pay.invoice_id) AS with_any_payment_event
    FROM ms LEFT JOIN pay USING (invoice_id)`],
    ['G4 payment date fields on invoice table', `
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name='invoice' AND (column_name ILIKE '%pay%' OR column_name ILIKE '%deposit%'
              OR column_name ILIKE '%date%') ORDER BY 1`],
    ['G5 sample end-to-end rows', MILESTONES + `,
    pay AS (
      SELECT invoice_id, min(edited_at) AS t_first_pay
      FROM invoice_audit_log
      WHERE (entity_type='submitted_payment' AND action_type='insert')
         OR (entity_type='payment' AND action_type='verify')
         OR (entity_type='verified_payment')
      GROUP BY 1
    )
    SELECT ms.invoice_id, pay.t_first_pay, ms.t_pending, ms.t_submitted, ms.t_approved
    FROM ms LEFT JOIN pay USING (invoice_id)
    WHERE ms.t_submitted IS NOT NULL ORDER BY ms.t_submitted DESC LIMIT 20`],
    ['H1 combined-feed volume check (all seda rows by day, last 14d)', `
        SELECT edited_at::date AS d, count(*) AS rows_total
        FROM invoice_audit_log WHERE entity_type ILIKE '%seda%'
          AND edited_at >= now() - interval '14 days'
        GROUP BY 1 ORDER BY 1 DESC`],
];

(async () => {
    for (const [t, sql] of Q) {
        console.log('\n\n=============== ' + t + ' ===============');
        try { const r = await pool.query(sql); console.log(JSON.stringify(r.rows, null, 1)); }
        catch (e) { console.log('ERROR: ' + e.message); }
    }
    await pool.end();
})();
