'use strict';

require('dotenv').config();

const DB_MODE = (process.env.DB_MODE || (process.env.DATABASE_URL ? 'direct' : 'proxy')).toLowerCase();

/**
 * Three DB modes (user authorized all three):
 *
 *   1. direct  — uses `pg.Pool` against a real Postgres connection string.
 *                Set DB_MODE=direct and provide DATABASE_URL. Recommended
 *                when this app can reach the DB over TCP.
 *
 *   2. proxy   — uses the Railway HTTP proxy (no direct DB connection).
 *                Set DB_MODE=proxy and provide PG_PROXY_TOKEN (plus optional
 *                PG_PROXY_HOST, PG_PROXY_DB_NAME). Mirrors the pattern in
 *                the parent project's `scripts/backfill-*-proxy.js`. Useful
 *                when this app can't open a TCP socket to Postgres.
 *
 *   3. stub    — no real DB. The pool returns empty arrays for any query,
 *                and /api/healthz reports `db: 'up'`. Use this for UI
 *                development, screenshots, and demos when the DB is
 *                unreachable. Never deploy with stub mode.
 *
 * All three expose the same `pool` interface so route handlers don't care
 * which is in use.
 */
if (!['direct', 'proxy', 'stub'].includes(DB_MODE)) {
    throw new Error(`DB_MODE must be 'direct', 'proxy', or 'stub' (got '${DB_MODE}')`);
}

let pool;

