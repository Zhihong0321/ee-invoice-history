'use strict';
const { pool } = require('../src/db');

const Q = [
    ['J1 audit: distinct "Registration Status" after-values', `
        SELECT c->>'before' AS before, c->>'after' AS after, count(*) AS n
        FROM invoice_audit_log a, LATERAL jsonb_array_elements(a.changes) c
        WHERE c->>'field' = 'Registration Status'
        GROUP BY 1,2 ORDER BY n DESC`],
    ['J2 seda_registration table columns', `
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'seda_registration' ORDER BY ordinal_position`],
    ['J3 registration_status spread in seda_registration', `
        SELECT COALESCE(registration_status,'(null)') AS s, count(*) AS n
        FROM seda_registration GROUP BY 1 ORDER BY n DESC`],
    ['J4 any audit field name mentioning complete/submit', `
        SELECT a.entity_type, c->>'field' AS field, count(*) AS n
        FROM invoice_audit_log a, LATERAL jsonb_array_elements(a.changes) c
        WHERE c->>'field' ILIKE '%complet%' OR c->>'field' ILIKE '%submit%'
        GROUP BY 1,2 ORDER BY n DESC LIMIT 40`],
    ['J5 any audit value mentioning complete', `
        SELECT a.entity_type, c->>'field' AS field, c->>'after' AS after, count(*) AS n
        FROM invoice_audit_log a, LATERAL jsonb_array_elements(a.changes) c
        WHERE c->>'after' ILIKE '%complet%'
        GROUP BY 1,2,3 ORDER BY n DESC LIMIT 40`],
    ['J6 seda_status field values in audit (entity_type=seda)', `
        SELECT c->>'field' AS field, c->>'before' AS before, c->>'after' AS after, count(*) AS n
        FROM invoice_audit_log a, LATERAL jsonb_array_elements(a.changes) c
        WHERE a.entity_type = 'seda'
        GROUP BY 1,2,3 ORDER BY n DESC LIMIT 40`],
    ['J7 seda table columns (status source of truth)', `
        SELECT table_name, column_name FROM information_schema.columns
        WHERE column_name ILIKE '%seda%status%' OR column_name ILIKE '%registration_status%'
        ORDER BY table_name`],
];

(async () => {
    for (const [t, sql] of Q) {
        console.log('\n=============== ' + t + ' ===============');
        try { const r = await pool.query(sql); console.log(JSON.stringify(r.rows, null, 1)); }
        catch (e) { console.log('ERROR: ' + e.message); }
    }
    await pool.end();
})();
