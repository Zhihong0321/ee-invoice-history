'use strict';
const { pool } = require('../src/db');

async function q(label, sql, params = []) {
    try {
        const r = await pool.query(sql, params);
        console.log(`\n=== ${label} (${r.rows.length}) ===`);
        console.log(JSON.stringify(r.rows, null, 1).slice(0, 9000));
    } catch (e) {
        console.log(`\n=== ${label} ERROR: ${e.message} ===`);
    }
}

(async () => {
    await q('ALL products', `SELECT bubble_id, name, label, solar_output_rating, inverter_rating, active FROM product ORDER BY label NULLS LAST, name`);

    await q('package_item for a sample recent package',
        `SELECT pi.bubble_id, pi.qty, pi.inventory, pr.name, pr.label
         FROM package pk
         CROSS JOIN LATERAL unnest(pk.linked_package_item) AS li(bid)
         JOIN package_item pi ON pi.bubble_id = li.bid
         LEFT JOIN product pr ON pr.bubble_id = pi.product
         WHERE pk.bubble_id = '1777969947000xPKG903'
         ORDER BY pi.sort`);

    await q('Jul invoices: payment table vs submitted_payment',
        `SELECT
           (SELECT count(DISTINCT p.linked_invoice) FROM payment p JOIN invoice i ON i.bubble_id=p.linked_invoice
             WHERE i.invoice_date >= '2026-07-01' AND i.invoice_date < '2026-08-01') pay_invoices,
           (SELECT count(DISTINCT s.linked_invoice) FROM submitted_payment s JOIN invoice i ON i.bubble_id=s.linked_invoice
             WHERE i.invoice_date >= '2026-07-01' AND i.invoice_date < '2026-08-01') sub_invoices,
           (SELECT count(DISTINCT s.linked_invoice) FROM submitted_payment s JOIN invoice i ON i.bubble_id=s.linked_invoice
             WHERE i.invoice_date >= '2026-07-01' AND i.invoice_date < '2026-08-01' AND s.status='verified') sub_verified_invoices`);

    await q('submitted_payment status distinct', `SELECT status, count(*) n FROM submitted_payment GROUP BY 1 ORDER BY n DESC`);

    await q('payments made IN july (by payment_date) regardless of invoice month',
        `SELECT count(DISTINCT linked_invoice) invoices, count(*) n, sum(amount) total
         FROM payment WHERE payment_date >= '2026-07-01' AND payment_date < '2026-08-01'`);

    await q('Jul invoice x seda_status breakdown',
        `SELECT COALESCE(sr.seda_status,'(null)') st, count(*) n
         FROM invoice i LEFT JOIN seda_registration sr ON sr.bubble_id = i.linked_seda_registration
         WHERE i.invoice_date >= '2026-07-01' AND i.invoice_date < '2026-08-01'
         GROUP BY 1 ORDER BY n DESC`);

    await q('Jul invoices WITH payment: pct buckets',
        `WITH j AS (
           SELECT i.bubble_id, i.total_amount,
                  (SELECT COALESCE(sum(p.amount),0) FROM payment p WHERE p.linked_invoice = i.bubble_id) paid
           FROM invoice i
           WHERE i.invoice_date >= '2026-07-01' AND i.invoice_date < '2026-08-01'
         )
         SELECT count(*) FILTER (WHERE paid > 0) with_payment,
                count(*) FILTER (WHERE paid > 0 AND total_amount > 0 AND paid/total_amount < 0.59) lt59,
                count(*) FILTER (WHERE paid > 0 AND total_amount > 0 AND paid/total_amount >= 0.59) gte59
         FROM j`);

    await pool.end();
})();
