'use strict';
const { pool } = require('../src/db');
const MS = `
WITH seda_ev AS (
  SELECT a.invoice_id, a.edited_at, c->>'after' AS af
  FROM invoice_audit_log a, LATERAL jsonb_array_elements(a.changes) c
  WHERE a.entity_type='seda' AND lower(c->>'field')='seda_status'
),
ms AS (
  SELECT invoice_id,
    min(edited_at) FILTER (WHERE af='Submitted') AS t_submitted,
    min(edited_at) FILTER (WHERE af ILIKE 'approved%') AS t_approved
  FROM seda_ev GROUP BY invoice_id
)`;
const Q = [
    ['I1 submitted->approved summary', MS + `
        SELECT count(*) AS n,
          round(avg(extract(epoch FROM (t_approved-t_submitted))/86400.0),2) AS avg_days,
          round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (t_approved-t_submitted))/86400.0))::numeric,2) AS median_days
        FROM ms WHERE t_submitted IS NOT NULL AND t_approved IS NOT NULL`],
    ['I2 invoice.1st_payment_date coverage on seda invoices', MS + `
        SELECT count(*) AS seda_status_invoices,
               count(i."1st_payment_date") AS has_1st_payment_date,
               count(*) FILTER (WHERE ms.t_submitted IS NOT NULL) AS submitted,
               count(*) FILTER (WHERE ms.t_submitted IS NOT NULL AND i."1st_payment_date" IS NOT NULL) AS submitted_with_date
        FROM ms JOIN invoice i ON i.id = ms.invoice_id`],
    ['I3 1st_payment_date -> submitted durations', MS + `
        SELECT count(*) AS n,
          round(avg(extract(epoch FROM (ms.t_submitted - i."1st_payment_date"))/86400.0),2) AS avg_days,
          round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (ms.t_submitted - i."1st_payment_date"))/86400.0))::numeric,2) AS median_days,
          round(min(extract(epoch FROM (ms.t_submitted - i."1st_payment_date"))/86400.0),2) AS min_days,
          round(max(extract(epoch FROM (ms.t_submitted - i."1st_payment_date"))/86400.0),2) AS max_days,
          count(*) FILTER (WHERE ms.t_submitted < i."1st_payment_date") AS negative
        FROM ms JOIN invoice i ON i.id = ms.invoice_id
        WHERE ms.t_submitted IS NOT NULL AND i."1st_payment_date" IS NOT NULL`],
    ['I4 approvals by date (batching check)', MS + `
        SELECT t_approved::date AS d, count(*) AS n FROM ms
        WHERE t_approved IS NOT NULL GROUP BY 1 ORDER BY 1 DESC LIMIT 20`],
    ['I5 reg-form first-touch -> submitted', MS + `,
      reg AS (SELECT invoice_id, min(edited_at) AS t_reg
              FROM invoice_audit_log WHERE entity_type IN ('seda_registration','seda_upload')
              GROUP BY 1)
        SELECT count(*) AS n,
          round(avg(extract(epoch FROM (ms.t_submitted - reg.t_reg))/86400.0),2) AS avg_days,
          round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (ms.t_submitted - reg.t_reg))/86400.0))::numeric,2) AS median_days
        FROM ms JOIN reg USING (invoice_id) WHERE ms.t_submitted IS NOT NULL`],
];
(async () => {
    for (const [t, sql] of Q) {
        console.log('\n=== ' + t + ' ===');
        try { const r = await pool.query(sql); console.log(JSON.stringify(r.rows, null, 1)); }
        catch (e) { console.log('ERROR: ' + e.message); }
    }
    await pool.end();
})();
