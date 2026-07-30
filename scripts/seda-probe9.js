'use strict';
const { pool } = require('../src/db');
(async () => {
  const q = async (t, sql) => { console.log('\n=== '+t+' ==='); try { const r = await pool.query(sql); console.log(JSON.stringify(r.rows,null,1)); } catch(e){ console.log('ERROR: '+e.message); } };
  await q('N1 kwp-ish columns anywhere', `
    SELECT table_name, column_name, data_type FROM information_schema.columns
    WHERE column_name ILIKE '%kwp%' OR column_name ILIKE '%kw_%' OR column_name ILIKE '%system_size%'
       OR column_name ILIKE '%capacity%' OR column_name = 'kw'
    ORDER BY table_name, column_name`);
  await q('N2 city columns anywhere', `
    SELECT table_name, column_name FROM information_schema.columns
    WHERE column_name ILIKE '%city%' OR column_name ILIKE '%install%address%' OR column_name ILIKE '%postcode%'
    ORDER BY table_name, column_name`);
  await q('N3 payment tables', `
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_name ILIKE '%payment%'`);
  await q('N4 invoice amount / total columns', `
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_name='invoice' AND (column_name ILIKE '%amount%' OR column_name ILIKE '%total%' OR column_name ILIKE '%paid%' OR column_name ILIKE '%price%')
    ORDER BY ordinal_position`);
  await pool.end();
})();
