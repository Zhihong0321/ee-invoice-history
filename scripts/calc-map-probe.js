'use strict';
/* One-off probe: span + 4-hour-slot shape for the calculator activity map. */
const { pool } = require('../src/db');

const Q = [
    ['C1 span + totals per entity_type', `
        SELECT entity_type, count(*) AS n,
               min(occurred_at)::date AS first_seen, max(occurred_at)::date AS last_seen
        FROM activity_log
        WHERE entity_type IN ('residential_roi_calculation','commercial_roi_lookup')
        GROUP BY 1 ORDER BY n DESC`],
    ['C2 occurred_at column type', `
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name='activity_log' AND column_name='occurred_at'`],
    ['C3 4-hour slot distribution (Asia/Kuala_Lumpur)', `
        SELECT floor(extract(hour FROM occurred_at AT TIME ZONE 'Asia/Kuala_Lumpur') / 4)::int AS slot,
               count(*) AS n
        FROM activity_log
        WHERE entity_type IN ('residential_roi_calculation','commercial_roi_lookup')
        GROUP BY 1 ORDER BY 1`],
    ['C4 daily totals last 60 days (KL)', `
        SELECT to_char(occurred_at AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM-DD') AS day, count(*) AS n
        FROM activity_log
        WHERE entity_type IN ('residential_roi_calculation','commercial_roi_lookup')
          AND occurred_at >= now() - interval '60 days'
        GROUP BY 1 ORDER BY 1 DESC LIMIT 30`],
    ['C5 busiest day x slot cells', `
        SELECT to_char(occurred_at AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM-DD') AS day,
               floor(extract(hour FROM occurred_at AT TIME ZONE 'Asia/Kuala_Lumpur') / 4)::int AS slot,
               count(*) AS n
        FROM activity_log
        WHERE entity_type IN ('residential_roi_calculation','commercial_roi_lookup')
        GROUP BY 1,2 ORDER BY n DESC LIMIT 15`],
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
