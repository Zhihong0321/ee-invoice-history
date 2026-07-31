'use strict';
// Probe 5: activity_log entity_type='attachment' detail.
const { pool } = require('../src/db');

async function q(label, sql, params = []) {
    try {
        const r = await pool.query(sql, params);
        console.log(`\n=== ${label} (${r.rows.length}) ===`);
        console.log(JSON.stringify(r.rows, null, 1).slice(0, 12000));
    } catch (e) {
        console.log(`\n=== ${label} ERROR: ${e.message} ===`);
    }
}

(async () => {
    await q('attachment rows',
        `SELECT id, app, actor_name, actor_role, action, entity_id, entity_label,
                description, fields, metadata, source_url, occurred_at
         FROM activity_log WHERE entity_type='attachment'
         ORDER BY occurred_at DESC LIMIT 25`);

    await pool.end();
})();
