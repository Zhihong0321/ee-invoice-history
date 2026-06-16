'use strict';

/**
 * Invoice viewer-activity reader.
 *
 * Lifted from E:\Solar Calculator v2\src\modules\Invoicing\api\invoiceRoutes.js
 * (the `/viewer-activity` route and its `normalizeViewerActivityRow` /
 * `summarizeViewerActivity` helpers). The route's auth and ownership checks
 * are intentionally dropped — this app has no auth.
 *
 * The SQL and normalization match the parent app so the JSON shape is
 * stable across both viewers.
 */

function safeJson(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch (err) {
        return null;
    }
}

function getChangeAfter(changes, field) {
    if (!Array.isArray(changes)) return null;
    const match = changes.find((change) => String(change?.field || '').toLowerCase() === field);
    return match ? match.after : null;
}

function normalizeViewerActivityRow(row) {
    const changes = safeJson(row.changes) || [];
    const eventType = String(row.action_type || getChangeAfter(changes, 'event_type') || '').toLowerCase();
    const pageType = String(getChangeAfter(changes, 'page_type') || '').toLowerCase();
    const duration = Number(getChangeAfter(changes, 'duration_seconds'));
    const deviceHash = String(row.entity_id || getChangeAfter(changes, 'device_hash') || '').trim();
    const actorName = String(row.actor_name || '').trim();
    const actorPhone = String(row.actor_phone || '').trim();
    const actorRole = String(row.actor_role || '').trim();
    const hasLoggedInViewer = Boolean(row.actor_user_id || actorName || actorPhone);

    return {
        id: row.id,
        event_type: eventType,
        page_type: pageType,
        device_hash: deviceHash,
        visitor_label: actorName || (row.actor_user_id ? `user ${row.actor_user_id}` : `device ${deviceHash.slice(0, 8)}`),
        viewer_type: hasLoggedInViewer ? 'logged_in' : (getChangeAfter(changes, 'viewer_type') || 'anonymous'),
        actor_user_id: row.actor_user_id || null,
        actor_name: actorName || null,
        actor_phone: actorPhone || null,
        actor_role: actorRole || null,
        button_name: getChangeAfter(changes, 'button_name'),
        duration_seconds: Number.isFinite(duration) ? duration : null,
        viewed_at: row.edited_at,
        created_at: row.edited_at
    };
}

function summarizeViewerActivity(events) {
    const uniqueVisitors = new Set(events.map((event) => event.device_hash).filter(Boolean));
    const invoiceVisitors = new Set(events
        .filter((event) => event.event_type === 'invoice_viewed')
        .map((event) => event.device_hash)
        .filter(Boolean));
    const proposalVisitors = new Set(events
        .filter((event) => event.event_type === 'proposal_viewed')
        .map((event) => event.device_hash)
        .filter(Boolean));
    const durations = events
        .filter((event) => event.duration_seconds !== null)
        .map((event) => event.duration_seconds);
    const averageDuration = durations.length > 0
        ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
        : 0;

    return {
        total_events: events.length,
        invoice_views: events.filter((event) => event.event_type === 'invoice_viewed').length,
        proposal_views: events.filter((event) => event.event_type === 'proposal_viewed').length,
        button_clicks: events.filter((event) => event.event_type.endsWith('_button_clicked')).length,
        unique_visitors: uniqueVisitors.size,
        unique_invoice_visitors: invoiceVisitors.size,
        unique_proposal_visitors: proposalVisitors.size,
        average_duration_seconds: averageDuration,
        last_activity_at: events[0]?.created_at || null
    };
}

/**
 * Resolve the numeric invoice.id from a bubble_id, returning null if the
 * invoice doesn't exist. Mirrors the parent app's lookup behavior.
 */
async function resolveInvoiceNumericId(client, bubbleId) {
    if (!bubbleId) return null;
    const result = await client.query(
        `SELECT id, invoice_number
           FROM invoice
          WHERE bubble_id = $1
             OR id::text = $1
          LIMIT 1`,
        [bubbleId]
    );
    return result.rows[0] || null;
}

/**
 * Load viewer-activity rows for an invoice.
 *
 * @param {object} client - Active pg client
 * @param {string} bubbleId - The invoice's bubble_id
 * @returns {Promise<{invoiceId: string, invoiceNumber: string|null, summary: object, events: object[]}|null>}
 *   Returns null if the invoice doesn't exist.
 */
async function loadViewerActivity(client, bubbleId) {
    const invoice = await resolveInvoiceNumericId(client, bubbleId);
    if (!invoice) {
        return null;
    }

    const auditRows = await client.query(
        `SELECT id, action_type, entity_id, actor_user_id, actor_name, actor_phone, actor_role, changes, edited_at
           FROM invoice_audit_log
          WHERE invoice_id = $1
            AND entity_type = 'viewer_activity'
          ORDER BY edited_at DESC
          LIMIT 500`,
        [invoice.id]
    );

    const events = auditRows.rows.map(normalizeViewerActivityRow);

    return {
        invoiceId: bubbleId,
        invoiceNumber: invoice.invoice_number || null,
        summary: summarizeViewerActivity(events),
        events
    };
}

module.exports = {
    loadViewerActivity,
    // Exported for testability / reuse:
    normalizeViewerActivityRow,
    summarizeViewerActivity
};
