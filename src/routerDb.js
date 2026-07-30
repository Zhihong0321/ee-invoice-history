'use strict';

require('dotenv').config();

/**
 * Second, independent DB connection — the AI Router's `request_logs` table
 * lives in a different database (tnb-tariff) than everything else in this
 * app (prod_main, via ../db.js). Same Railway HTTP proxy host, different
 * db_name + token.
 *
 * Two modes:
 *   proxy — set ROUTER_PG_PROXY_TOKEN (+ optional ROUTER_PG_PROXY_HOST,
 *           ROUTER_PG_PROXY_DB_NAME, default 'tnb-tariff').
 *   stub  — no token set. Returns empty rows so the UI still loads; the
 *           AI Router section just shows "no data" instead of crashing
 *           the whole app when the token is missing/expired.
 */

const ROUTER_PROXY_HOST = process.env.ROUTER_PG_PROXY_HOST || 'pg-proxy-production.up.railway.app';
const ROUTER_PROXY_DB_NAME = process.env.ROUTER_PG_PROXY_DB_NAME || 'tnb-tariff';
const ROUTER_PROXY_TOKEN = process.env.ROUTER_PG_PROXY_TOKEN || '';

let routerPool;

if (ROUTER_PROXY_TOKEN) {
    const https = require('https');

    function proxyQuery(sql, params = []) {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify({
                db_name: ROUTER_PROXY_DB_NAME,
                sql,
                params
            });

            const req = https.request(
                {
                    hostname: ROUTER_PROXY_HOST,
                    port: 443,
                    path: '/api/sql',
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${ROUTER_PROXY_TOKEN}`,
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
                            return reject(new Error(`Invalid JSON from router proxy: ${raw.slice(0, 200)}`));
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

    routerPool = {
        connect: async () => ({ query: proxyQuery, release: () => {} }),
        query: proxyQuery,
        end: async () => {},
        on: () => {}
    };

    console.log(`[router-db] running in proxy mode → https://${ROUTER_PROXY_HOST}/ (db: ${ROUTER_PROXY_DB_NAME})`);
} else {
    function stubQuery() {
        return Promise.resolve({ rows: [], rowCount: 0 });
    }
    routerPool = {
        connect: async () => ({ query: stubQuery, release: () => {} }),
        query: stubQuery,
        end: async () => {},
        on: () => {}
    };
    console.log('[router-db] no ROUTER_PG_PROXY_TOKEN set — AI Router will show no data (stub mode)');
}

module.exports = { routerPool };
