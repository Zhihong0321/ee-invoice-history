'use strict';
// Probe 4: activity_log timestamp column + attachment-related content.
const { pool } = require('../src/db');

async function q(label, sql, params = []) {
    try {
        const r = await pool.query(sql, params);
        console.log(`\n=== ${label} (${r.rows.length}) ===`);
        console.log(JSON.stringify(r.rows, null, 1).slice(0, 9000));
    } catch (e) {
        console.log(`\n=== ${label} ERROR: ${e.message} ===`);
    }
}

(async () => {
    await q('activity_log remaining columns',
        `SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) cols
         FROM information_schema.columns WHERE table_schema='public' AND table_name='activity_log'`);

    await q('activity_log: app x entity_type x action inventory',
        `SELECT app, entity_type, action, count(*) n, min(occurred_at) first, max(occurred_at) last
         FROM activity_log GROUP BY 1,2,3 ORDER BY n DESC LIMIT 60`);

    await q('activity_log attachment/roof/site sample',
        `SELECT id, app, actor_name, actor_role, action, entity_type, entity_id, entity_label,
                left(coalesce(description,''),200) description, fields, source_url, occurred_at
         FROM activity_log
         WHERE (coalesce(entity_type,'')||coalesce(action,'')||coalesce(entity_label,'')
                ||coalesce(description,'')||coalesce(source_url,'')||coalesce(fields::text,''))
               ~* '(attach|roof|site_|image|photo|upload)'
         ORDER BY occurred_at DESC LIMIT 20`);

    await pool.end();
})();
