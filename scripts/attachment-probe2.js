'use strict';
// Probe 2: the literal `activity_log` table + `ee_attachment` table.
const { pool } = require('../src/db');

async function q(label, sql, params = []) {
    try {
        const r = await pool.query(sql, params);
        console.log(`\n=== ${label} (${r.rows.length}) ===`);
        console.log(JSON.stringify(r.rows, null, 1).slice(0, 6000));
    } catch (e) {
        console.log(`\n=== ${label} ERROR: ${e.message} ===`);
    }
}

(async () => {
    await q('activity_log columns',
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema='public' AND table_name='activity_log' ORDER BY ordinal_position`);

    await q('ee_attachment columns',
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema='public' AND table_name='ee_attachment' ORDER BY ordinal_position`);

    await q('activity_log row count / range',
        `SELECT count(*) n FROM activity_log`);

    await q('ee_attachment row count',
        `SELECT count(*) n FROM ee_attachment`);

    await pool.end();
})();
