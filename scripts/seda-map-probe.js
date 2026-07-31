'use strict';
/* One-off probe: types + daily volume shape for the SEDA activity map. */
const { pool } = require('../src/db');

const Q = [
    ['T1 edited_at column type', `
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name='invoice_audit_log' AND column_name IN ('edited_at','changes')`],
    ['T2 server timezone', `SHOW timezone`],
    ['T3 daily seda volume, last 26 weeks', `
        SELECT to_char(a.edited_at, 'YYYY-MM-DD') AS day, a.entity_type, count(*) AS n
        FROM invoice_audit_log a
        WHERE a.entity_type IN ('seda','seda_registration','seda_upload')
          AND a.edited_at >= now() - interval '182 days'
        GROUP BY 1,2 ORDER BY 1 DESC LIMIT 40`],
    ['T4 non-backfill daily volume, last 26 weeks', `
        SELECT to_char(a.edited_at, 'YYYY-MM-DD') AS day, count(*) AS n
        FROM invoice_audit_log a
        WHERE a.entity_type IN ('seda','seda_registration','seda_upload')
          AND jsonb_typeof(a.changes) = 'array'
          AND a.edited_at >= now() - interval '182 days'
          AND NOT (
              a.entity_type = 'seda'
              AND NOT EXISTS (
                  SELECT 1 FROM jsonb_array_elements(a.changes) c
                  WHERE c ? 'before' AND c->>'before' IS NOT NULL
              )
          )
        GROUP BY 1 ORDER BY 1 DESC LIMIT 40`],
    ['T5 overall seda span + totals', `
        SELECT entity_type, count(*) AS n,
               min(edited_at)::date AS first_seen, max(edited_at)::date AS last_seen
        FROM invoice_audit_log
        WHERE entity_type IN ('seda','seda_registration','seda_upload')
        GROUP BY 1 ORDER BY n DESC`],
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
