'use strict';
const { pool } = require('../src/db');
const Q = [
    ['D1 activity_log: full entity/action inventory', `
        SELECT app, entity_type, action, count(*) AS n,
               min(occurred_at)::date AS first_seen, max(occurred_at)::date AS last_seen
        FROM activity_log GROUP BY 1,2,3 ORDER BY n DESC LIMIT 60`],
    ['D2 activity_log: total + range', `
        SELECT count(*) AS n, min(occurred_at) AS first, max(occurred_at) AS last FROM activity_log`],
    ['E1 seda entity: mapper_status transitions', `
        SELECT c->>'before' AS before, c->>'after' AS after, count(*) AS n
        FROM invoice_audit_log a, LATERAL jsonb_array_elements(a.changes) c
        WHERE a.entity_type='seda' AND lower(c->>'field')='mapper_status'
        GROUP BY 1,2 ORDER BY n DESC LIMIT 20`],
    ['E2 seda_registration:insert sample changes', `
        SELECT id, invoice_id, invoice_number, actor_name, source_app, edited_at, changes::text
        FROM invoice_audit_log WHERE entity_type='seda_registration' AND action_type='insert'
        ORDER BY edited_at DESC LIMIT 5`],
    ['E3 seda_registration:updated sample (multi-field)', `
        SELECT id, invoice_id, invoice_number, actor_name, actor_role, source_app, edited_at, changes::text
        FROM invoice_audit_log WHERE entity_type='seda_registration' AND action_type='updated'
          AND jsonb_array_length(changes) > 3
        ORDER BY edited_at DESC LIMIT 4`],
    ['E4 seda:update sample rows', `
        SELECT id, invoice_id, invoice_number, actor_name, actor_role, source_app, edited_at, changes::text
        FROM invoice_audit_log WHERE entity_type='seda' ORDER BY edited_at DESC LIMIT 6`],
    ['E5 upload: re-upload churn (same invoice+field deleted then added)', `
        SELECT invoice_number, c->>'field' AS field, count(*) AS n
        FROM invoice_audit_log a, LATERAL jsonb_array_elements(a.changes) c
        WHERE a.entity_type='seda_upload' AND a.action_type='deleted'
        GROUP BY 1,2 HAVING count(*) > 1 ORDER BY n DESC LIMIT 15`],
    ['E6 how many changes per updated row', `
        SELECT jsonb_array_length(changes) AS fields_changed, count(*) AS n
        FROM invoice_audit_log WHERE entity_type='seda_registration' AND action_type='updated'
        GROUP BY 1 ORDER BY 1`],
    ['E7 doc-completeness: uploads per invoice (net)', `
        SELECT count(*) AS invoices_with_uploads,
               round(avg(docs),1) AS avg_distinct_doc_types,
               max(docs) AS max_doc_types
        FROM (
          SELECT a.invoice_id, count(DISTINCT c->>'field') AS docs
          FROM invoice_audit_log a, LATERAL jsonb_array_elements(a.changes) c
          WHERE a.entity_type='seda_upload' AND a.action_type='added'
          GROUP BY 1) t`],
    ['E8 registration daily volume last 30d', `
        SELECT edited_at::date AS d, entity_type, action_type, count(*) AS n
        FROM invoice_audit_log
        WHERE entity_type ILIKE '%seda%' AND edited_at >= now() - interval '30 days'
        GROUP BY 1,2,3 ORDER BY 1 DESC, 4 DESC LIMIT 60`],
    ['E9 actor null rate per entity', `
        SELECT entity_type, action_type,
               count(*) FILTER (WHERE actor_name IS NULL) AS null_actor,
               count(*) AS total
        FROM invoice_audit_log WHERE entity_type ILIKE '%seda%' GROUP BY 1,2`],
];
(async () => {
    for (const [t, sql] of Q) {
        console.log('\n\n=============== ' + t + ' ===============');
        try { const r = await pool.query(sql); console.log(JSON.stringify(r.rows, null, 1)); }
        catch (e) { console.log('ERROR: ' + e.message); }
    }
    await pool.end();
})();