if (DB_MODE === 'direct') {
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is not set (DB_MODE=direct). Copy .env.example to .env and configure it.');
    }

    const { Pool } = require('pg');
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        application_name: 'invoice-history',
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
        max: 5,
        idleTimeoutMillis: 30_000,
    });
    pool.on('error', (err) => {
        console.error('[db] idle pg client error:', err.message);
    });
} else if (DB_MODE === 'proxy') {
    const https = require('https');

    if (!process.env.PG_PROXY_TOKEN) {
        throw new Error('PG_PROXY_TOKEN is not set (DB_MODE=proxy). Set it in .env or use DB_MODE=direct with DATABASE_URL.');
    }

    const PROXY_HOST = process.env.PG_PROXY_HOST || 'pg-proxy-production.up.railway.app';
    const PROXY_TOKEN = process.env.PG_PROXY_TOKEN;
    const PROXY_DB_NAME = process.env.PG_PROXY_DB_NAME || 'prod_main';

    /**
     * Execute a single SQL statement through the HTTP proxy.
     * Resolves to the same shape `pg.Pool#query` resolves to.
     */
    function proxyQuery(sql, params = []) {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify({
                db_name: PROXY_DB_NAME,
                sql,
                params
            });

            const req = https.request(
                {
                    hostname: PROXY_HOST,
                    port: 443,
                    path: '/api/sql',
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${PROXY_TOKEN}`,
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(body)
                    }
                },
                (res) => {
                    let raw = '';
                    res.on('data', (chunk) => { raw += chunk; });
                    res.on('end', () => {
                        let parsed;
                        try {
                            parsed = JSON.parse(raw);
                        } catch (err) {
                            return reject(new Error(`Invalid JSON from proxy: ${raw.slice(0, 200)}`));
                        }
                        if (parsed.error) {
                            return reject(new Error(parsed.error));
                        }
                        const rows = parsed.data || parsed.rows || [];
                        resolve({ rows, rowCount: rows.length });
                    });
                }
            );
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }

    /**
     * Fake "client" for the proxy mode. Implements the subset of the `pg`
     * client interface that this app uses: `.query(sql, params)`.
     * `.release()` is a no-op (the proxy has no connection to release).
     */
    function makeProxyClient() {
        return {
            query: proxyQuery,
            release: () => {}
        };
    }

    /**
     * Fake "pool" for proxy mode. Each `.connect()` returns a new
     * proxy-backed client. `.end()` and `.on('error', ...)` are no-ops
     * for symmetry with the real pg.Pool.
     */
    pool = {
        connect: async () => makeProxyClient(),
        query: proxyQuery,
        end: async () => {},
        on: () => {}
    };

    console.log(`[db] running in proxy mode → https://${PROXY_HOST}/ (db: ${PROXY_DB_NAME})`);
} else {
    // stub mode — no real DB. Returns 3 fake history rows for any bubble_id
    // so the UI's timeline (the whole point of this app) can be inspected
    // without a real DB. Health-check and lookup queries return empty.

    const FAKE_INVOICE_ROWS = [
        {
            id: 1001,
            invoice_id: 1001,
            invoice_number: 'INV-2026-0001',
            entity_type: 'invoice',
            entity_id: 'demo-bubble-id',
            action_type: 'insert',
            changes: JSON.stringify([
                { field: 'Invoice Number', after: 'INV-2026-0001' },
                { field: 'Status', after: 'draft' },
                { field: 'Total Amount', after: 'RM 18,400' }
            ]),
            actor_user_id: 'u-demo-001',
            actor_name: 'Aiman Razak',
            actor_phone: '+60123456789',
            actor_role: 'agent',
            source_app: 'agent-os',
            edited_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3).toISOString()
        },
        {
            id: 1002,
            invoice_id: 1001,
            invoice_number: 'INV-2026-0001',
            entity_type: 'invoice',
            entity_id: 'demo-bubble-id',
            action_type: 'update',
            changes: JSON.stringify([
                { field: 'Status', before: 'draft', after: 'deposited' },
                { field: 'Linked Package', before: 'Tiger Neo 5kW', after: 'Tiger Neo 8kW + 10kWh BESS' }
            ]),
            actor_user_id: 'u-demo-001',
            actor_name: 'Aiman Razak',
            actor_phone: '+60123456789',
            actor_role: 'agent',
            source_app: 'agent-os',
            edited_at: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString()
        },
        {
            id: 1003,
            invoice_id: 1001,
            invoice_number: 'INV-2026-0001',
            entity_type: 'invoice_item',
            entity_id: 'item-bubble-001',
            action_type: 'update',
            changes: JSON.stringify([
                { field: 'Quantity', before: '8', after: '10' },
                { field: 'Unit Price', before: 'RM 420', after: 'RM 415' }
            ]),
            actor_name: null,
            actor_phone: null,
            actor_role: null,
            source_app: 'agent-os',
            application_name: 'invoice-mobile-app',
            database_user: 'app_user_pool',
            client_addr: '10.0.4.21',
            edited_at: new Date(Date.now() - 1000 * 60 * 30).toISOString()
        }
    ];

    function stubQuery(sql, params = []) {
        const normalized = String(sql || '').trim().toLowerCase();

        // 1. invoice lookup (resolveInvoiceFamilyIds)
        if (normalized.startsWith('select bubble_id, root_id, parent_id') && normalized.includes('from invoice')) {
            return Promise.resolve({
                rows: [{ bubble_id: 'demo-bubble-id', root_id: null, parent_id: null }],
                rowCount: 1
            });
        }

        // 2. family expansion — distinct bubble_ids sharing root/parent
        if (normalized.startsWith('select distinct bubble_id') && normalized.includes('from invoice')) {
            return Promise.resolve({
                rows: [{ bubble_id: 'demo-bubble-id' }],
                rowCount: 1
            });
        }

        // 3. invoice_item bubble_ids in the family
        if (normalized.startsWith('select bubble_id') && normalized.includes('from invoice_item')) {
            return Promise.resolve({
                rows: [{ bubble_id: 'item-bubble-001' }],
                rowCount: 1
            });
        }

        // 4. The audit-log / legacy-history reads
        if (normalized.startsWith('select audit.*') || normalized.includes('from invoice_audit_log') || normalized.includes('from invoice_edit_history')) {
            return Promise.resolve({ rows: FAKE_INVOICE_ROWS, rowCount: FAKE_INVOICE_ROWS.length });
        }

        // 5. health-check (SELECT 1)
        if (normalized === 'select 1' || normalized.startsWith('select 1')) {
            return Promise.resolve({ rows: [{ '?column?': 1 }], rowCount: 1 });
        }

        // 6. anything else — empty
        return Promise.resolve({ rows: [], rowCount: 0 });
    }
    function makeStubClient() {
        return {
            query: stubQuery,
            release: () => {}
        };
    }
    pool = {
        connect: async () => makeStubClient(),
        query: stubQuery,
        end: async () => {},
        on: () => {}
    };
    console.log('[db] running in STUB mode (returning 3 fake history rows for any bubble_id)');
}

module.exports = { pool, mode: DB_MODE };
