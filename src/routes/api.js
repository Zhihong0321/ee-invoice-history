'use strict';

const express = require('express');
const { pool } = require('../db');
const { loadInvoiceHistory } = require('../repo/history');
const { loadViewerActivity } = require('../repo/viewerActivity');

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

module.exports = router;
