'use strict';
const { pool } = require('../src/db');

async function q(label, sql, params = []) {
    try {
        const r = await pool.query(sql, params);
        console.log(`\n=== ${label} (${r.rows.length}) ===`);
        console.log(JSON.stringify(r.rows, null, 1).slice(0, 7000));
    } catch (e) {
        console.log(`\n=== ${label} ERROR: ${e.message} ===`);
    }
}

(async () => {
    await q('product labels', `SELECT label, count(*) n FROM product GROUP BY 1 ORDER BY n DESC`);
    await q('products (panel/inverter-ish)',
        `SELECT id, bubble_id, name, label, solar_output_rating, inverter_rating, active
         FROM product WHERE label ILIKE '%panel%' OR label ILIKE '%inverter%' OR name ILIKE '%jinko%'
         ORDER BY label, name`);

    await q('package.panel distinct', `SELECT panel, count(*) n FROM package GROUP BY 1 ORDER BY n DESC LIMIT 30`);
    await q('package.inverter_1 distinct', `SELECT inverter_1, count(*) n FROM package GROUP BY 1 ORDER BY n DESC LIMIT 30`);
    await q('package.type distinct', `SELECT type, count(*) n FROM package GROUP BY 1 ORDER BY n DESC LIMIT 30`);

    await q('seda_status distinct', `SELECT seda_status, count(*) n FROM seda_registration GROUP BY 1 ORDER BY n DESC`);

    await q('invoice jul 2026 count',
        `SELECT count(*) n, count(*) FILTER (WHERE total_amount > 0) with_total
         FROM invoice WHERE invoice_date >= '2026-07-01' AND invoice_date < '2026-08-01'`);

    await q('payments by invoice month jul',
        `SELECT count(DISTINCT p.linked_invoice) invoices, count(*) payments, sum(p.amount) total
         FROM payment p JOIN invoice i ON i.bubble_id = p.linked_invoice
         WHERE i.invoice_date >= '2026-07-01' AND i.invoice_date < '2026-08-01'`);

    await q('sample jul invoice with pkg + seda + paid',
        `SELECT i.id, i.invoice_number, i.bubble_id, i.invoice_date, i.total_amount, i.amount,
                i.panel_qty, i.linked_package, pk.package_name, pk.panel, pk.panel_qty pkg_panel_qty,
                pk.inverter_1, pk.inverter_2, pk.inverter_3, pk.inverter_4, pk.type pkg_type,
                sr.seda_status, sr.bubble_id seda_id,
                (SELECT sum(p.amount) FROM payment p WHERE p.linked_invoice = i.bubble_id) paid
         FROM invoice i
         LEFT JOIN package pk ON pk.bubble_id = i.linked_package
         LEFT JOIN seda_registration sr ON sr.bubble_id = i.linked_seda_registration
         WHERE i.invoice_date >= '2026-07-01' AND i.invoice_date < '2026-08-01'
         ORDER BY i.invoice_date DESC LIMIT 12`);

    await pool.end();
})();
