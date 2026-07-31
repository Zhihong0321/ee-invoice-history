'use strict';
const { pool } = require('../src/db');
(async () => {
  const r = await pool.query(`
    SELECT count(*) invoices, min(i.invoice_date) first, max(i.invoice_date) last
    FROM invoice i JOIN (SELECT linked_invoice, sum(amount) paid FROM payment GROUP BY 1) p
      ON p.linked_invoice = i.bubble_id`);
  console.log('ALL invoices with payment:', JSON.stringify(r.rows));
  const r2 = await pool.query(`
    SELECT to_char(date_trunc('year', i.invoice_date),'YYYY') y, count(*) n
    FROM invoice i JOIN (SELECT linked_invoice FROM payment GROUP BY 1) p
      ON p.linked_invoice = i.bubble_id GROUP BY 1 ORDER BY 1`);
  console.log('by year:', JSON.stringify(r2.rows));
  const r3 = await pool.query(`
    SELECT COALESCE(sr.seda_status,'(null)') st, count(*) n
    FROM invoice i JOIN (SELECT linked_invoice FROM payment GROUP BY 1) p ON p.linked_invoice = i.bubble_id
    LEFT JOIN seda_registration sr ON sr.bubble_id = i.linked_seda_registration
    GROUP BY 1 ORDER BY n DESC`);
  console.log('seda:', JSON.stringify(r3.rows));
  process.exit(0);
})();
