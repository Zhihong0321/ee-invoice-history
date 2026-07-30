'use strict';
const { pool } = require('../src/db');
(async () => {
  const q = async (t, sql) => { console.log('\n=== '+t+' ==='); try { const r = await pool.query(sql); console.log(JSON.stringify(r.rows,null,1)); } catch(e){ console.log('ERROR: '+e.message); } };
  await q('Q1 package-ish tables', `
    SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name ILIKE '%package%'`);
  await q('Q2 invoice link to package', `
    SELECT column_name FROM information_schema.columns WHERE table_name='invoice' AND column_name ILIKE '%package%'`);
  await q('Q3 package columns', `
    SELECT column_name, data_type FROM information_schema.columns WHERE table_name='package' ORDER BY ordinal_position`);
  await pool.end();
})();
