'use strict';
/* One-off probe: anything CLAIM-related in the audit/activity logs. */
const { pool } = require('../src/db');

const Q = [
    ['C1 audit: entity/action matrix matching "claim"', `
        SELECT entity_type, action_type, count(*) AS n,
               min(edited_at)::date AS first_seen, max(edited_at)::date AS last_seen,
               count(DISTINCT invoice_id) AS invoices
        FROM invoice_audit_log
        WHERE entity_type ILIKE '%claim%' OR action_type ILIKE '%claim%'
        GROUP BY 1,2 ORDER BY n DESC`],
    ['C2 audit: "claim" anywhere in changes jsonb', `
        SELECT entity_type, action_type, count(*) AS n,
               min(edited_at)::date AS first_seen, max(edited_at)::date AS last_seen
        FROM invoice_audit_log
        WHERE changes::text ILIKE '%claim%'
        GROUP BY 1,2 ORDER BY n DESC LIMIT 40`],
    ['C3 full entity/action inventory (for eyeballing)', `
        SELECT entity_type, action_type, count(*) AS n,
               min(edited_at)::date AS first_seen, max(edited_at)::date AS last_seen
        FROM invoice_audit_log
        GROUP BY 1,2 ORDER BY 1,3 DESC`],
    ['C4 tables in DB whose name mentions claim', `
        SELECT table_schema, table_name FROM information_schema.tables
        WHERE table_name ILIKE '%claim%' ORDER BY 1,2`],
    ['C5 columns anywhere named like claim', `
        SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE column_name ILIKE '%claim%' AND table_schema='public' ORDER BY 1,2`],
    ['C6 sample rows if any claim entity exists', `
        SELECT id, entity_type, action_type, invoice_id, entity_id, actor_name,
               edited_at, changes
        FROM invoice_audit_log
        WHERE entity_type ILIKE '%claim%' OR action_type ILIKE '%claim%'
           OR changes::text ILIKE '%claim%'
        ORDER BY edited_at DESC LIMIT 15`],
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
