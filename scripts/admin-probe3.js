'use strict';
/* Probe 3: does ee-admin's activity_log duplicate invoice_audit_log rows? */
const { pool } = require('../src/db');

const Q = [
    ['D1 overlap: ee-admin activity_log rows vs invoice_audit_log within 60s', `
        SELECT al.entity_type, al.action, count(*) AS n,
               count(*) FILTER (WHERE EXISTS (
                   SELECT 1 FROM invoice_audit_log a
                   WHERE a.entity_type = al.entity_type
                     AND abs(extract(epoch FROM (a.edited_at - al.occurred_at))) < 60
               )) AS has_audit_twin
        FROM activity_log al
        WHERE al.app = 'ee-admin'
        GROUP BY 1,2 ORDER BY n DESC`],
    ['D2 audit-log volume in the same window (since 2026-07-28)', `
        SELECT entity_type, action_type, count(*) AS n
        FROM invoice_audit_log
        WHERE edited_at >= '2026-07-28'
        GROUP BY 1,2 ORDER BY n DESC LIMIT 25`],
    ['D3 any user/customer entity in invoice_audit_log at all?', `
        SELECT entity_type, count(*) AS n
        FROM invoice_audit_log
        WHERE entity_type IN ('user','customer','attachment','receipt')
        GROUP BY 1`],
    ['D4 activity_log oldest row / retention window', `
        SELECT min(occurred_at) AS oldest, max(occurred_at) AS newest,
               count(*) AS n, count(*) FILTER (WHERE retain_until IS NOT NULL) AS with_retain
        FROM activity_log`],
    ['D5 ee-admin print: which invoices, repeat prints', `
        SELECT entity_label, count(*) AS prints, min(occurred_at) AS first, max(occurred_at) AS last
        FROM activity_log WHERE app='ee-admin' AND action='print'
        GROUP BY 1 ORDER BY prints DESC LIMIT 10`],
    ['D6 receipt send success vs failed by day', `
        SELECT (occurred_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS day,
               status, count(*) AS n
        FROM activity_log WHERE app='ee-admin' AND entity_type='receipt'
        GROUP BY 1,2 ORDER BY 1 DESC`],
    ['D7 payment verify → receipt send pairing (same entity_id)', `
        SELECT v.entity_id, v.occurred_at AS verified_at, r.occurred_at AS receipt_at, r.status
        FROM activity_log v
        LEFT JOIN activity_log r
          ON r.app='ee-admin' AND r.entity_type='receipt' AND r.entity_id = v.entity_id
        WHERE v.app='ee-admin' AND v.entity_type='payment' AND v.action='verify'
        ORDER BY v.occurred_at DESC LIMIT 12`],
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
