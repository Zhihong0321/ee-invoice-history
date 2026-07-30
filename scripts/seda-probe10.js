'use strict';
const { pool } = require('../src/db');
(async () => {
  const q = async (t, sql) => { console.log('\n=== '+t+' ==='); try { const r = await pool.query(sql); console.log(JSON.stringify(r.rows,null,1)); } catch(e){ console.log('ERROR: '+e.message); } };
  await q('P1 payment columns', `
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_name='payment' ORDER BY ordinal_position`);
  await q('P2 kwp/city coverage on seda invoices', `
    SELECT count(*) AS n,
      count(s.system_size) AS has_system_size,
      count(s.system_size_in_form_kwp) AS has_form_kwp,
      count(NULLIF(s.city,'')) AS has_seda_city,
      count(NULLIF(c.city,'')) AS has_cust_city
    FROM invoice i
    LEFT JOIN seda_registration s ON s.bubble_id = i.linked_seda_registration
    LEFT JOIN customer c ON c.customer_id = i.linked_customer
    WHERE i.linked_seda_registration IS NOT NULL`);
  await q('P3 sample kwp/city', `
    SELECT i.invoice_number, c.name, s.system_size, s.system_size_in_form_kwp, s.city, c.city AS cust_city, s.seda_status
    FROM invoice i
    LEFT JOIN seda_registration s ON s.bubble_id = i.linked_seda_registration
    LEFT JOIN customer c ON c.customer_id = i.linked_customer
    WHERE i.linked_seda_registration IS NOT NULL LIMIT 8`);
  await pool.end();
})();
