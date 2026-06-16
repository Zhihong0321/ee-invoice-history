'use strict';

const path = require('path');
const express = require('express');

const apiRouter = require('./src/routes/api');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

// Tiny request logger. Production should swap in morgan or similar.
app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
        const elapsed = Date.now() - started;
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${elapsed}ms)`);
    });
    next();
});

app.use(express.json({ limit: '64kb' }));

// JSON API.
app.use('/api', apiRouter);

// Static frontend. Served from /public. The index.html is the SPA.
app.use(express.static(path.join(__dirname, 'public'), {
    index: 'index.html',
    extensions: ['html']
}));

// 404 fallback for unknown /api paths. Unknown non-/api paths fall through to
// index.html (handled by express.static with index:'index.html' and the
// static middleware's default behavior).
app.use('/api', (req, res) => {
    res.status(404).json({ ok: false, error: 'Not found' });
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`ee-invoice-history listening on http://localhost:${PORT}`);
        console.log(`  UI:        http://localhost:${PORT}/`);
        console.log(`  Health:    http://localhost:${PORT}/api/healthz`);
        console.log(`  History:   http://localhost:${PORT}/api/invoices/<bubbleId>/history`);
        console.log(`  Activity:  http://localhost:${PORT}/api/invoices/<bubbleId>/viewer-activity`);
    });
}

module.exports = app;
