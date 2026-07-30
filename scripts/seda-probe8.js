'use strict';
const { pool } = require('../src/db');
(async () => {
  const q = async (t, sql) => { console.log('\n=== '+t+' ==='); try { const r = await pool.query(sql); console.log(JSON.stringify(r.rows,null,1)); } catch(e){ console.log('ERROR: '+e.message); } };
  await q('M1 join invoice.linked_seda_registration -> seda_registration.bubble_id', `
    SELECT count(*) AS invoices_with_link,
           count(s.id) AS resolved,
           count(s.seda_status) AS with_status
    FROM invoice i LEFT JOIN seda_registration s ON s.bubble_id = i.linked_seda_registration
    WHERE i.linked_seda_registration IS NOT NULL`);
  await q('M2 audit invoices resolving to a status', `
    SELECT count(DISTINCT a.invoice_id) AS audit_invoices,
           count(DISTINCT a.invoice_id) FILTER (WHERE s.seda_status IS NOT NULL) AS with_seda_status
    FROM invoice_audit_log a
    JOIN invoice i ON i.id = a.invoice_id
    LEFT JOIN seda_registration s ON s.bubble_id = i.linked_seda_registration
    WHERE a.entity_type IN ('seda','seda_registration','seda_upload')`);
  await pool.end();
})();
