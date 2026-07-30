'use strict';
/* One-off probe: find anything tagged as ee-main across both log tables. */
const { pool } = require('../src/db');

const Q = [
    ['distinct source_app values (invoice_audit_log)', `
        SELECT coalesce(source_app,'(null)') AS source_app, count(*) AS n
        FROM invoice_audit_log GROUP BY 1 ORDER BY n DESC`],
    ['distinct app values (activity_log)', `
        SELECT coalesce(app,'(null)') AS app, count(*) AS n
        FROM activity_log GROUP BY 1 ORDER BY n DESC`],
    ['ee-main rows in invoice_audit_log', `
        SELECT id, entity_type, action_type, actor_name, actor_role, invoice_id, invoice_number, edited_at
        FROM invoice_audit_log
        WHERE source_app ILIKE '%ee-main%' OR source_app ILIKE '%ee_main%'
        ORDER BY edited_at DESC LIMIT 30`],
    ['ee-main rows in activity_log', `
        SELECT id, app, entity_type, action, actor_name, actor_role, occurred_at
        FROM activity_log
        WHERE app ILIKE '%ee-main%' OR app ILIKE '%ee_main%'
        ORDER BY occurred_at DESC LIMIT 30`]
];

(async () => {
    for (const [label, sql] of Q) {
        try {
            const { rows } = await pool.query(sql);
            console.log(`\n=== ${label} (${rows.length} rows) ===`);
            console.log(JSON.stringify(rows, null, 2));
        } catch (e) {
            console.log(`\n=== ${label} ERROR ===`);
            console.log(e.message);
        }
    }
    await pool.end();
})();
