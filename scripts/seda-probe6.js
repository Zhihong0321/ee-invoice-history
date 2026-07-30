'use strict';
const { pool } = require('../src/db');

const Q = [
    ['K1 seda_registration link columns', `
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name='seda_registration'
          AND (column_name ILIKE '%invoice%' OR column_name ILIKE '%customer%'
               OR column_name ILIKE '%link%' OR column_name ILIKE '%agent%')
        ORDER BY ordinal_position`],
    ['K2 invoice link columns to seda', `
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name='invoice' AND (column_name ILIKE '%seda%' OR column_name ILIKE '%registration%')
        ORDER BY ordinal_position`],
    ['K3 coverage: invoices in seda audit that resolve to a seda_registration row', `
        SELECT count(DISTINCT a.invoice_id) AS audit_invoices
        FROM invoice_audit_log a
        WHERE a.entity_type IN ('seda','seda_registration','seda_upload')`],
    ['K4 form-touch window per invoice vs submission', `
        WITH ev AS (
          SELECT a.invoice_id, a.edited_at, c->>'after' AS af
          FROM invoice_audit_log a, LATERAL jsonb_array_elements(a.changes) c
          WHERE a.entity_type='seda' AND lower(c->>'field')='seda_status'
        ),
        sub AS (SELECT invoice_id, min(edited_at) AS t_sub FROM ev WHERE af='Submitted' GROUP BY 1),
        frm AS (
          SELECT invoice_id, min(edited_at) AS t_first, max(edited_at) AS t_last, count(*) AS n_edits
          FROM invoice_audit_log
          WHERE entity_type IN ('seda_registration','seda_upload') GROUP BY 1
        )
        SELECT count(*) AS invoices_with_form_and_sub,
               count(*) FILTER (WHERE frm.t_last <= sub.t_sub) AS form_last_before_sub,
               round(avg(extract(epoch FROM (sub.t_sub - frm.t_last))/86400.0)::numeric,2) AS avg_days_lastedit_to_sub,
               round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (sub.t_sub - frm.t_last))/86400.0))::numeric,2) AS median_days
        FROM sub JOIN frm USING (invoice_id)`],
    ['K5 how many seda_registration audit rows per invoice (fill pattern)', `
        SELECT n_rows, count(*) AS invoices FROM (
          SELECT invoice_id, count(*) AS n_rows FROM invoice_audit_log
          WHERE entity_type='seda_registration' GROUP BY 1
        ) t GROUP BY 1 ORDER BY 1`],
    ['K6 top fields written on seda_registration updates', `
        SELECT c->>'field' AS field, count(*) AS n
        FROM invoice_audit_log a, LATERAL jsonb_array_elements(a.changes) c
        WHERE a.entity_type='seda_registration' AND a.action_type <> 'insert'
        GROUP BY 1 ORDER BY n DESC LIMIT 40`],
    ['K7 invoice 1st payment cols', `
        SELECT column_name FROM information_schema.columns
        WHERE table_name='invoice' AND column_name ILIKE '%payment%' ORDER BY ordinal_position`],
];

(async () => {
    for (const [t, sql] of Q) {
        console.log('\n=============== ' + t + ' ===============');
        try { const r = await pool.query(sql); console.log(JSON.stringify(r.rows, null, 1)); }
        catch (e) { console.log('ERROR: ' + e.message); }
    }
    await pool.end();
})();
