'use strict';
const { pool } = require('../src/db');
(async () => {
  const r = await pool.query(`SELECT bubble_id, name, label, solar_output_rating, inverter_rating FROM product WHERE name ILIKE '%armorvolt%' OR name ILIKE '%ev%charger%'`);
  console.log(JSON.stringify(r.rows, null, 1));
  const r2 = await pool.query(`SELECT bubble_id, name, label, solar_output_rating FROM product WHERE solar_output_rating IS NOT NULL`);
  console.log(JSON.stringify(r2.rows, null, 1));
  process.exit(0);
})();
