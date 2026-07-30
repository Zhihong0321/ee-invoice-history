'use strict';
/* Probe 2: ee-admin / agent-os row shapes in activity_log — fields[], metadata, descriptions. */
const { pool } = require('../src/db');

const Q = [
    ['C1 fields[] per entity+action', `
        SELECT entity_type, action, f AS field, count(*) AS n
        FROM activity_log a, LATERAL unnest(coalesce(a.fields, '{}'::text[])) f
        WHERE a.app = 'ee-admin'
        GROUP BY 1,2,3 ORDER BY 1,2,4 DESC`],
    ['C2 metadata keys per entity+action (ee-admin)', `
        SELECT entity_type, action, k AS meta_key, count(*) AS n
        FROM activity_log a, LATERAL jsonb_object_keys(a.metadata) k
        WHERE a.app = 'ee-admin'
        GROUP BY 1,2,3 ORDER BY 1,2,4 DESC`],
    ['C3 metadata keys per entity+action (agent-os)', `
        SELECT entity_type, action, k AS meta_key, count(*) AS n
        FROM activity_log a, LATERAL jsonb_object_keys(a.metadata) k
        WHERE a.app = 'agent-os'
        GROUP BY 1,2,3 ORDER BY 1,2,4 DESC`],
    ['C4 ee-admin sample rows (one per entity+action)', `
        SELECT DISTINCT ON (entity_type, action)
               entity_type, action, status, error_message, actor_name, actor_role,
               actor_user_id, actor_ref, entity_id, entity_label, description,
               fields, source_url, metadata, occurred_at
        FROM activity_log WHERE app='ee-admin'
        ORDER BY entity_type, action, occurred_at DESC`],
    ['C5 failed rows detail', `
        SELECT entity_type, action, coalesce(error_message,'(null)') AS err, count(*) AS n,
               min(occurred_at) AS first_seen, max(occurred_at) AS last_seen
        FROM activity_log WHERE status <> 'success'
        GROUP BY 1,2,3 ORDER BY n DESC`],
    ['C6 ee-admin actors', `
        SELECT actor_user_id, actor_name, actor_role, actor_ref, count(*) AS n
        FROM activity_log WHERE app='ee-admin'
        GROUP BY 1,2,3,4 ORDER BY n DESC`],
    ['C7 agent-os actors top', `
        SELECT coalesce(actor_name,'(null)') AS actor_name, actor_kind,
               count(*) AS n, count(actor_user_id) AS with_id
        FROM activity_log WHERE app='agent-os'
        GROUP BY 1,2 ORDER BY n DESC LIMIT 15`],
    ['C8 source_url shapes', `
        SELECT app, coalesce(source_url,'(null)') AS source_url, count(*) AS n
        FROM activity_log GROUP BY 1,2 ORDER BY n DESC LIMIT 20`],
    ['C9 hourly volume last 3 days', `
        SELECT to_char(date_trunc('hour', occurred_at AT TIME ZONE 'Asia/Kuala_Lumpur'),'MM-DD HH24:00') AS hr,
               app, count(*) AS n
        FROM activity_log WHERE occurred_at > now() - interval '3 days'
        GROUP BY 1,2 ORDER BY 1 DESC LIMIT 40`],
    ['C10 entity_label / entity_id fill rate', `
        SELECT app, entity_type, count(*) AS n,
               count(entity_id) AS with_entity_id, count(entity_label) AS with_label,
               count(description) AS with_desc, count(ip) AS with_ip, count(user_agent) AS with_ua,
               count(request_id) AS with_req
        FROM activity_log GROUP BY 1,2 ORDER BY n DESC`],
    ['C11 agent-os sample rows', `
        SELECT DISTINCT ON (entity_type, action)
               entity_type, action, actor_name, actor_ref, actor_user_id,
               entity_id, entity_label, description, fields, metadata, occurred_at
        FROM activity_log WHERE app='agent-os'
        ORDER BY entity_type, action, occurred_at DESC`],
    ['C12 ai_activity_log volume', `
        SELECT app, agent, agent_kind, model, action, count(*) AS n,
               min(occurred_at) AS first_seen, max(occurred_at) AS last_seen
        FROM ai_activity_log GROUP BY 1,2,3,4,5 ORDER BY n DESC LIMIT 30`],
    ['C13 user table for admin-os user events', `
        SELECT count(*) AS users, count(profile_picture) AS with_pic,
               count(main_department) AS with_dept, count(agent_code) AS with_code
        FROM "user"`],
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
