'use strict';
const { pool } = require('../src/db');
(async () => {
  const q = async (t, sql) => { console.log('\n=== '+t+' ==='); try { const r = await pool.query(sql); console.log(JSON.stringify(r.rows,null,1)); } catch(e){ console.log('ERROR: '+e.message); } };
  const tables = (await pool.query(`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema='public' AND column_name='bubble_id'`)).rows.map(r=>r.table_name);
  const ids = ['1692255863479x555358685401972740','1741540531671x608460181016150000','1771039183637x205243619540992000','1724333977749x259189494577102850'];
  for (const t of tables) {
    try {
      const r = await pool.query(`SELECT count(*) n FROM "${t}" WHERE bubble_id = ANY($1)`, [ids]);
      if (Number(r.rows[0].n) > 0) console.log('HIT table: '+t+' n='+r.rows[0].n);
    } catch(e) {}
  }
  await pool.end();
})();
