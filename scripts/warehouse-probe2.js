'use strict';
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

const cols = (t) => `SELECT string_agg(column_name || ':' || data_type, ', ' ORDER BY ordinal_position) c
                     FROM information_schema.columns WHERE table_schema='public' AND table_name='${t}'`;

(async () => {
    for (const t of ['package', 'package_item', 'product', 'seda_registration', 'payment', 'submitted_payment']) {
        await q(`${t} columns`, cols(t));
    }

    await q('package sample', `SELECT * FROM package ORDER BY created_at DESC NULLS LAST LIMIT 3`);
    await q('package_item sample', `SELECT * FROM package_item LIMIT 5`);
    await q('product sample', `SELECT * FROM product LIMIT 5`);
    await q('product count', `SELECT count(*) n FROM product`);
    await q('package count', `SELECT count(*) n FROM package`);
    await q('package_item count', `SELECT count(*) n FROM package_item`);

    await pool.end();
})();
