'use strict';
/* One-off probe: everything PAYMENT-related in invoice_audit_log + activity_log. */
const { pool } = require('../src/db');

const Q = [
    ['A1 audit: payment entity/action matrix', `
        SELECT entity_type, action_type, count(*) AS n,
               min(edited_at)::date AS first_seen, max(edited_at)::date AS last_seen,
               count(DISTINCT invoice_id) AS invoices,
               count(DISTINCT actor_name) AS actors
        FROM invoice_audit_log
        WHERE entity_type ILIKE '%payment%' OR action_type ILIKE '%payment%'
           OR entity_type ILIKE '%receipt%' OR action_type ILIKE '%receipt%'
        GROUP BY 1,2 ORDER BY n DESC`],
    ['A2 audit: change fields used per payment entity', `
        SELECT entity_type, action_type, c->>'field' AS field, count(*) AS n
        FROM invoice_audit_log a, LATERAL jsonb_array_elements(a.changes) c
        WHERE (a.entity_type ILIKE '%payment%' OR a.entity_type ILIKE '%receipt%')
          AND jsonb_typeof(a.changes)='array'
        GROUP BY 1,2,3 ORDER BY 1,2,4 DESC`],
    ['A3 audit: actors / source apps', `
        SELECT entity_type, coalesce(actor_name,'(null)') AS actor, coalesce(actor_role,'-') AS role,
               coalesce(source_app,'-') AS app, count(*) AS n
        FROM invoice_audit_log
        WHERE entity_type ILIKE '%payment%' OR entity_type ILIKE '%receipt%'
        GROUP BY 1,2,3,4 ORDER BY n DESC LIMIT 30`],
    ['A4 audit: monthly volume by entity', `
        SELECT to_char(date_trunc('month', edited_at),'YYYY-MM') AS mon, entity_type, action_type, count(*) AS n
        FROM invoice_audit_log
        WHERE entity_type ILIKE '%payment%' OR entity_type ILIKE '%receipt%'
        GROUP BY 1,2,3 ORDER BY 1 DESC,4 DESC LIMIT 45`],
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
