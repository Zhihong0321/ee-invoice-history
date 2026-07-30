'use strict';
/* Quick probe: check invoice.linked_customer and customer.customer_id types */
const { pool } = require('../src/db');

(async () => {
    const queries = [
        ['invoice.linked_customer type', `
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_name = 'invoice' AND column_name = 'linked_customer'`],
        ['customer.customer_id type', `
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_name = 'customer' AND column_name = 'customer_id'`],
        ['Sample invoice.linked_customer values', `
            SELECT DISTINCT linked_customer
            FROM invoice
            WHERE linked_customer IS NOT NULL
            LIMIT 5`],
        ['Sample customer.customer_id values', `
            SELECT DISTINCT customer_id
            FROM customer
            LIMIT 5`]
    ];

    for (const [title, sql] of queries) {
        console.log('\n=== ' + title + ' ===');
        try {
            const r = await pool.query(sql);
            console.log(JSON.stringify(r.rows, null, 1));
        } catch (e) {
            console.log('ERROR: ' + e.message);
        }
    }
    await pool.end();
})();
