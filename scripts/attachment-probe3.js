'use strict';
// Probe 3: what's actually inside activity_log, and does it cover ee_attachment /
// roof image / site image?
const { pool } = require('../src/db');

async function q(label, sql, params = []) {
    try {
        const r = await pool.query(sql, params);
        console.log(`\n=== ${label} (${r.rows.length}) ===`);
        console.log(JSON.stringify(r.rows, null, 1).slice(0, 8000));
    } catch (e) {
        console.log(`\n=== ${label} ERROR: ${e.message} ===`);
    }
}

(async () => {
    await q('activity_log: app x entity_type x action inventory',
        `SELECT app, entity_type, action, count(*) n, min(created_at) first, max(created_at) last
         FROM activity_log GROUP BY 1,2,3 ORDER BY n DESC LIMIT 60`);

    await q('activity_log rows mentioning attachment/roof/site/image/photo',
        `SELECT count(*) n FROM activity_log
         WHERE (coalesce(entity_type,'')||coalesce(action,'')||coalesce(entity_label,'')
                ||coalesce(description,'')||coalesce(source_url,'')||coalesce(fields::text,''))
               ~* '(attach|roof|site|image|photo|upload)'`);

    await q('activity_log matching sample',
        `SELECT id, app, actor_name, action, entity_type, entity_id, entity_label,
                left(coalesce(description,''),200) description, fields, created_at
         FROM activity_log
         WHERE (coalesce(entity_type,'')||coalesce(action,'')||coalesce(entity_label,'')
                ||coalesce(description,'')||coalesce(source_url,'')||coalesce(fields::text,''))
               ~* '(attach|roof|site|image|photo|upload)'
         ORDER BY created_at DESC LIMIT 20`);

    await q('activity_log latest 10 (any)',
        `SELECT id, app, action, entity_type, entity_label, left(coalesce(description,''),160) description, created_at
         FROM activity_log ORDER BY created_at DESC LIMIT 10`);

    await q('ee_attachment: category x doc_type inventory',
        `SELECT category, doc_type, count(*) n, min(uploaded_at) first, max(uploaded_at) last
         FROM ee_attachment GROUP BY 1,2 ORDER BY n DESC LIMIT 60`);

    await pool.end();
})();
