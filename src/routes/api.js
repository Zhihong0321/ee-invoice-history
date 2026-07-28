'use strict';

const express = require('express');
const { pool } = require('../db');
const { loadInvoiceHistory } = require('../repo/history');
const { loadViewerActivity } = require('../repo/viewerActivity');
const { listInvoices, loadInvoiceDetail } = require('../repo/invoiceFeed');
const { loadDashboard, loadLive } = require('../repo/dashboard');
const { loadActivityLog, loadActivityLogFacets, loadActivityLogSummary } = require('../repo/activityLog');

const router = express.Router();

/**
 * GET /healthz
 * Returns DB reachability. Cheap probe.
 */
router.get('/healthz', async (req, res) => {
    let client = null;
    try {
        client = await pool.connect();
        await client.query('SELECT 1');
        res.json({ ok: true, db: 'up' });
    } catch (err) {
        res.status(503).json({ ok: false, db: 'down', error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/invoices
 * Front-page feed: one row per invoice, sorted by most-recent activity.
 * Query params:
 *   search  - matches invoice_number OR customer name (optional)
 *   page    - 1-based page number (default 1)
 *
 * Returns: 200 { ok: true, data: { rows, page, pageSize, hasMore } }
 */
router.get('/invoices', async (req, res) => {
    const { search = '', page = '1' } = req.query;
    let client = null;
    try {
        client = await pool.connect();
        const data = await listInvoices(client, { search, page });
        res.json({ ok: true, data });
    } catch (err) {
        console.error('[api] /invoices feed failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/invoices/:invoiceId/detail
 * Every audit log row for one invoice (by integer invoice_id), normalized
 * for the timeline, plus invoice header meta.
 *
 * Returns: 200 { ok: true, data: { invoice, rows, total } }
 *          404 when the invoice_id is unknown.
 */
router.get('/invoices/:invoiceId/detail', async (req, res) => {
    const { invoiceId } = req.params;
    let client = null;
    try {
        client = await pool.connect();
        const data = await loadInvoiceDetail(client, invoiceId);
        if (!data) {
            return res.status(404).json({ ok: false, error: 'Invoice not found' });
        }
        res.json({ ok: true, data });
    } catch (err) {
        console.error(`[api] /detail ${invoiceId} failed:`, err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/invoices/:bubbleId/history
 * Per-invoice edit / audit history (normalized rows from invoice_audit_log
 * and the legacy invoice_edit_history table).
 *
 * Returns:
 *   200 { ok: true, data: { invoiceId, rows: HistoryRow[] } }
 *   404 { ok: false, error: 'Invoice not found' }   when bubble_id is unknown
 *   500 { ok: false, error: <message> }
 */
router.get('/invoices/:bubbleId/history', async (req, res) => {
    const { bubbleId } = req.params;
    if (!bubbleId || !bubbleId.trim()) {
        return res.status(400).json({ ok: false, error: 'bubbleId is required' });
    }

    let client = null;
    try {
        client = await pool.connect();
        const result = await loadInvoiceHistory(client, bubbleId);
        if (!result) {
            return res.status(404).json({ ok: false, error: 'Invoice not found' });
        }
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error(`[api] /history ${bubbleId} failed:`, err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/invoices/:bubbleId/viewer-activity
 * Per-invoice viewer-activity stream (entity_type = 'viewer_activity').
 * Includes a summary block with view counts, unique visitors, average
 * duration, and last-activity timestamp.
 */
router.get('/invoices/:bubbleId/viewer-activity', async (req, res) => {
    const { bubbleId } = req.params;
    if (!bubbleId || !bubbleId.trim()) {
        return res.status(400).json({ ok: false, error: 'bubbleId is required' });
    }

    let client = null;
    try {
        client = await pool.connect();
        const result = await loadViewerActivity(client, bubbleId);
        if (!result) {
            return res.status(404).json({ ok: false, error: 'Invoice not found' });
        }
        res.json({ ok: true, data: result });
    } catch (err) {
        console.error(`[api] /viewer-activity ${bubbleId} failed:`, err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/dashboard
 * Company-wide "live pulse" snapshot: today's KPI counters (vs. yesterday),
 * revenue collected/pending, who's viewing an invoice right now, which
 * invoices are getting the most attention, and a chronological cross-invoice
 * activity feed. Powers the standalone /dashboard.html view.
 *
 * Returns: 200 { ok: true, data: { generatedAt, kpis, revenue, activeViewers, topMovers, feed } }
 */
router.get('/dashboard', async (req, res) => {
    let client = null;
    try {
        client = await pool.connect();
        const data = await loadDashboard(client);
        res.json({ ok: true, data });
    } catch (err) {
        console.error('[api] /dashboard failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * Lightweight, high-frequency companion to /dashboard for the /live.html wall
 * board. Cheap queries only (no revenue/outstanding scan) so it can be polled
 * every few seconds. Powers the live event ticker, ticking KPI counters, and
 * the events-per-minute activity pulse.
 *
 * Returns: 200 { ok: true, data: { generatedAt, kpis, seda, receipts, newRegistrations, feed, activeViewers, pulse } }
 */
router.get('/live', async (req, res) => {
    let client = null;
    try {
        client = await pool.connect();
        const data = await loadLive(client);
        res.json({ ok: true, data });
    } catch (err) {
        console.error('[api] /live failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/activity-log
 * Global cross-app feed from the shared `activity_log` table (prod_main).
 * Query params:
 *   app         - exact match on the writing app's slug (optional)
 *   entityType  - exact match on entity_type (optional)
 *   actor       - substring match on actor_name (optional)
 *   search      - substring match on description / entity_label / action (optional)
 *   cursor      - "<occurred_at ISO>|<id>" from a previous response's nextCursor
 *   limit       - page size, default 50, max 200
 *
 * `facets` (distinct apps/entity_types) and `summary` (per-app counters) are
 * only computed on the first page of a filter set (no cursor) to avoid
 * re-running them on every "load more" click.
 *
 * Returns: 200 { ok: true, data: { rows, hasMore, nextCursor, facets, summary, generatedAt } }
 */
router.get('/activity-log', async (req, res) => {
    const { app, entityType, actor, search, cursor, limit } = req.query;
    let client = null;
    try {
        client = await pool.connect();
        const feed = await loadActivityLog(client, { app, entityType, actor, search, cursor, limit });

        let facets = null;
        let summary = null;
        if (!cursor) {
            [facets, summary] = await Promise.all([
                loadActivityLogFacets(client),
                loadActivityLogSummary(client)
            ]);
        }

        res.json({ ok: true, data: { ...feed, facets, summary, generatedAt: new Date().toISOString() } });
    } catch (err) {
        console.error('[api] /activity-log failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

module.exports = router;
