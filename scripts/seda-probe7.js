'use strict';
const { pool } = require('../src/db');

// Candidate "required" set for a SEDA registration form, taken from the fields
// actually written by seda_registration updates (probe K6).
const REQ = `ARRAY['Applicant Name','Applicant Phone','IC Number','Applicant Email',
 'Installation Address','City','Postcode','State','TNB Account No','TIN','Phase Type',
 'Emergency Contact Name','Emergency Contact Phone','Emergency Contact Relationship',
 'Emergency Contact MyKad','Emergency Contact Email']`;

const FILLED = `
WITH filled AS (
  SELECT a.invoice_id, c->>'field' AS field, min(a.edited_at) AS t_filled
  FROM invoice_audit_log a, LATERAL jsonb_array_elements(a.changes) c
  WHERE a.entity_type='seda_registration'
    AND c->>'field' = ANY(${REQ})
    AND COALESCE(c->>'after','') <> ''
  GROUP BY 1,2
),
agg AS (
  SELECT invoice_id, count(DISTINCT field) AS n_req, max(t_filled) AS t_complete
  FROM filled GROUP BY 1
),
ev AS (
  SELECT a.invoice_id, a.edited_at, c->>'after' AS af
  FROM invoice_audit_log a, LATERAL jsonb_array_elements(a.changes) c
  WHERE a.entity_type='seda' AND lower(c->>'field')='seda_status'
),
sub AS (SELECT invoice_id, min(edited_at) AS t_sub FROM ev WHERE af='Submitted' GROUP BY 1)
`;

const Q = [
    ['L1 how many required fields each invoice reached', FILLED + `
        SELECT n_req, count(*) AS invoices FROM agg GROUP BY 1 ORDER BY 1 DESC`],
    ['L2 funnel feasibility: pay -> complete(all 16) -> submitted', FILLED + `
        SELECT count(*) AS n,
          round(avg(extract(epoch FROM (agg.t_complete - i."1st_payment_date"))/86400.0)::numeric,2) AS pay_to_complete_avg,
          round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (agg.t_complete - i."1st_payment_date"))/86400.0))::numeric,2) AS pay_to_complete_median,
          round(avg(extract(epoch FROM (sub.t_sub - agg.t_complete))/86400.0)::numeric,2) AS complete_to_sub_avg,
          round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (sub.t_sub - agg.t_complete))/86400.0))::numeric,2) AS complete_to_sub_median
        FROM agg
        JOIN sub USING (invoice_id)
        JOIN invoice i ON i.id = agg.invoice_id
        WHERE agg.n_req >= 14 AND i."1st_payment_date" IS NOT NULL`],
    ['L3 funnel counts (stage populations)', FILLED + `
        SELECT
          (SELECT count(*) FROM invoice WHERE "1st_payment_date" IS NOT NULL) AS paid,
          (SELECT count(*) FROM agg WHERE n_req >= 14) AS form_complete,
          (SELECT count(*) FROM sub) AS submitted`],
    ['L4 ordering sanity: complete before submitted?', FILLED + `
        SELECT count(*) AS n,
               count(*) FILTER (WHERE agg.t_complete <= sub.t_sub) AS complete_before_sub
        FROM agg JOIN sub USING (invoice_id) WHERE agg.n_req >= 14`],
];

(async () => {
    for (const [t, sql] of Q) {
        console.log('\n=============== ' + t + ' ===============');
        try { const r = await pool.query(sql); console.log(JSON.stringify(r.rows, null, 1)); }
        catch (e) { console.log('ERROR: ' + e.message); }
    }
    await pool.end();
})();
