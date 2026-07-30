'use strict';
/* One-off probe: what the ADMIN OS writes into the shared `activity_log`. */
const { pool } = require('../src/db');

const Q = [
    ['B0 columns', `
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = 'activity_log'
        ORDER BY ordinal_position`],
    ['B1 apps', `
        SELECT app, coalesce(app_env,'-') AS env, count(*) AS n,
               min(occurred_at) AS first_seen, max(occurred_at) AS last_seen
        FROM activity_log
        GROUP BY 1,2 ORDER BY n DESC`],
    ['B2 app x entity x action matrix', `
        SELECT app, coalesce(entity_type,'(null)') AS entity_type, action, count(*) AS n,
               min(occurred_at)::date AS first_seen, max(occurred_at)::date AS last_seen
        FROM activity_log
        GROUP BY 1,2,3 ORDER BY app, n DESC`],
    ['B3 actor shape', `
        SELECT app, coalesce(actor_kind,'(null)') AS actor_kind,
               count(*) AS n,
               count(actor_user_id) AS with_user_id,
               count(actor_name) AS with_name,
               count(actor_role) AS with_role,
               count(actor_ref) AS with_ref
        FROM activity_log
        GROUP BY 1,2 ORDER BY n DESC`],
    ['B4 status / errors', `
        SELECT app, coalesce(status,'(null)') AS status, count(*) AS n
        FROM activity_log
        GROUP BY 1,2 ORDER BY n DESC`],
    ['B5 fields jsonb keys used', `
        SELECT app, coalesce(entity_type,'-') AS entity_type, k, count(*) AS n
        FROM activity_log a, LATERAL jsonb_object_keys(
             CASE WHEN jsonb_typeof(a.fields)='object' THEN a.fields ELSE '{}'::jsonb END) k
        GROUP BY 1,2,3 ORDER BY 1,2,4 DESC LIMIT 80`],
];

(async () => {
    for (const [title, sql] of Q) {
        console.log('\n\n=============== ' + title + ' ===============');
        try {
            const r = await pool.query(sql);
            console.log(JSON.stringify(r.rows, null, 1));
        } catch (e) {
            console.log('ERROR: ' + e.message);
        }
    }
    await pool.end();
})();
