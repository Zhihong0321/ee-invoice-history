'use strict';

const express = require('express');
const { pool } = require('../db');
const { routerPool } = require('../routerDb');
const { loadInvoiceHistory } = require('../repo/history');
const { loadViewerActivity } = require('../repo/viewerActivity');
const { listInvoices, loadInvoiceDetail } = require('../repo/invoiceFeed');
const { loadDashboard, loadLive } = require('../repo/dashboard');
const { loadActivityLog, loadActivityLogFacets, loadActivityLogSummary } = require('../repo/activityLog');
const {
    loadCalculatorActivity,
    loadCalculatorActivityMap,
    loadCalculatorUserSummaries,
    loadSalesAgentActivityBoard,
    loadSalesAgentActivitySummary,
    loadInvoicePrep,
    loadInvoiceEdit,
    loadInvoiceView,
    loadInvoiceAll,
    loadSedaActivity,
    loadSedaCycleTimes,
    loadSedaActivityMap,
    loadPaymentSubmission,
    loadPaymentVerification,
    loadPaymentActivity,
    loadPaymentVerificationStats,
    loadPaymentReceipt,
    loadClaimSubmission
} = require('../repo/activityLogV2');
const { loadUserProfile, loadUserProfileByName, loadUserProfiles, loadAllUserProfiles } = require('../repo/userProfile');
const { loadAdminActivity, loadAdminSummary, loadAdminActorMaps } = require('../repo/adminActivity');
const { loadProjectAttachments, loadProjectAttachmentSummary } = require('../repo/projectAttachments');
const { loadAiActivity, loadAiActivitySummary, loadSolarPresentationActivity, loadReferralActivity } = require('../repo/aiActivity');
const { loadAiRouterLogs, loadAiRouterSummary } = require('../repo/aiRouterLogs');
const { loadWarehouse } = require('../repo/warehouse');
const { loadSalesAgentPaymentCycle } = require('../repo/salesAgentPaymentCycle');
const { loadOverview } = require('../repo/overview');

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
 * GET /api/overview
 * Landing page: one summary per activity log — today vs yesterday, a 7-day
 * sparkline and the last event — so every department's box renders from a
 * single request instead of thirteen feed loads.
 *
 * The AI Router box reads a second database; if that one is down the rest of
 * the payload still returns and the box reports `offline: true`.
 *
 * Returns: 200 { ok: true, data: { generatedAt, days, sections, otherPages } }
 */
