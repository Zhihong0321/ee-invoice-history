'use strict';
/* One-off probe: does activity_log contain app='agent-os', entity_type='proposal', actor_kind='visitor'? */
const { pool } = require('../src/db');

const Q = [
    ['P0 agent-os presence', `
        SELECT coalesce(app_env,'(null)') AS app_env, coalesce(entity_type,'(null)') AS entity_type,
               coalesce(actor_kind,'(null)') AS actor_kind, count(*) AS n,
               min(occurred_at) AS first_seen, max(occurred_at) AS last_seen
        FROM activity_log
        WHERE app = 'agent-os'
        GROUP BY 1,2,3 ORDER BY n DESC`],
    ['P1 exact match count', `
        SELECT count(*) AS n, min(occurred_at) AS first_seen, max(occurred_at) AS last_seen
        FROM activity_log
        WHERE app = 'agent-os' AND entity_type = 'proposal' AND actor_kind = 'visitor'`],
    ['P2 sample rows', `
        SELECT id, app_env, action, entity_type, entity_id, entity_label, actor_kind, actor_ref, status, occurred_at
        FROM activity_log
        WHERE app = 'agent-os' AND entity_type = 'proposal' AND actor_kind = 'visitor'
        ORDER BY occurred_at DESC LIMIT 10`],
    ['P3 all apps with entity_type=proposal', `
        SELECT app, coalesce(actor_kind,'(null)') AS actor_kind, count(*) AS n
        FROM activity_log
        WHERE entity_type = 'proposal'
        GROUP BY 1,2 ORDER BY n DESC`],
];

(async () => {
    const client = await pool.connect();
    try {
        for (const [label, sql] of Q) {
            console.log(`\n=== ${label} ===`);
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
