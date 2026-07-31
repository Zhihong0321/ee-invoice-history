'use strict';
// Probe: what tables/columns describe invoice packages, panels, inverters,
// SEDA status and payment totals — for the WAREHOUSE tab.
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
    await q('all tables', `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1`);

    await q('invoice columns',
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema='public' AND table_name='invoice' ORDER BY ordinal_position`);

    await q('invoice_item columns',
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema='public' AND table_name='invoice_item' ORDER BY ordinal_position`);

    await q('tables matching package/product/item/panel/inverter/stock',
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema='public'
           AND (table_name ILIKE '%package%' OR table_name ILIKE '%product%'
             OR table_name ILIKE '%panel%' OR table_name ILIKE '%inverter%'
             OR table_name ILIKE '%stock%' OR table_name ILIKE '%item%'
             OR table_name ILIKE '%seda%' OR table_name ILIKE '%payment%')
         ORDER BY 1`);

    await pool.end();
})();
