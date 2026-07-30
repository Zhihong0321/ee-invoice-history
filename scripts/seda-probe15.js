'use strict';
const { pool } = require('../src/db');
(async () => {
  const q = async (t, sql, p) => { console.log('\n=== '+t+' ==='); try { const r = await pool.query(sql, p); console.log(JSON.stringify(r.rows,null,1)); } catch(e){ console.log('ERROR: '+e.message); } };
  await q('T1 product columns', `SELECT column_name, data_type FROM information_schema.columns WHERE table_name='product' ORDER BY ordinal_position`);
  await q('T2 the 4 panel products', `SELECT * FROM product WHERE bubble_id = ANY($1)`,
    [['1692255863479x555358685401972740','1741540531671x608460181016150000','1771039183637x205243619540992000','1724333977749x259189494577102850']]);
  await pool.end();
})();
