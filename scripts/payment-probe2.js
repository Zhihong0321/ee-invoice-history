'use strict';
/* Probe 2: raw payment rows, pairing keys, method spread, amounts. */
const { pool } = require('../src/db');

const PAY = `('verified_payment','submitted_payment','payment')`;

const Q = [
    ['B0 audit table columns', `
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name='invoice_audit_log' ORDER BY ordinal_position`],

    ['B1 raw: submitted_payment insert (8)', `
        SELECT id, entity_id, bubble_id, invoice_id, invoice_number, actor_name, actor_role,
               source_app, edited_at, changes::text AS changes
        FROM invoice_audit_log
        WHERE entity_type='submitted_payment' AND action_type='insert'
        ORDER BY edited_at DESC LIMIT 8`],

    ['B2 raw: payment verify (8)', `
        SELECT id, entity_id, bubble_id, invoice_id, invoice_number, actor_name, actor_role,
               source_app, edited_at, changes::text AS changes
        FROM invoice_audit_log
        WHERE entity_type='payment' AND action_type='verify'
        ORDER BY edited_at DESC LIMIT 8`],

    ['B3 raw: payment update (8)', `
        SELECT id, entity_id, bubble_id, invoice_id, invoice_number, actor_name,
               source_app, edited_at, changes::text AS changes
        FROM invoice_audit_log
        WHERE entity_type='payment' AND action_type='update'
        ORDER BY edited_at DESC LIMIT 8`],

    ['B4 raw: deletes (payment + submitted_payment)', `
        SELECT id, entity_type, action_type, entity_id, bubble_id, invoice_id, invoice_number,
               actor_name, source_app, edited_at, changes::text AS changes
        FROM invoice_audit_log
        WHERE entity_type IN ('payment','submitted_payment') AND action_type='delete'
        ORDER BY edited_at DESC LIMIT 8`],

    ['B5 raw: verified_payment insert (5, legacy)', `
        SELECT id, entity_id, bubble_id, invoice_id, invoice_number, actor_name,
               source_app, edited_at, changes::text AS changes
        FROM invoice_audit_log
        WHERE entity_type='verified_payment'
        ORDER BY edited_at DESC LIMIT 5`],

    ['B6 raw: receipt_sent_manual (2)', `
        SELECT id, entity_id, bubble_id, invoice_id, invoice_number, actor_name,
               source_app, edited_at, changes::text AS changes
        FROM invoice_audit_log
        WHERE entity_type='payment' AND action_type='receipt_sent_manual'
        ORDER BY edited_at DESC LIMIT 2`],

    ['B7 pairing: entity_id/bubble_id populated?', `
        SELECT entity_type, action_type,
               count(*) AS n,
               count(entity_id) AS has_entity_id,
               count(bubble_id) AS has_bubble_id,
               count(invoice_id) AS has_invoice_id,
               count(invoice_number) AS has_inv_no
        FROM invoice_audit_log
        WHERE entity_type IN ${PAY}
        GROUP BY 1,2 ORDER BY n DESC`],

    ['B8 pairing: does a submitted entity_id ever reappear as payment verify?', `
        WITH s AS (SELECT DISTINCT entity_id FROM invoice_audit_log
                   WHERE entity_type='submitted_payment' AND entity_id IS NOT NULL),
             v AS (SELECT DISTINCT entity_id FROM invoice_audit_log
                   WHERE entity_type='payment' AND action_type='verify' AND entity_id IS NOT NULL)
        SELECT (SELECT count(*) FROM s) AS submitted_ids,
               (SELECT count(*) FROM v) AS verify_ids,
               (SELECT count(*) FROM s JOIN v USING (entity_id)) AS shared_ids`],

    ['B9 method spread (all payment entities)', `
        SELECT a.entity_type, a.action_type, lower(c->>'field') AS field,
               coalesce(c->>'after', c->>'before') AS val, count(*) AS n
        FROM invoice_audit_log a, LATERAL jsonb_array_elements(a.changes) c
        WHERE a.entity_type IN ${PAY}
          AND lower(c->>'field') IN ('method','payment_method')
        GROUP BY 1,2,3,4 ORDER BY n DESC LIMIT 35`],

    ['B10 status values seen', `
        SELECT a.entity_type, a.action_type,
               coalesce(c->>'after', c->>'before') AS status, count(*) AS n
        FROM invoice_audit_log a, LATERAL jsonb_array_elements(a.changes) c
        WHERE a.entity_type IN ${PAY} AND lower(c->>'field')='status'
        GROUP BY 1,2,3 ORDER BY n DESC LIMIT 25`],

    ['B11 amount stats (verify vs submitted)', `
        SELECT a.entity_type, a.action_type,
               count(*) AS n,
               round(min(nullif(regexp_replace(coalesce(c->>'after',c->>'before'),'[^0-9.\\-]','','g'),'')::numeric),2) AS min_amt,
               round(avg(nullif(regexp_replace(coalesce(c->>'after',c->>'before'),'[^0-9.\\-]','','g'),'')::numeric),2) AS avg_amt,
               round(max(nullif(regexp_replace(coalesce(c->>'after',c->>'before'),'[^0-9.\\-]','','g'),'')::numeric),2) AS max_amt,
               round(sum(nullif(regexp_replace(coalesce(c->>'after',c->>'before'),'[^0-9.\\-]','','g'),'')::numeric),2) AS sum_amt
        FROM invoice_audit_log a, LATERAL jsonb_array_elements(a.changes) c
        WHERE a.entity_type IN ${PAY} AND lower(c->>'field')='amount'
        GROUP BY 1,2 ORDER BY n DESC`],

    ['B12 EPP fields sample', `
        SELECT id, entity_type, action_type, invoice_number, edited_at, changes::text AS changes
        FROM invoice_audit_log
        WHERE entity_type IN ${PAY}
          AND changes::text ILIKE '%EPP%'
        ORDER BY edited_at DESC LIMIT 6`],

    ['B13 same-invoice payment journey (busiest recent invoice)', `
        WITH top AS (
          SELECT invoice_id FROM invoice_audit_log
          WHERE entity_type IN ${PAY} AND edited_at > now() - interval '30 days'
          GROUP BY 1 ORDER BY count(*) DESC LIMIT 1
        )
        SELECT a.id, a.entity_type, a.action_type, a.invoice_number, a.actor_name,
               a.source_app, a.edited_at, a.changes::text AS changes
        FROM invoice_audit_log a JOIN top ON top.invoice_id = a.invoice_id
        WHERE a.entity_type IN ${PAY}
        ORDER BY a.edited_at ASC LIMIT 20`],

    ['B14 verify latency: submitted -> verified per invoice (recent)', `
        WITH s AS (
          SELECT invoice_id, min(edited_at) AS t_sub FROM invoice_audit_log
          WHERE entity_type='submitted_payment' AND action_type='insert' GROUP BY 1),
        v AS (
          SELECT invoice_id, min(edited_at) AS t_ver FROM invoice_audit_log
          WHERE entity_type='payment' AND action_type='verify' GROUP BY 1)
        SELECT count(*) AS n,
               round(avg(extract(epoch FROM (v.t_ver - s.t_sub))/3600.0)::numeric,1) AS avg_hours,
               round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (v.t_ver - s.t_sub))/3600.0))::numeric,1) AS median_hours
        FROM s JOIN v USING (invoice_id) WHERE v.t_ver > s.t_sub`],

    ['B15 payment table exists? columns', `
        SELECT table_name FROM information_schema.tables
        WHERE table_name ILIKE '%payment%' ORDER BY 1`],
];

(async () => {
    for (const [title, sql] of Q) {
        console.log('\n\n=============== ' + title + ' ===============');
        try {
            const r = await pool.query(sql);
            console.log(JSON.stringify(r.rows, null, 1));
        } catch (e) {
            console.log('ERROR: ' + e.message);
        }
    }
    await pool.end();
})();
