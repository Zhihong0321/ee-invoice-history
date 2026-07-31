'use strict';
// Probe: is there anything in the activity/audit logs about ee-attachment,
// roof image, or site image?
const { pool } = require('../src/db');

async function q(label, sql, params = []) {
    try {
        const r = await pool.query(sql, params);
        console.log(`\n=== ${label} (${r.rows.length}) ===`);
        console.log(JSON.stringify(r.rows, null, 1).slice(0, 4000));
    } catch (e) {
        console.log(`\n=== ${label} ERROR: ${e.message} ===`);
    }
}

(async () => {
    await q('tables matching activity/attach/image/photo/upload/drawing',
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema='public'
           AND (table_name ILIKE '%activity%' OR table_name ILIKE '%attach%'
             OR table_name ILIKE '%image%' OR table_name ILIKE '%photo%'
             OR table_name ILIKE '%upload%' OR table_name ILIKE '%drawing%'
             OR table_name ILIKE '%roof%' OR table_name ILIKE '%site%')
         ORDER BY 1`);

    await q('audit log entity/action inventory',
        `SELECT entity_type, action_type, count(*) n, min(edited_at) first, max(edited_at) last
         FROM invoice_audit_log GROUP BY 1,2 ORDER BY 1,2`);

    await q('audit rows whose changes text mentions attachment/roof/site image',
        `SELECT entity_type, action_type, count(*) n, min(edited_at) first, max(edited_at) last
         FROM invoice_audit_log
         WHERE changes::text ILIKE '%attachment%' OR changes::text ILIKE '%roof%'
            OR changes::text ILIKE '%site image%' OR changes::text ILIKE '%site photo%'
            OR changes::text ILIKE '%ee-attachment%' OR changes::text ILIKE '%ee_attachment%'
         GROUP BY 1,2 ORDER BY n DESC`);

    await q('sample changes for those rows',
        `SELECT id, entity_type, action_type, edited_at, left(changes::text, 400) AS changes
         FROM invoice_audit_log
         WHERE changes::text ILIKE '%attachment%' OR changes::text ILIKE '%roof%'
            OR changes::text ILIKE '%site image%' OR changes::text ILIKE '%ee-attachment%'
         ORDER BY edited_at DESC LIMIT 15`);

    await pool.end();
})();
