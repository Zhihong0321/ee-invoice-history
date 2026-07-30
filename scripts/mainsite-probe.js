'use strict';
/* One-off probe: how main-site activity_log rows identify bot/crawler vs human visitors. */
const { pool } = require('../src/db');

const Q = [
    ['A1 distinct actor_kind for app=main-site', `
        SELECT coalesce(actor_kind,'(null)') AS actor_kind, count(*) AS n
        FROM activity_log
        WHERE app = 'main-site'
        GROUP BY 1 ORDER BY n DESC`],
    ['A2 distinct actor_name per actor_kind (top 40)', `
        SELECT coalesce(actor_kind,'(null)') AS actor_kind, coalesce(actor_name,'(null)') AS actor_name, count(*) AS n
        FROM activity_log
        WHERE app = 'main-site'
        GROUP BY 1,2 ORDER BY n DESC LIMIT 40`],
    ['A3 distinct action values', `
        SELECT coalesce(action,'(null)') AS action, count(*) AS n
        FROM activity_log
        WHERE app = 'main-site'
        GROUP BY 1 ORDER BY n DESC LIMIT 20`],
    ['A4 sample rows with fields/metadata-ish columns', `
        SELECT id, actor_kind, actor_name, actor_role, action, entity_type, entity_label, description, fields, status, occurred_at
        FROM activity_log
        WHERE app = 'main-site'
        ORDER BY occurred_at DESC LIMIT 15`]
];

(async () => {
    const client = await pool.connect();
    try {
        for (const [label, sql] of Q) {
            console.log('\n=== ' + label + ' ===');
            try {
                const { rows } = await client.query(sql);
                console.log(JSON.stringify(rows, null, 2));
            } catch (e) {
                console.log('ERROR:', e.message);
            }
        }
    } finally {
        client.release();
        await pool.end();
    }
})();
