'use strict';
const { pool } = require('../src/db');
(async () => {
  const q = async (t, sql) => { console.log('\n=== '+t+' ==='); try { const r = await pool.query(sql); console.log(JSON.stringify(r.rows,null,1)); } catch(e){ console.log('ERROR: '+e.message); } };
  await q('R1 package remaining columns', `
    SELECT column_name, data_type FROM information_schema.columns WHERE table_name='package'
      AND ordinal_position > 16 ORDER BY ordinal_position`);
  await q('R2 package_name samples', `
    SELECT package_name, panel_qty, count(*) AS n FROM package GROUP BY 1,2 ORDER BY n DESC LIMIT 15`);
  await q('R3 coverage: seda invoices -> package', `
    SELECT count(*) AS n,
      count(p.id) AS has_package,
      count(p.panel_qty) AS has_panel_qty,
      count(NULLIF(i.package_name_snapshot,'')) AS has_snapshot
    FROM invoice i
    LEFT JOIN package p ON p.bubble_id = i.linked_package
    WHERE i.linked_seda_registration IS NOT NULL`);
  await pool.end();
})();
