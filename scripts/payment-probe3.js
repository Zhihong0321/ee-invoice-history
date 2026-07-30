'use strict';
/* Probe 3: raw payment rows (correct columns), entity_id pairing, actor coverage. */
const { pool } = require('../src/db');

const Q = [
    ['C1 raw: submitted_payment insert (6)', `
        SELECT id, entity_id, invoice_id, invoice_number, actor_user_id, actor_name, actor_role,
               actor_phone, source_app, edited_at, changes::text AS changes
        FROM invoice_audit_log
        WHERE entity_type='submitted_payment' AND action_type='insert'
        ORDER BY edited_at DESC LIMIT 6`],
    ['C2 raw: payment verify (6)', `
        SELECT id, entity_id, invoice_id, invoice_number, actor_user_id, actor_name, actor_role,
               actor_phone, source_app, edited_at, changes::text AS changes
        FROM invoice_audit_log
        WHERE entity_type='payment' AND action_type='verify'
        ORDER BY edited_at DESC LIMIT 6`],
    ['C3 raw: payment update (6)', `
        SELECT id, entity_id, invoice_number, actor_user_id, actor_name, source_app,
               edited_at, changes::text AS changes
        FROM invoice_audit_log
        WHERE entity_type='payment' AND action_type='update'
        ORDER BY edited_at DESC LIMIT 6`],
    ['C4 raw: deletes (6)', `
        SELECT id, entity_type, entity_id, invoice_number, actor_user_id, actor_name, source_app,
               edited_at, changes::text AS changes, row_old::text AS row_old
        FROM invoice_audit_log
        WHERE entity_type IN ('payment','submitted_payment') AND action_type='delete'
        ORDER BY edited_at DESC LIMIT 6`],
    ['C5 raw: receipt_sent_manual (2)', `
        SELECT id, entity_id, invoice_number, actor_user_id, actor_name, source_app,
               edited_at, changes::text AS changes
        FROM invoice_audit_log
        WHERE entity_type='payment' AND action_type='receipt_sent_manual'
        ORDER BY edited_at DESC LIMIT 2`],
    ['C6 raw: verified_payment legacy (4)', `
        SELECT id, entity_id, invoice_number, actor_user_id, actor_name, source_app,
               edited_at, changes::text AS changes
        FROM invoice_audit_log
        WHERE entity_type='verified_payment'
        ORDER BY edited_at DESC LIMIT 4`],
    ['C7 actor coverage per entity/action', `
        SELECT entity_type, action_type, count(*) AS n,
               count(actor_user_id) AS has_user_id,
               count(actor_name) AS has_name,
               count(actor_phone) AS has_phone,
               count(entity_id) AS has_entity_id
        FROM invoice_audit_log
        WHERE entity_type IN ('payment','submitted_payment','verified_payment')
        GROUP BY 1,2 ORDER BY n DESC`],
    ['C8 pairing: submitted -> verify latency BY entity_id', `
        WITH s AS (
            SELECT entity_id, min(edited_at) AS t_sub
            FROM invoice_audit_log
            WHERE entity_type='submitted_payment' AND action_type='insert' AND entity_id IS NOT NULL
            GROUP BY 1),
        v AS (
            SELECT entity_id, min(edited_at) AS t_ver
            FROM invoice_audit_log
            WHERE entity_type='payment' AND action_type='verify' AND entity_id IS NOT NULL
            GROUP BY 1)
        SELECT count(*) AS n,
               round(avg(extract(epoch FROM (v.t_ver - s.t_sub))/3600.0)::numeric,1) AS avg_hours,
               round((percentile_cont(0.5) WITHIN GROUP (
                   ORDER BY extract(epoch FROM (v.t_ver - s.t_sub))/3600.0))::numeric,1) AS median_hours,
               round((percentile_cont(0.9) WITHIN GROUP (
                   ORDER BY extract(epoch FROM (v.t_ver - s.t_sub))/3600.0))::numeric,1) AS p90_hours,
               min(extract(epoch FROM (v.t_ver - s.t_sub))/3600.0)::numeric(10,2) AS min_hours
        FROM s JOIN v USING (entity_id)
        WHERE v.t_ver >= s.t_sub`],
    ['C9 pending backlog: submitted with no verify yet', `
        WITH s AS (
            SELECT entity_id, invoice_id, invoice_number, min(edited_at) AS t_sub
            FROM invoice_audit_log
            WHERE entity_type='submitted_payment' AND action_type='insert' AND entity_id IS NOT NULL
            GROUP BY 1,2,3),
        v AS (SELECT DISTINCT entity_id FROM invoice_audit_log
              WHERE entity_type='payment' AND action_type IN ('verify','delete')),
        d AS (SELECT DISTINCT entity_id FROM invoice_audit_log
              WHERE entity_type='submitted_payment' AND action_type='delete')
        SELECT count(*) AS still_pending,
               min(t_sub)::date AS oldest,
               max(t_sub)::date AS newest,
               count(*) FILTER (WHERE t_sub > now() - interval '7 days') AS last_7d
        FROM s WHERE entity_id NOT IN (SELECT entity_id FROM v)
                 AND entity_id NOT IN (SELECT entity_id FROM d)`],
    ['C10 payment table columns', `
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name='payment' ORDER BY ordinal_position`],
    ['C11 submitted_payment table columns', `
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name='submitted_payment' ORDER BY ordinal_position`],
    ['C12 who verifies: distinct actors on verify+update rows', `
        SELECT action_type, coalesce(actor_name,'(null)') AS actor,
               coalesce(actor_user_id,'(null)') AS uid, coalesce(source_app,'-') AS app, count(*) AS n
        FROM invoice_audit_log
        WHERE entity_type='payment'
        GROUP BY 1,2,3,4 ORDER BY n DESC LIMIT 15`],
    ['C13 daily payment volume last 14 days', `
        SELECT edited_at::date AS d,
               count(*) FILTER (WHERE entity_type='submitted_payment' AND action_type='insert') AS submitted,
               count(*) FILTER (WHERE entity_type='payment' AND action_type='verify') AS verified,
               count(*) FILTER (WHERE entity_type='payment' AND action_type='update') AS edited,
               count(*) FILTER (WHERE action_type='delete') AS deleted
        FROM invoice_audit_log
        WHERE entity_type IN ('payment','submitted_payment')
          AND edited_at > now() - interval '14 days'
        GROUP BY 1 ORDER BY 1 DESC`],
    ['C14 amount mismatch: submitted vs verified per entity_id', `
        WITH s AS (
            SELECT a.entity_id, (c->>'after')::numeric AS sub_amt
            FROM invoice_audit_log a, LATERAL jsonb_array_elements(a.changes) c
            WHERE a.entity_type='submitted_payment' AND a.action_type='insert'
              AND lower(c->>'field')='amount' AND a.entity_id IS NOT NULL),
        v AS (
            SELECT a.entity_id, (c->>'after')::numeric AS ver_amt
            FROM invoice_audit_log a, LATERAL jsonb_array_elements(a.changes) c
            WHERE a.entity_type='payment' AND a.action_type='verify'
              AND lower(c->>'field')='amount' AND a.entity_id IS NOT NULL)
        SELECT count(*) AS pairs,
               count(*) FILTER (WHERE round(s.sub_amt,2) <> round(v.ver_amt,2)) AS mismatched
        FROM s JOIN v USING (entity_id)`],
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
