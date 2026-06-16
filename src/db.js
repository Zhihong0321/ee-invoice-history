'use strict';

require('dotenv').config();

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
    // Fail loud at boot — we never want to silently fall back to a stub here.
    // The parent project has a dev-stub fallback; this app is intended to point
    // at a real (read-only) Postgres from day one.
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and configure it.');
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    application_name: 'invoice-history',
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 5,
    idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
    // Don't crash the process on idle-client errors; just log.
    console.error('[db] idle pg client error:', err.message);
});

module.exports = { pool };