router.get('/overview', async (req, res) => {
    let client = null;
    let routerClient = null;
    try {
        client = await pool.connect();
        try {
            routerClient = await routerPool.connect();
        } catch (err) {
            console.warn('[api] /overview: router DB connect failed:', err.message);
        }
        const data = await loadOverview(client, routerClient);
        res.json({ ok: true, data });
    } catch (err) {
        console.error('[api] /overview failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
        if (routerClient) routerClient.release();
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

/**
 * GET /api/activity-log/calculator
 * V2 endpoint: Calculator activity logs (residential_roi_calculation + commercial_roi_lookup).
 *
 * Returns: 200 { ok: true, rows: ActivityRow[], userSummaries: CalculatorUserSummary[] }
 */
router.get('/activity-log/calculator', async (req, res) => {
    let client = null;
    try {
        client = await pool.connect();
        const [rows, userSummaries] = await Promise.all([
            loadCalculatorActivity(client),
            loadCalculatorUserSummaries(client)
        ]);
        res.json({ ok: true, rows, userSummaries });
    } catch (err) {
        console.error('[api] /activity-log/calculator failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/activity-log/calculator/activity-map
 * Per-day x per-4-hour-slot calculator counts for the heatmap grid: one
 * column per day, six rows (00-04 ... 20-24) inside it. Bucketed in
 * Asia/Kuala_Lumpur so the time-of-day axis reads as local working hours.
 * Query params:
 *   days - window width, default 14, clamped 3..180
 *
 * Returns: 200 { ok: true, map: { days: DayColumn[], ...summary } }
 */
router.get('/activity-log/calculator/activity-map', async (req, res) => {
    let client = null;
    try {
        client = await pool.connect();
        const map = await loadCalculatorActivityMap(client, { days: req.query.days });
        res.json({ ok: true, map });
    } catch (err) {
        console.error('[api] /activity-log/calculator/activity-map failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/activity-log/sales-agent-board
 * Top five sales agents by calculator use in the last 30 days, with average
 * TNB bill input and the requested input-range frequency distribution.
 */
router.get('/activity-log/sales-agent-board', async (req, res) => {
    let client = null;
    try {
        client = await pool.connect();
        const [agents, summary] = await Promise.all([
            loadSalesAgentActivityBoard(client),
            loadSalesAgentActivitySummary(client)
        ]);
        res.json({ ok: true, agents, summary });
    } catch (err) {
        console.error('[api] /activity-log/sales-agent-board failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/activity-log/invoice/prep
 * V2 endpoint: invoices prepared (invoice:insert + its line items), one entry
 * per invoice. Reads `invoice_audit_log`.
 *
 * Returns: 200 { ok: true, rows: PrepRow[] }
 */
router.get('/activity-log/invoice/prep', async (req, res) => {
    let client = null;
    try {
        client = await pool.connect();
        const rows = await loadInvoicePrep(client, { limit: req.query.limit });
        res.json({ ok: true, rows });
    } catch (err) {
        console.error('[api] /activity-log/invoice/prep failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/activity-log/invoice/edit
 * V2 endpoint: field-level invoice + line-item edits.
 * Query params:
 *   showAgentReassign - '1' to include linked_agent-only updates (hidden by default)
 *   limit             - page size, default 60, max 200
 *
 * Returns: 200 { ok: true, rows: EditRow[] }
 */
router.get('/activity-log/invoice/edit', async (req, res) => {
    let client = null;
    try {
        client = await pool.connect();
        const rows = await loadInvoiceEdit(client, {
            limit: req.query.limit,
            showAgentReassign: req.query.showAgentReassign === '1'
        });
        res.json({ ok: true, rows });
    } catch (err) {
        console.error('[api] /activity-log/invoice/edit failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/activity-log/invoice/view
 * V2 endpoint: invoice viewing sessions, collapsed from the three
 * viewer_activity events into one entry per (invoice, device).
 * Query params:
 *   viewerType - 'all' (default) | 'anonymous' | 'logged_in'
 *   limit      - session count, default 50, max 200
 *
 * Returns: 200 { ok: true, rows: SessionRow[] }
 */
router.get('/activity-log/invoice/view', async (req, res) => {
    let client = null;
    try {
        client = await pool.connect();
        const rows = await loadInvoiceView(client, {
            limit: req.query.limit,
            viewerType: req.query.viewerType
        });
        res.json({ ok: true, rows });
    } catch (err) {
        console.error('[api] /activity-log/invoice/view failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/activity-log/invoice/all
 * V2 endpoint: prep + edit + view merged into one chronological stream.
 * Query params:
 *   showAgentReassign - '1' to include linked_agent-only updates
 *   viewerType        - 'all' (default) | 'anonymous' | 'logged_in'
 *   limit             - event count, default 60, max 200
 *
 * Returns: 200 { ok: true, rows: (PrepRow|EditRow|SessionRow & { kind })[] }
 */
router.get('/activity-log/invoice/all', async (req, res) => {
    let client = null;
    try {
        client = await pool.connect();
        const rows = await loadInvoiceAll(client, {
            limit: req.query.limit,
            showAgentReassign: req.query.showAgentReassign === '1',
            viewerType: req.query.viewerType
        });
        res.json({ ok: true, rows });
    } catch (err) {
        console.error('[api] /activity-log/invoice/all failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/activity-log/seda
 * V2 endpoint: one combined SEDA feed (registration + uploads + admin status).
 * Query params:
 *   kinds           - comma list of 'registration','documents','status' (default all)
 *   includeBackfill - '1' to include the null -> status initial writes
 *   limit           - default 120, max 500
 *
 * Returns: 200 { ok: true, rows: SedaRow[] }
 */
router.get('/activity-log/seda', async (req, res) => {
    let client = null;
    try {
        client = await pool.connect();
        const kinds = String(req.query.kinds || '')
            .split(',')
            .map((k) => k.trim())
            .filter(Boolean);
        const rows = await loadSedaActivity(client, {
            limit: req.query.limit,
            kinds,
            includeBackfill: req.query.includeBackfill === '1'
        });
        res.json({ ok: true, rows });
    } catch (err) {
        console.error('[api] /activity-log/seda failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/activity-log/seda/activity-map
 * Per-day SEDA event counts for the contribution-heatmap grid. Takes the
 * same kinds/backfill filters as /activity-log/seda so the map and the feed
 * below it always describe the same events.
 * Query params:
 *   weeks           - grid width in whole weeks, default 26, clamped 4..53
 *   kinds           - comma list of 'registration','documents','status'
 *   includeBackfill - '1' to include the null -> status initial writes
 *
 * Returns: 200 { ok: true, map: { days: DayCell[], ...summary } }
 */
router.get('/activity-log/seda/activity-map', async (req, res) => {
    let client = null;
    try {
        client = await pool.connect();
        const kinds = String(req.query.kinds || '')
            .split(',')
            .map((k) => k.trim())
            .filter(Boolean);
        const map = await loadSedaActivityMap(client, {
            weeks: req.query.weeks,
            kinds,
            includeBackfill: req.query.includeBackfill === '1'
        });
        res.json({ ok: true, map });
    } catch (err) {
        console.error('[api] /activity-log/seda/activity-map failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/activity-log/seda/cycle-times
 * Median/avg days for the SEDA stages that are actually measurable.
 *
 * Returns: 200 { ok: true, stats: CycleStat[] }
 */
router.get('/activity-log/seda/cycle-times', async (req, res) => {
    let client = null;
    try {
        client = await pool.connect();
        const stats = await loadSedaCycleTimes(client);
        res.json({ ok: true, stats });
    } catch (err) {
        console.error('[api] /activity-log/seda/cycle-times failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/activity-log/finance/submission
 * V2 endpoint: payments submitted (submitted_payment:insert), each enriched
 * with how it was resolved (verified / deleted / still pending).
 *
 * Returns: 200 { ok: true, rows: SubmissionRow[] }
 */
router.get('/activity-log/finance/submission', async (req, res) => {
    let client = null;
    try {
        client = await pool.connect();
        const rows = await loadPaymentSubmission(client, { limit: req.query.limit });
        res.json({ ok: true, rows });
    } catch (err) {
        console.error('[api] /activity-log/finance/submission failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/activity-log/finance/verification
 * V2 endpoint: field-level payment verify/update/delete events (plus the
 * legacy pre-2026-05-05 verified_payment flow).
 *
 * Returns: 200 { ok: true, rows: VerificationRow[] }
 */
router.get('/activity-log/finance/verification', async (req, res) => {
    let client = null;
    try {
        client = await pool.connect();
        const rows = await loadPaymentVerification(client, { limit: req.query.limit });
        res.json({ ok: true, rows });
    } catch (err) {
        console.error('[api] /activity-log/finance/verification failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/activity-log/finance/all
 * V2 endpoint: submission + verification merged into one chronological
 * stream (same "guaranteed-complete window" merge as /invoice/all).
 *
 * Returns: 200 { ok: true, rows: (SubmissionRow|VerificationRow & { kind })[] }
 */
router.get('/activity-log/finance/all', async (req, res) => {
    let client = null;
    try {
        client = await pool.connect();
        const rows = await loadPaymentActivity(client, { limit: req.query.limit });
        res.json({ ok: true, rows });
    } catch (err) {
        console.error('[api] /activity-log/finance/all failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/activity-log/finance/stats
 * Last-N-days summary for the Payment Activity page: average submit→verify
 * turnaround and a daily verified-total series (default 30 days).
 *
 * Returns: 200 { ok: true, stats: { windowDays, resolvedCount, avgResolutionMs,
 *   verifiedCount, verifiedTotal, daily: [{ date, total, count }] } }
 */
router.get('/activity-log/finance/stats', async (req, res) => {
    let client = null;
    try {
        client = await pool.connect();
        const stats = await loadPaymentVerificationStats(client, { days: req.query.days });
        res.json({ ok: true, stats });
    } catch (err) {
        console.error('[api] /activity-log/finance/stats failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/activity-log/finance/receipt
 * V2 endpoint: official receipt sends, merged from invoice_audit_log
 * (full history, no success/failure signal) and activity_log (send
 * status/error, available from 2026-07-28 onward).
 *
 * Returns: 200 { ok: true, rows: ReceiptRow[] }
 */
router.get('/activity-log/finance/receipt', async (req, res) => {
    let client = null;
    try {
        client = await pool.connect();
        const rows = await loadPaymentReceipt(client, { limit: req.query.limit });
        res.json({ ok: true, rows });
    } catch (err) {
        console.error('[api] /activity-log/finance/receipt failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/activity-log/finance/claim
 * V2 endpoint: staff expense claim submissions, merged from activity_log
 * (entity_type='claim_receipt', logging live since 2026-07-31) and the
 * claim_receipt table itself (every claim, including pre-logging ones).
 *
 * Returns: 200 { ok: true, rows: ClaimRow[] }
 */
router.get('/activity-log/finance/claim', async (req, res) => {
    let client = null;
    try {
        client = await pool.connect();
        const rows = await loadClaimSubmission(client, { limit: req.query.limit });
        res.json({ ok: true, rows });
    } catch (err) {
        console.error('[api] /activity-log/finance/claim failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/warehouse
 * Live stock demand: every invoice that carries a payment, traced to the
 * panels and inverters its package commits.
 *
 * Returns: 200 { ok: true, data: { generatedAt, coverage, totals, groups } }
 */
router.get('/warehouse', async (req, res) => {
    try {
        const data = await loadWarehouse();
        res.json({ ok: true, data });
    } catch (err) {
        console.error('[api] /warehouse failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

/**
 * GET /api/sales/agent-payment-cycle
 * Per sales agent: avg/median days deposit -> 59% paid, and 59% -> full
 * payment, plus case count and total invoice amount.
 */
router.get('/sales/agent-payment-cycle', async (req, res) => {
    try {
        const data = await loadSalesAgentPaymentCycle();
        res.json({ ok: true, data });
    } catch (err) {
        console.error('[api] /sales/agent-payment-cycle failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

/**
 * GET /api/activity-log/admin
 * Admin console activity from activity_log WHERE app='ee-admin'.
 * Query params:
 *   areas           - comma list of area filters (print, payment, receipt, customer, user, attachment, invoice, other)
 *   includeDuplicates - '1' to include rows that also exist in invoice_audit_log
 *   cursor          - "<occurred_at ISO>|<id>" for pagination
 *   limit           - page size, default 80, max 300
 *
 * Returns: 200 { ok: true, rows, hasMore, nextCursor }
 */
router.get('/activity-log/admin', async (req, res) => {
    const { areas, includeDuplicates, cursor, limit } = req.query;
    let client = null;
    try {
        client = await pool.connect();
        const areaList = areas ? String(areas).split(',').map(a => a.trim()).filter(Boolean) : null;
        const data = await loadAdminActivity(client, {
            areas: areaList,
            includeDuplicates: includeDuplicates === '1',
            cursor,
            limit
        });
        res.json({ ok: true, ...data });
    } catch (err) {
        console.error('[api] /activity-log/admin failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/activity-log/admin/summary
 * Summary stats for the admin console stat strip.
 *
 * Returns: 200 { ok: true, stats: StatTile[] }
 */
router.get('/activity-log/admin/summary', async (req, res) => {
    let client = null;
    try {
        client = await pool.connect();
        const stats = await loadAdminSummary(client);
        res.json({ ok: true, stats });
    } catch (err) {
        console.error('[api] /activity-log/admin/summary failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/activity-log/admin/actor-maps
 * One per-day heatmap per detected admin actor. Takes the same areas/
 * duplicates filters as /activity-log/admin so the maps and the feed below
 * them describe the same events.
 * Query params:
 *   weeks             - grid width in whole weeks, default 5, clamped 2..8
 *                       (activity_log is purged at 30 days)
 *   areas             - comma list of area filters
 *   includeDuplicates - '1' to include rows that also exist in invoice_audit_log
 *
 * Returns: 200 { ok: true, map: { actors: ActorMap[], ...window } }
 */
router.get('/activity-log/admin/actor-maps', async (req, res) => {
    let client = null;
    try {
        client = await pool.connect();
        const areaList = req.query.areas
            ? String(req.query.areas).split(',').map(a => a.trim()).filter(Boolean)
            : null;
        const map = await loadAdminActorMaps(client, {
            weeks: req.query.weeks,
            areas: areaList,
            includeDuplicates: req.query.includeDuplicates === '1'
        });
        res.json({ ok: true, map });
    } catch (err) {
        console.error('[api] /activity-log/admin/actor-maps failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/activity-log/project/attachment
 * PROJECT department: every file attached to or removed from an invoice —
 * site photos, roof images, SEDA documents and engineering drawings — read
 * from invoice_audit_log (invoice_upload / seda_upload / drawing).
 * Query params:
 *   kinds  - comma list of classified kinds (system_drawing, pv_drawing,
 *            roof_drawing, roof_image, site_image, seda_doc, other)
 *   cursor - "<edited_at ISO>|<id>" for pagination
 *   limit  - page size, default 80, max 300
 *
 * Returns: 200 { ok: true, rows, hasMore, nextCursor }
 */
router.get('/activity-log/project/attachment', async (req, res) => {
    const { kinds, cursor, limit } = req.query;
    let client = null;
    try {
        client = await pool.connect();
        const kindList = kinds ? String(kinds).split(',').map(k => k.trim()).filter(Boolean) : null;
        const data = await loadProjectAttachments(client, { kinds: kindList, cursor, limit });
        res.json({ ok: true, ...data });
    } catch (err) {
        console.error('[api] /activity-log/project/attachment failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/activity-log/project/attachment/summary
 * Whole-log totals per attachment kind, for the stat strip and chip counts.
 *
 * Returns: 200 { ok: true, summary }
 */
router.get('/activity-log/project/attachment/summary', async (req, res) => {
    let client = null;
    try {
        client = await pool.connect();
        const summary = await loadProjectAttachmentSummary(client);
        res.json({ ok: true, summary });
    } catch (err) {
        console.error('[api] /activity-log/project/attachment/summary failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/activity-log/solar-presentation
 * Auto Proposal activity merged from `ai_activity_log` and `activity_log`,
 * both filtered to app='solar-presentation'.
 * Query params:
 *   sources - comma list of 'ai' and/or 'activity' (default both)
 *   limit   - page size, default 100, max 300
 *
 * Returns: 200 { ok: true, rows }
 */
router.get('/activity-log/solar-presentation', async (req, res) => {
    const { sources, limit } = req.query;
    let client = null;
    try {
        client = await pool.connect();
        const sourceList = sources ? String(sources).split(',').map((source) => source.trim()).filter(Boolean) : null;
        const rows = await loadSolarPresentationActivity(client, { sources: sourceList, limit });
        res.json({ ok: true, rows });
    } catch (err) {
        console.error('[api] /activity-log/solar-presentation failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/activity-log/referral
 * Referral activity merged from `et_messages` (webchat events, channel=
 * 'webchat') and `ai_activity_log` (app='00product-ai', the LLM answering
 * those webchat questions). There is no `activity_log` app row for Referral,
 * so the webchat stream stands in for "activity" here.
 * Query params:
 *   sources - comma list of 'ai' and/or 'activity' (default both)
 *   limit   - page size, default 100, max 300
 *
 * Returns: 200 { ok: true, rows }
 */
router.get('/activity-log/referral', async (req, res) => {
    const { sources, limit } = req.query;
    let client = null;
    try {
        client = await pool.connect();
        const sourceList = sources ? String(sources).split(',').map((source) => source.trim()).filter(Boolean) : null;
        const rows = await loadReferralActivity(client, { sources: sourceList, limit });
        res.json({ ok: true, rows });
    } catch (err) {
        console.error('[api] /activity-log/referral failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/activity-log/ai-workflow
 * AI Workflow activity from `ai_activity_log` — every AI agent run across
 * all Eternalgy apps (Claude sessions, MiniMax TTS, etc.), regardless of app.
 * Query params:
 *   apps  - comma list of app filters (e.g. "solar-presentation,ee-saj-api")
 *   limit - page size, default 100, max 300
 *
 * Returns: 200 { ok: true, rows }
 */
router.get('/activity-log/ai-workflow', async (req, res) => {
    const { apps, limit } = req.query;
    let client = null;
    try {
        client = await pool.connect();
        const appList = apps ? String(apps).split(',').map(a => a.trim()).filter(Boolean) : null;
        const rows = await loadAiActivity(client, { apps: appList, limit });
        res.json({ ok: true, rows });
    } catch (err) {
        console.error('[api] /activity-log/ai-workflow failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/activity-log/ai-workflow/summary
 * Summary stats for the AI Workflow stat strip.
 *
 * Returns: 200 { ok: true, stats: StatTile[] }
 */
router.get('/activity-log/ai-workflow/summary', async (req, res) => {
    let client = null;
    try {
        client = await pool.connect();
        const stats = await loadAiActivitySummary(client);
        res.json({ ok: true, stats });
    } catch (err) {
        console.error('[api] /activity-log/ai-workflow/summary failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/ai-router/logs
 * AI Router request logs from `request_logs` (tnb-tariff DB — a separate
 * connection from the rest of this app; see ../routerDb.js).
 * Query params:
 *   status    - 'all' (default) | 'success' | 'error'
 *   providers - comma list of provider_name filters
 *   limit     - page size, default 100, max 300
 *
 * Returns: 200 { ok: true, rows }
 */
router.get('/ai-router/logs', async (req, res) => {
    const { status, providers, limit } = req.query;
    let client = null;
    try {
        client = await routerPool.connect();
        const providerList = providers ? String(providers).split(',').map(p => p.trim()).filter(Boolean) : null;
        const rows = await loadAiRouterLogs(client, { status, providers: providerList, limit });
        res.json({ ok: true, rows });
    } catch (err) {
        console.error('[api] /ai-router/logs failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/ai-router/summary
 * Summary stats for the AI Router stat strip.
 *
 * Returns: 200 { ok: true, stats: StatTile[] }
 */
router.get('/ai-router/summary', async (req, res) => {
    let client = null;
    try {
        client = await routerPool.connect();
        const stats = await loadAiRouterSummary(client);
        res.json({ ok: true, stats });
    } catch (err) {
        console.error('[api] /ai-router/summary failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/users/profile/:userId
 * Get user profile by ID
 *
 * Returns: 200 { ok: true, profile: UserProfile }
 */
router.get('/users/profile/:userId', async (req, res) => {
    const { userId } = req.params;
    let client = null;
    try {
        client = await pool.connect();
        // userId is usually a Bubble id, not an integer — pass it through raw.
        const profile = await loadUserProfile(client, userId);
        if (!profile) {
            return res.status(404).json({ ok: false, error: 'User not found' });
        }
        res.json({ ok: true, profile });
    } catch (err) {
        console.error(`[api] /users/profile/${userId} failed:`, err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/users/profile-by-name/:name
 * Get user profile by name (fallback when user_id is not available)
 *
 * Returns: 200 { ok: true, profile: UserProfile }
 */
router.get('/users/profile-by-name/:name', async (req, res) => {
    const { name } = req.params;
    let client = null;
    try {
        client = await pool.connect();
        const profile = await loadUserProfileByName(client, decodeURIComponent(name));
        if (!profile) {
            return res.status(404).json({ ok: false, error: 'User not found' });
        }
        res.json({ ok: true, profile });
    } catch (err) {
        console.error(`[api] /users/profile-by-name/${name} failed:`, err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

/**
 * GET /api/users/profiles-cache
 * Get all users with profile pictures for client-side caching
 *
 * Returns: 200 { ok: true, profiles: UserProfile[] }
 */
router.get('/users/profiles-cache', async (req, res) => {
    let client = null;
    try {
        client = await pool.connect();
        const profiles = await loadAllUserProfiles(client);
        res.json({ ok: true, profiles, count: profiles.length });
    } catch (err) {
        console.error('[api] /users/profiles-cache failed:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        if (client) client.release();
    }
});

module.exports = router;
