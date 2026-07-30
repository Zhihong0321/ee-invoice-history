'use strict';
/* One-off probe: everything SEDA-related in invoice_audit_log + activity_log. */
const { pool } = require('../src/db');

const Q = [
    ['A1 audit: entity/action matrix', `
        SELECT entity_type, action_type, count(*) AS n,
               min(edited_at)::date AS first_seen, max(edited_at)::date AS last_seen,
               count(DISTINCT invoice_id) AS invoices,
               count(DISTINCT actor_name) AS actors
        FROM invoice_audit_log
        WHERE entity_type ILIKE '%seda%'
        GROUP BY 1,2 ORDER BY n DESC`],
    ['A2 audit: change fields used per entity', `
        SELECT entity_type, action_type, c->>'field' AS field, count(*) AS n
        FROM invoice_audit_log a, LATERAL jsonb_array_elements(a.changes) c
        WHERE a.entity_type ILIKE '%seda%' AND jsonb_typeof(a.changes)='array'
        GROUP BY 1,2,3 ORDER BY 1,2,4 DESC`],
    ['A3 audit: seda_status transitions', `
        SELECT c->>'before' AS before, c->>'after' AS after, count(*) AS n
        FROM invoice_audit_log a, LATERAL jsonb_array_elements(a.changes) c
        WHERE a.entity_type='seda' AND lower(c->>'field')='seda_status'
        GROUP BY 1,2 ORDER BY n DESC LIMIT 40`],
    ['A4 audit: actors', `
        SELECT entity_type, coalesce(actor_name,'(null)') AS actor, coalesce(actor_role,'-') AS role,
               coalesce(source_app,'-') AS app, count(*) AS n
        FROM invoice_audit_log
        WHERE entity_type ILIKE '%seda%'
        GROUP BY 1,2,3,4 ORDER BY n DESC LIMIT 30`],
    ['A5 audit: recent 25 raw rows', `
        SELECT id, entity_type, action_type, invoice_id, invoice_number, actor_name, actor_role,
               source_app, edited_at, changes::text AS changes
        FROM invoice_audit_log
        WHERE entity_type ILIKE '%seda%'
        ORDER BY edited_at DESC LIMIT 25`],
    ['A6 audit: monthly volume', `
        SELECT to_char(date_trunc('month', edited_at),'YYYY-MM') AS mon, entity_type, count(*) AS n
        FROM invoice_audit_log WHERE entity_type ILIKE '%seda%'
        GROUP BY 1,2 ORDER BY 1 DESC,3 DESC LIMIT 40`],
    ['B1 activity_log: seda-ish rows', `
        SELECT app, entity_type, action, count(*) AS n,
               min(occurred_at)::date AS first_seen, max(occurred_at)::date AS last_seen
        FROM activity_log
        WHERE entity_type ILIKE '%seda%' OR action ILIKE '%seda%' OR description ILIKE '%seda%'
           OR entity_label ILIKE '%seda%'
        GROUP BY 1,2,3 ORDER BY n DESC LIMIT 40`],
    ['B2 activity_log: recent seda samples', `
        SELECT id, app, entity_type, entity_id, entity_label, action, description,
               actor_name, actor_role, occurred_at, metadata::text AS metadata
        FROM activity_log
        WHERE entity_type ILIKE '%seda%' OR action ILIKE '%seda%' OR description ILIKE '%seda%'
           OR entity_label ILIKE '%seda%'
        ORDER BY occurred_at DESC LIMIT 25`],
    ['C1 seda_registration table columns', `
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name='seda_registration' ORDER BY ordinal_position`],
    ['C2 seda_registration status spread', `
        SELECT trim(coalesce(seda_status,'(null)')) AS seda_status, count(*) AS n
        FROM seda_registration GROUP BY 1 ORDER BY n DESC LIMIT 30`],
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
