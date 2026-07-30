'use strict';

/**
 * Activity Log V2 - Department-based queries
 *
 * This module provides specialized queries for the V2 activity log UI,
 * organized by department and sub-category.
 */

/**
 * Load calculator activity logs (SALES > Calculator).
 * Includes both residential_roi_calculation and commercial_roi_lookup.
 *
 * @param {object} client - pg client
 * @returns {Promise<Array>} - Activity rows with occurred_at, description, entity_type, actor_name, app
 */
async function loadCalculatorActivity(client) {
    const sql = `
        SELECT
            id,
            app,
            entity_type,
            entity_id,
            entity_label,
            action,
            description,
            actor_user_id,
            actor_name,
            actor_role,
            occurred_at,
            metadata
        FROM activity_log
        WHERE entity_type IN ('residential_roi_calculation', 'commercial_roi_lookup')
        ORDER BY occurred_at DESC
        LIMIT 100
    `;

    const result = await client.query(sql);
    return result.rows;
}

/**
 * Aggregate calculator usage by actor across the complete seven-day period.
 * This is separate from the 100-row timeline limit because every activity
 * card needs the totals for its own user.
 */
async function loadCalculatorUserSummaries(client) {
    const sql = `
        SELECT
            actor_user_id,
            actor_name,
            COUNT(*)::int AS total_use_last_7_days,
            AVG((metadata->>'billAmount')::numeric) FILTER (
                WHERE entity_type = 'residential_roi_calculation'
                  AND COALESCE(metadata->>'billAmount', '') ~ '^[0-9]+(\\.[0-9]+)?$'
            ) AS average_tnb_input
        FROM activity_log
        WHERE entity_type IN ('residential_roi_calculation', 'commercial_roi_lookup')
          AND occurred_at >= NOW() - INTERVAL '7 days'
        GROUP BY actor_user_id, actor_name
    `;

    const { rows } = await client.query(sql);
    return rows.map((row) => ({
        actorUserId: row.actor_user_id,
        actorName: row.actor_name,
        totalUseLast7Days: Number(row.total_use_last_7_days) || 0,
        averageTnbInput: row.average_tnb_input === null ? null : Number(row.average_tnb_input)
    }));
}

/**
 * Top fifteen calculator users in the last 30 days, including their residential
 * TNB bill distribution. Commercial lookups count toward usage but carry no
 * TNB bill value.
 */
async function loadSalesAgentActivityBoard(client) {
    const sql = `
        WITH calculator_events AS (
            SELECT
                actor_user_id,
                actor_name,
                CASE
                    WHEN entity_type = 'residential_roi_calculation'
                     AND COALESCE(metadata->>'billAmount', '') ~ '^[0-9]+(\\.[0-9]+)?$'
                    THEN (metadata->>'billAmount')::numeric
                    ELSE NULL
                END AS tnb_bill
            FROM activity_log
            WHERE entity_type IN ('residential_roi_calculation', 'commercial_roi_lookup')
              AND occurred_at >= NOW() - INTERVAL '30 days'
              AND actor_user_id IS NOT NULL
              AND NULLIF(BTRIM(actor_name), '') IS NOT NULL
              AND LOWER(BTRIM(actor_name)) NOT IN ('unknown', 'unknown agent')
        )
        SELECT
            actor_user_id,
            actor_name,
            COUNT(*)::int AS usage_count_30_days,
            AVG(tnb_bill) AS average_tnb_bill,
            COUNT(*) FILTER (WHERE tnb_bill >= 0 AND tnb_bill <= 300)::int AS tnb_0_to_300,
            COUNT(*) FILTER (WHERE tnb_bill >= 301 AND tnb_bill <= 800)::int AS tnb_301_to_800,
            COUNT(*) FILTER (WHERE tnb_bill > 800)::int AS tnb_above_800
        FROM calculator_events
        GROUP BY actor_user_id, actor_name
        ORDER BY usage_count_30_days DESC, actor_name NULLS LAST
        LIMIT 15
    `;

    const { rows } = await client.query(sql);
    return rows.map((row) => ({
        agentUserId: row.actor_user_id,
        agentName: row.actor_name || 'Unknown agent',
        usageCount30Days: Number(row.usage_count_30_days) || 0,
        averageTnbBill: row.average_tnb_bill === null ? null : Number(row.average_tnb_bill),
        tnb0To300: Number(row.tnb_0_to_300) || 0,
        tnb301To800: Number(row.tnb_301_to_800) || 0,
        tnbAbove800: Number(row.tnb_above_800) || 0
    }));
}

/**
 * Overall valid-agent calculator usage and residential TNB input frequency
 * for the same 30-day period shown by the Sales Agent Activity board.
 */
async function loadSalesAgentActivitySummary(client) {
    const sql = `
        WITH calculator_events AS (
            SELECT
                CASE
                    WHEN entity_type = 'residential_roi_calculation'
                     AND COALESCE(metadata->>'billAmount', '') ~ '^[0-9]+(\\.[0-9]+)?$'
                    THEN (metadata->>'billAmount')::numeric
                    ELSE NULL
                END AS tnb_bill
            FROM activity_log
            WHERE entity_type IN ('residential_roi_calculation', 'commercial_roi_lookup')
              AND occurred_at >= NOW() - INTERVAL '30 days'
              AND actor_user_id IS NOT NULL
              AND NULLIF(BTRIM(actor_name), '') IS NOT NULL
              AND LOWER(BTRIM(actor_name)) NOT IN ('unknown', 'unknown agent')
        )
        SELECT
            COUNT(*)::int AS total_use_last_30_days,
            COUNT(*) FILTER (WHERE tnb_bill >= 0 AND tnb_bill <= 300)::int AS low_frequency,
            COUNT(*) FILTER (WHERE tnb_bill >= 301 AND tnb_bill <= 800)::int AS mid_frequency,
            COUNT(*) FILTER (WHERE tnb_bill > 800)::int AS high_frequency
        FROM calculator_events
    `;

    const { rows } = await client.query(sql);
    const summary = rows[0];
    return {
        totalUseLast30Days: Number(summary.total_use_last_30_days) || 0,
        lowFrequency: Number(summary.low_frequency) || 0,
        midFrequency: Number(summary.mid_frequency) || 0,
        highFrequency: Number(summary.high_frequency) || 0
    };
}

/* ------------------------------------------------------------------ *
 * INVOICE department (reads `invoice_audit_log`, NOT `activity_log`)
 * ------------------------------------------------------------------ */

/**
 * Flatten an audit-log `changes` jsonb array into a { field: after } map.
 * Rows store changes as [{ field, before?, after }].
 */
function changeMap(changes) {
    const map = {};
    if (!Array.isArray(changes)) return map;
    for (const c of changes) {
        if (!c || c.field === undefined) continue;
        // Deletes carry the value in `before`, everything else in `after`.
        map[c.field] = c.after !== undefined && c.after !== null ? c.after : (c.before ?? null);
    }
    return map;
}

/**
 * PREP INVOICE — `invoice:insert` plus every line item created in the same
 * breath (`invoice_item:insert|create`), collapsed into one card per invoice
 * so the feed shows "an invoice was prepared", not 12 separate item rows.
 *
 * @param {object} client - pg client
 * @param {object} opts   - { limit }
 * @returns {Promise<Array>} - one entry per prepared invoice, newest first
 */
async function loadInvoicePrep(client, opts = {}) {
    const limit = Math.min(Number(opts.limit) || 50, 200);

    const headSql = `
        SELECT
            a.id,
            a.invoice_id,
            a.invoice_number,
            a.actor_user_id,
            a.actor_name,
            a.actor_role,
            a.source_app,
            a.changes,
            a.edited_at,
            c.name AS customer_name
        FROM invoice_audit_log a
        LEFT JOIN invoice i ON i.id = a.invoice_id
        LEFT JOIN customer c ON c.customer_id = i.linked_customer
        WHERE a.entity_type = 'invoice'
          AND a.action_type = 'insert'
        ORDER BY a.edited_at DESC
        LIMIT $1
    `;
    const head = await client.query(headSql, [limit]);
    if (head.rows.length === 0) return [];

    const invoiceIds = head.rows.map((r) => r.invoice_id).filter((id) => id !== null);

    let itemsByInvoice = new Map();
    if (invoiceIds.length > 0) {
        const itemSql = `
            SELECT invoice_id, changes, edited_at
            FROM invoice_audit_log
            WHERE entity_type = 'invoice_item'
              AND action_type IN ('insert', 'create')
              AND invoice_id = ANY($1::int[])
            ORDER BY edited_at ASC
        `;
        const items = await client.query(itemSql, [invoiceIds]);
        for (const row of items.rows) {
            const m = changeMap(row.changes);
            const list = itemsByInvoice.get(row.invoice_id) || [];
            list.push({
                description: m.description || m.item || null,
                qty: m.qty ?? null,
                unitPrice: m.unit_price ?? null,
                amount: m.amount ?? null,
                // 'discount' | 'voucher' | 'package' | 'extra' | null
                itemType: m.inv_item_type || null
            });
            itemsByInvoice.set(row.invoice_id, list);
        }
    }

    return head.rows.map((row) => {
        const m = changeMap(row.changes);
        const items = itemsByInvoice.get(row.invoice_id) || [];
        return {
            id: row.id,
            invoiceId: row.invoice_id,
            invoiceNumber: row.invoice_number || m['Invoice Number'] || null,
            customerName: row.customer_name || null,
            package: m['Linked Package'] || null,
            status: m.Status || null,
            totalAmount: m['Total Amount'] ?? null,
            createdBy: m['Created By'] || null,
            actorUserId: row.actor_user_id,
            actorName: row.actor_name,
            actorRole: row.actor_role,
            sourceApp: row.source_app,
            occurredAt: row.edited_at,
            items,
            itemCount: items.length,
            discountCount: items.filter((it) => it.itemType === 'discount').length,
            voucherCount: items.filter((it) => it.itemType === 'voucher').length
        };
    });
}

/**
 * EDIT INVOICE — `invoice:update` plus `invoice_item:update|delete`, one entry
 * per audit row with field-level before/after.
 *
 * `linked_agent`-only updates are ~65% of all invoice updates and carry no
 * business signal, so they are excluded unless opts.showAgentReassign is set.
 *
 * @param {object} client - pg client
 * @param {object} opts   - { limit, showAgentReassign }
 */
async function loadInvoiceEdit(client, opts = {}) {
    const limit = Math.min(Number(opts.limit) || 60, 200);
    const showAgentReassign = Boolean(opts.showAgentReassign);

    const agentOnlyFilter = showAgentReassign
        ? ''
        : `AND NOT (
               jsonb_array_length(a.changes) = 1
               AND a.changes -> 0 ->> 'field' = 'linked_agent'
           )`;

    const sql = `
        SELECT
            a.id,
            a.invoice_id,
            a.invoice_number,
            a.entity_type,
            a.action_type,
            a.actor_user_id,
            a.actor_name,
            a.actor_role,
            a.source_app,
            a.changes,
            a.edited_at,
            c.name AS customer_name
        FROM invoice_audit_log a
        LEFT JOIN invoice i ON i.id = a.invoice_id
        LEFT JOIN customer c ON c.customer_id = i.linked_customer
        WHERE (
                (a.entity_type = 'invoice' AND a.action_type = 'update')
             OR (a.entity_type = 'invoice_item' AND a.action_type IN ('update', 'delete'))
        )
          AND jsonb_typeof(a.changes) = 'array'
          ${agentOnlyFilter}
        ORDER BY a.edited_at DESC
        LIMIT $1
    `;

    const result = await client.query(sql, [limit]);

    return result.rows.map((row) => {
        const changes = Array.isArray(row.changes) ? row.changes : [];
        const m = changeMap(changes);
        const isDeletion =
            (row.entity_type === 'invoice' && String(m.is_deleted) === 'true') ||
            (row.entity_type === 'invoice_item' && row.action_type === 'delete');

        return {
            id: row.id,
            invoiceId: row.invoice_id,
            invoiceNumber: row.invoice_number,
            customerName: row.customer_name || null,
            entityType: row.entity_type,
            actionType: row.action_type,
            actorUserId: row.actor_user_id,
            actorName: row.actor_name,
            actorRole: row.actor_role,
            sourceApp: row.source_app,
            occurredAt: row.edited_at,
            isDeletion,
            itemLabel: row.entity_type === 'invoice_item' ? (m.description || m.item || null) : null,
            changes: changes.map((c) => ({
                field: c.field,
                before: c.before ?? null,
                after: c.after ?? null
            }))
        };
    });
}

/**
 * VIEW INVOICE — collapses the three `viewer_activity` events for an invoice
 * page (`invoice_viewed` → `invoice_button_clicked`* → `invoice_session_ended`)
 * into one session card, keyed on invoice_id + device_hash.
 *
 * Anonymous sessions (`viewer_type = 'anonymous'`, no actor) are the ones the
 * UI highlights — that is very likely the customer reading their own invoice.
 *
 * @param {object} client - pg client
 * @param {object} opts   - { limit, viewerType: 'all'|'anonymous'|'logged_in' }
 */
async function loadInvoiceView(client, opts = {}) {
    const limit = Math.min(Number(opts.limit) || 50, 200);
    const viewerType = opts.viewerType || 'all';

    // Over-fetch raw events: one session is 2-6 rows, so pull a generous
    // window and collapse in JS, then trim to `limit` sessions.
    const rawLimit = Math.min(limit * 12, 1200);

    // Every event row of a session carries viewer_type, so filtering here
    // keeps sessions intact and spends the raw window on the rows we want.
    const viewerFilter = (viewerType === 'anonymous' || viewerType === 'logged_in')
        ? `AND a.changes @> '[{"field":"viewer_type","after":"${viewerType}"}]'::jsonb`
        : '';

    const sql = `
        SELECT
            a.id,
            a.invoice_id,
            a.invoice_number,
            a.action_type,
            a.actor_user_id,
            a.actor_name,
            a.actor_role,
            a.changes,
            a.edited_at,
            c.name AS customer_name
        FROM invoice_audit_log a
        LEFT JOIN invoice i ON i.id = a.invoice_id
        LEFT JOIN customer c ON c.customer_id = i.linked_customer
        WHERE a.entity_type = 'viewer_activity'
          AND a.action_type IN ('invoice_viewed', 'invoice_button_clicked', 'invoice_session_ended')
          ${viewerFilter}
        ORDER BY a.edited_at DESC
        LIMIT $1
    `;
    const result = await client.query(sql, [rawLimit]);

    // Walk oldest → newest so each `invoice_viewed` opens a session that the
    // following clicks / session_ended for the same device attach to.
    const rows = result.rows.slice().reverse();
    const open = new Map(); // "invoiceId|deviceHash" -> session
    const sessions = [];

    for (const row of rows) {
        const m = changeMap(row.changes);
        const deviceHash = m.device_hash || 'unknown';
        const key = `${row.invoice_id}|${deviceHash}`;
        const ctx = m.visitor_context || {};

        if (row.action_type === 'invoice_viewed' || !open.has(key)) {
            const session = {
                id: row.id,
                invoiceId: row.invoice_id,
                invoiceNumber: row.invoice_number,
                customerName: row.customer_name || null,
                viewerType: m.viewer_type || (row.actor_user_id ? 'logged_in' : 'anonymous'),
                actorUserId: row.actor_user_id,
                actorName: row.actor_name,
                actorRole: row.actor_role,
                deviceHash,
                // stable, non-identifying nickname for repeat anonymous visitors
                deviceTag: deviceHash.slice(-6),
                startedAt: row.edited_at,
                endedAt: null,
                durationSeconds: null,
                buttons: [],
                timezone: ctx.timezone || null,
                screen: ctx.screen || null,
                referrer: ctx.referrer || null
            };
            open.set(key, session);
            sessions.push(session);
        }

        const session = open.get(key);
        if (row.action_type === 'invoice_button_clicked' && m.button_name) {
            session.buttons.push(m.button_name);
        }
        if (row.action_type === 'invoice_session_ended') {
            session.endedAt = row.edited_at;
            session.durationSeconds = typeof m.duration_seconds === 'number' ? m.duration_seconds : null;
            open.delete(key);
        }
    }

    let out = sessions.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
    if (viewerType === 'anonymous' || viewerType === 'logged_in') {
        out = out.filter((s) => s.viewerType === viewerType);
    }
    return out.slice(0, limit);
}

/**
 * ALL INVOICE ACTIVITY — prep, edit and view merged into one chronological
 * stream.
 *
 * The three sources have wildly different volumes, so a naive merge-and-slice
 * would silently drop older rows from the sparse ones. Instead the merged list
 * is cut at the NEWEST of the three "oldest row" timestamps: inside that window
 * every source is complete, so the feed has no gaps.
 *
 * @param {object} client - pg client
 * @param {object} opts   - { limit, showAgentReassign, viewerType }
 * @returns {Promise<Array>} - [{ kind: 'prep'|'edit'|'view', occurredAt, ...row }]
 */
async function loadInvoiceAll(client, opts = {}) {
    const limit = Math.min(Number(opts.limit) || 60, 200);
    // Over-fetch each source so the guaranteed-complete window stays wide.
    const perSource = Math.min(limit, 100);

    const [prep, edit, view] = await Promise.all([
        loadInvoicePrep(client, { limit: perSource }),
        loadInvoiceEdit(client, { limit: perSource, showAgentReassign: opts.showAgentReassign }),
        loadInvoiceView(client, { limit: perSource, viewerType: opts.viewerType })
    ]);

    const tagged = [
        ...prep.map((r) => ({ kind: 'prep', occurredAt: r.occurredAt, row: r })),
        ...edit.map((r) => ({ kind: 'edit', occurredAt: r.occurredAt, row: r })),
        ...view.map((r) => ({ kind: 'view', occurredAt: r.startedAt, row: r }))
    ].filter((e) => e.occurredAt);

    if (tagged.length === 0) return [];

    // Oldest timestamp each source reached; the tightest one bounds the window.
    const oldestPerSource = [prep, edit, view]
        .map((rows, i) => {
            if (rows.length < perSource) return null; // source wasn't truncated
            const last = rows[rows.length - 1];
            return new Date(i === 2 ? last.startedAt : last.occurredAt).getTime();
        })
        .filter((t) => t !== null && !Number.isNaN(t));

    const cutoff = oldestPerSource.length ? Math.max(...oldestPerSource) : null;

    let merged = tagged;
    if (cutoff !== null) {
        merged = merged.filter((e) => new Date(e.occurredAt).getTime() >= cutoff);
    }

    merged.sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));

    return merged.slice(0, limit).map((e) => ({
        kind: e.kind,
        occurredAt: e.occurredAt,
        ...e.row
    }));
}

/* ------------------------------------------------------------------ *
 * SEDA department — one combined log
 * ------------------------------------------------------------------ */

/**
 * Fields in a `seda_registration` diff that carry personal data. Values are
 * masked to a last-4 hint; the field name still shows so the log stays useful
 * ("agent filled in the IC number") without printing the IC number.
 */
/** Collection milestone: cumulative payments reaching this share of the invoice total. */
const SEDA_PAYMENT_CROSS_RATIO = 0.59;

/**
 * Whole days from `from` to `to`, one decimal. Returns null unless both ends
 * exist, and keeps the sign: a negative stage length is real signal here
 * (collection routinely crosses 59% before approval is keyed).
 */
function daysApart(to, from) {
    if (!to || !from) return null;
    const ms = new Date(to).getTime() - new Date(from).getTime();
    if (Number.isNaN(ms)) return null;
    return Math.round((ms / 86400000) * 10) / 10;
}

const SEDA_PII_FIELDS = new Set([
    'IC Number', 'Applicant Phone', 'Applicant Email', 'TIN', 'TNB Account No',
    'Installation Address', 'Emergency Contact Phone', 'Emergency Contact Email',
    'Emergency Contact MyKad'
]);

function maskValue(v) {
    const s = v === null || v === undefined ? '' : String(v);
    if (s === '') return s;
    const tail = s.replace(/\s+/g, '').slice(-4);
    return `•••${tail}`;
}

/**
 * SEDA is three tables' worth of events (registration, uploads, admin status)
 * that only make sense read together as one application's journey, so this
 * returns a single chronological feed rather than three.
 *
 * `kinds` filters to any of 'registration' | 'documents' | 'status'.
 *
 * `includeBackfill` — 1,466 of the 1,610 `seda:update` rows are `null -> X`
 * initial writes (a April-2026 bulk backfill), not real status transitions.
 * They drown the feed, so they are excluded unless asked for.
 *
 * @param {object} client - pg client
 * @param {object} opts   - { limit, kinds: string[], includeBackfill }
 */
async function loadSedaActivity(client, opts = {}) {
    const limit = Math.min(Number(opts.limit) || 120, 500);
    const kinds = Array.isArray(opts.kinds) && opts.kinds.length ? opts.kinds : null;
    const includeBackfill = Boolean(opts.includeBackfill);

    const entityTypes = [];
    if (!kinds || kinds.includes('registration')) entityTypes.push('seda_registration');
    if (!kinds || kinds.includes('documents')) entityTypes.push('seda_upload');
    if (!kinds || kinds.includes('status')) entityTypes.push('seda');
    if (entityTypes.length === 0) return [];

    // Drop the null -> X status writes: every change in the row is a status
    // field whose `before` is absent.
    const backfillFilter = includeBackfill
        ? ''
        : `AND NOT (
               a.entity_type = 'seda'
               AND NOT EXISTS (
                   SELECT 1 FROM jsonb_array_elements(a.changes) c
                   WHERE c ? 'before' AND c->>'before' IS NOT NULL
               )
           )`;

    const sql = `
        SELECT
            a.id,
            a.entity_type,
            a.action_type,
            a.invoice_id,
            a.invoice_number,
            a.actor_user_id,
            a.actor_name,
            a.actor_role,
            a.source_app,
            a.changes,
            a.edited_at,
            c.name AS customer_name,
            s.seda_status AS current_seda_status,
            s.mapper_status AS current_mapper_status,
            -- System size: seda_registration.system_size_in_form_kwp is only
            -- populated on 59 of 4,088 registrations, so it is a fallback to
            -- panel_qty x panel wattage, which resolves for 3,405.
            COALESCE(
                s.system_size_in_form_kwp,
                s.system_size,
                ROUND((pkg.panel_qty * panel.solar_output_rating) / 1000.0, 2)
            ) AS system_kwp,
            NULLIF(TRIM(COALESCE(NULLIF(TRIM(s.city), ''), c.city)), '') AS install_city,
            i.total_amount,
            i."1st_payment_date" AS t_first_payment,
            paid.paid_amount,
            ms.t_submitted,
            ms.t_approved,
            p59.t_pay_cross
        FROM invoice_audit_log a
        LEFT JOIN invoice i ON i.id = a.invoice_id
        LEFT JOIN customer c ON c.customer_id = i.linked_customer
        LEFT JOIN seda_registration s ON s.bubble_id = i.linked_seda_registration
        LEFT JOIN package pkg ON pkg.bubble_id = i.linked_package
        LEFT JOIN product panel ON panel.bubble_id = pkg.panel
        -- Lateral, not a join+group: one audit row must stay one audit row.
        LEFT JOIN LATERAL (
            SELECT sum(p.amount) AS paid_amount
            FROM payment p
            WHERE p.linked_invoice = i.bubble_id
              AND p.amount IS NOT NULL
        ) paid ON TRUE
        -- This invoice's own SEDA milestones, so every card can carry its
        -- stage lengths instead of only the dataset-wide averages.
        LEFT JOIN LATERAL (
            SELECT
                min(a2.edited_at) FILTER (WHERE c2->>'after' = 'Submitted') AS t_submitted,
                min(a2.edited_at) FILTER (WHERE c2->>'after' ILIKE 'approved%') AS t_approved
            FROM invoice_audit_log a2, LATERAL jsonb_array_elements(a2.changes) c2
            WHERE a2.invoice_id = a.invoice_id
              AND a2.entity_type = 'seda'
              AND lower(c2->>'field') = 'seda_status'
        ) ms ON TRUE
        -- Date collection crossed ${Math.round(SEDA_PAYMENT_CROSS_RATIO * 100)}% of the invoice total.
        LEFT JOIN LATERAL (
            SELECT min(pc.payment_date) AS t_pay_cross
            FROM (
                SELECT p.payment_date,
                       sum(p.amount) OVER (ORDER BY p.payment_date, p.id) AS cum
                FROM payment p
                WHERE p.linked_invoice = i.bubble_id
                  AND p.amount IS NOT NULL
                  AND p.payment_date IS NOT NULL
            ) pc
            WHERE i.total_amount > 0
              AND pc.cum >= ${SEDA_PAYMENT_CROSS_RATIO} * i.total_amount
        ) p59 ON TRUE
        WHERE a.entity_type = ANY($1::text[])
          AND jsonb_typeof(a.changes) = 'array'
          ${backfillFilter}
        ORDER BY a.edited_at DESC
        LIMIT $2
    `;

    const result = await client.query(sql, [entityTypes, limit]);

    return result.rows.map((row) => {
        const changes = Array.isArray(row.changes) ? row.changes : [];
        const m = changeMap(changes);
        const fields = changes.map((c) => c.field).filter(Boolean);

        let kind = 'status';
        let icon = '🏛';
        let title = null;
        let summary = null;
        let statusFrom = null;
        let statusTo = null;
        let docs = [];
        let diff = [];

        const totalAmount = row.total_amount === null || row.total_amount === undefined
            ? null : Number(row.total_amount);
        const paidAmount = row.paid_amount === null || row.paid_amount === undefined
            ? 0 : Number(row.paid_amount);

        if (row.entity_type === 'seda_registration' && row.action_type === 'insert') {
            kind = 'registration';
            icon = '📝';
            title = 'Registration created';
            summary = 'New SEDA registration opened';
            statusTo = m['Registration Status'] || null;
        } else if (row.entity_type === 'seda_registration') {
            kind = 'registration';
            icon = '✏️';
            title = 'Form updated';
            summary = fields.length > 3
                ? `Filled ${fields.length} fields`
                : fields.join(', ');
            diff = changes.map((c) => ({
                field: c.field,
                before: SEDA_PII_FIELDS.has(c.field) ? maskValue(c.before) : (c.before ?? null),
                after: SEDA_PII_FIELDS.has(c.field) ? maskValue(c.after) : (c.after ?? null)
            }));
        } else if (row.entity_type === 'seda_upload') {
            kind = 'documents';
            const removed = row.action_type === 'deleted';
            icon = removed ? '🗑' : '📎';
            title = removed ? 'Document removed' : 'Documents uploaded';
            docs = fields;
            summary = fields.length > 3
                ? `${fields.slice(0, 3).join(', ')} +${fields.length - 3}`
                : fields.join(', ');
        } else {
            // entity_type = 'seda' — admin-side status. Never has an actor.
            const statusChange =
                changes.find((c) => String(c.field || '').toLowerCase() === 'seda_status') ||
                changes.find((c) => String(c.field || '').toLowerCase() === 'mapper_status') ||
                {};
            const isMapper = String(statusChange.field || '').toLowerCase() === 'mapper_status';
            icon = isMapper ? '🗺' : '🏛';
            title = isMapper ? 'Mapper status' : 'SEDA status';
            statusFrom = statusChange.before ?? null;
            statusTo = statusChange.after ?? null;
            summary = statusFrom ? `${statusFrom} → ${statusTo}` : String(statusTo || '');
        }

        return {
            id: row.id,
            kind,
            icon,
            title,
            summary,
            invoiceId: row.invoice_id,
            invoiceNumber: row.invoice_number,
            customerName: row.customer_name || null,
            // `seda` and `seda_registration:insert` rows carry no actor at all;
            // the assigned agent id is the only attribution available there.
            actorUserId: row.actor_user_id,
            actorName: row.actor_name,
            actorRole: row.actor_role,
            assignedAgentId: m['Assigned Agent'] || null,
            sourceApp: row.source_app,
            occurredAt: row.edited_at,
            // Where the application stands TODAY, on every row regardless of kind —
            // a form edit or upload is only readable once you know whether the
            // application is still Pending or already Submitted/Approved.
            sedaStatus: row.current_seda_status || null,
            mapperStatus: row.current_mapper_status || null,
            systemKwp: row.system_kwp === null || row.system_kwp === undefined ? null : Number(row.system_kwp),
            installCity: row.install_city || null,
            // Collection state. `paidPercent` is null when there is nothing to
            // divide by (no invoice total), which is NOT the same as unpaid —
            // the UI treats "has money in" as the switch, not the percentage.
            totalAmount: totalAmount,
            paidAmount: paidAmount,
            paidPercent: totalAmount > 0 ? Math.round((paidAmount / totalAmount) * 100) : null,
            hasPayment: paidAmount > 0,
            // This invoice's own stage lengths in days. null = the pair of
            // milestones this stage needs has not both happened yet.
            stages: {
                paymentToSubmission: daysApart(row.t_submitted, row.t_first_payment),
                submissionToApproval: daysApart(row.t_approved, row.t_submitted),
                approvalToPaymentCross: daysApart(row.t_pay_cross, row.t_approved),
                // Live ageing clock, deliberately only while the application is
                // still unsubmitted — once it is submitted the finished
                // `paymentToSubmission` length is the honest number.
                daysSinceDeposit: row.t_submitted
                    ? null
                    : daysApart(new Date(), row.t_first_payment)
            },
            milestones: {
                firstPaymentAt: row.t_first_payment,
                submittedAt: row.t_submitted,
                approvedAt: row.t_approved,
                paymentCrossAt: row.t_pay_cross
            },
            statusFrom,
            statusTo,
            adminStatus: m['Admin Status'] || null,
            docs,
            diff
        };
    });
}

/**
 * Dataset-wide medians for the three stages the feed shows per row.
 *
 * `Pending -> Submitted` is NOT included: zero invoices have both a
 * `-> Pending` audit row and a `-> Submitted` one, so it cannot be computed.
 * A "form complete" stage is not included either — there is no completion
 * event in the data at all (`Registration Status` is written once, null ->
 * 'Draft', and never advances).
 *
 * Sample sizes are small and approvals are keyed in batches, so each stat
 * returns its own `n` for the UI to show.
 */
async function loadSedaCycleTimes(client) {
    const milestones = `
        WITH seda_ev AS (
            SELECT a.invoice_id, a.edited_at, c->>'after' AS af
            FROM invoice_audit_log a, LATERAL jsonb_array_elements(a.changes) c
            WHERE a.entity_type = 'seda' AND lower(c->>'field') = 'seda_status'
        ),
        ms AS (
            SELECT invoice_id,
                   min(edited_at) FILTER (WHERE af = 'Submitted') AS t_submitted,
                   min(edited_at) FILTER (WHERE af ILIKE 'approved%') AS t_approved
            FROM seda_ev GROUP BY invoice_id
        ),
        -- Running total of every recorded payment against an invoice, so the
        -- point where collection crosses 59% of the invoice total can be dated.
        pay_cum AS (
            SELECT i.id AS invoice_id,
                   p.payment_date,
                   i.total_amount,
                   sum(p.amount) OVER (
                       PARTITION BY i.id ORDER BY p.payment_date, p.id
                   ) AS cum
            FROM invoice i
            JOIN payment p ON p.linked_invoice = i.bubble_id
            WHERE i.total_amount > 0
              AND p.payment_date IS NOT NULL
              AND p.amount IS NOT NULL
        ),
        pay59 AS (
            SELECT invoice_id, min(payment_date) AS t_59
            FROM pay_cum
            WHERE cum >= ${SEDA_PAYMENT_CROSS_RATIO} * total_amount
            GROUP BY invoice_id
        )
    `;

    const stat = (expr, from) => `
        ${milestones}
        SELECT count(*) AS n,
               round(avg(${expr})::numeric, 1) AS avg_days,
               round((percentile_cont(0.5) WITHIN GROUP (ORDER BY ${expr}))::numeric, 1) AS median_days
        FROM ${from}
    `;

    const daysBetween = (a, b) => `extract(epoch FROM (${a} - ${b}))/86400.0`;

    const [payToSubmit, submitToApprove, approveToPay59] = await Promise.all([
        client.query(stat(
            daysBetween('ms.t_submitted', 'i."1st_payment_date"'),
            `ms JOIN invoice i ON i.id = ms.invoice_id
             WHERE ms.t_submitted IS NOT NULL AND i."1st_payment_date" IS NOT NULL`
        )),
        client.query(stat(
            daysBetween('ms.t_approved', 'ms.t_submitted'),
            `ms WHERE ms.t_submitted IS NOT NULL AND ms.t_approved IS NOT NULL`
        )),
        // Signed on purpose: on 12 of the 22 measurable invoices collection
        // already crossed 59% before approval was keyed, so clipping to
        // post-approval only would throw away more than half the sample.
        client.query(`
            ${milestones}
            SELECT count(*) AS n,
                   count(*) FILTER (WHERE pay59.t_59 >= ms.t_approved) AS n_after,
                   round(avg(${daysBetween('pay59.t_59', 'ms.t_approved')})::numeric, 1) AS avg_days,
                   round((percentile_cont(0.5) WITHIN GROUP (
                       ORDER BY ${daysBetween('pay59.t_59', 'ms.t_approved')}))::numeric, 1) AS median_days
            FROM ms JOIN pay59 USING (invoice_id)
            WHERE ms.t_approved IS NOT NULL
        `)
    ]);

    const shape = (r, label, note) => {
        const row = r.rows[0] || {};
        return {
            label,
            note,
            n: Number(row.n || 0),
            avgDays: row.avg_days === null || row.avg_days === undefined ? null : Number(row.avg_days),
            medianDays: row.median_days === null || row.median_days === undefined ? null : Number(row.median_days)
        };
    };

    return [
        shape(payToSubmit, '1st payment → submission',
            'Whole funnel: invoice first payment date to SEDA submission'),
        shape(submitToApprove, 'Submitted → approved',
            'Approval is keyed in batches — treat as recorded date'),
        shape(approveToPay59, `Approved → ${Math.round(SEDA_PAYMENT_CROSS_RATIO * 100)}% collected`,
            `Cumulative payments crossing ${Math.round(SEDA_PAYMENT_CROSS_RATIO * 100)}% of invoice total; `
            + `negative means collection got there first (${Number(approveToPay59.rows[0]?.n_after || 0)} of `
            + `${Number(approveToPay59.rows[0]?.n || 0)} crossed after approval)`)
    ];
}

/* ------------------------------------------------------------------ *
 * FINANCE department — payment lifecycle, split the same way as the
 * INVOICE tabs: who submitted a payment, who verified/corrected it, and
 * who sent the receipt. Reads `invoice_audit_log` for the full history;
 * the receipt feed also reads `activity_log`, the only place a WhatsApp
 * send's success/failure is recorded (see FINANCE_RECEIPT below).
 * ------------------------------------------------------------------ */

/**
 * PAYMENT SUBMISSION — `submitted_payment:insert`, one card per payment
 * claim, enriched with how it was resolved (verified / deleted / still
 * pending), joined on `entity_id` (the `pay_<hex>` id shared across the
 * whole lifecycle — see loadPaymentVerification).
 *
 * Also flags the rare (~6/419 empirically) case where the verified amount
 * doesn't match what was submitted — a real finance signal.
 *
 * @param {object} client - pg client
 * @param {object} opts   - { limit }
 */
/**
 * Per-invoice collection cycle: days from the invoice's 1st payment to the
 * moment cumulative *recorded* payments (the `payment` table — confirmed
 * money, not `submitted_payment` claims) crossed `PAYMENT_CROSS_RATIO` of
 * the invoice total, and days from that crossing to full payment.
 *
 * Same 59% milestone and cumulative-sum technique as `loadSedaCycleTimes`'s
 * `pay_cum`/`pay59` CTEs, just keyed per-invoice instead of aggregated.
 *
 * @param {object} client - pg client
 * @param {number[]} invoiceIds
 * @returns {Promise<Map<number, {tFirst, t59, tFull, daysFirstTo59, days59ToFull}>>}
 */
const PAYMENT_CROSS_RATIO = 0.59;

async function loadPaymentCollectionMilestones(client, invoiceIds) {
    const ids = [...new Set(invoiceIds)].filter((id) => id !== null && id !== undefined);
    if (ids.length === 0) return new Map();

    const sql = `
        WITH pay_cum AS (
            SELECT i.id AS invoice_id,
                   p.payment_date,
                   i.total_amount,
                   i."1st_payment_date" AS t_first,
                   sum(p.amount) OVER (
                       PARTITION BY i.id ORDER BY p.payment_date, p.id
                   ) AS cum
            FROM invoice i
            JOIN payment p ON p.linked_invoice = i.bubble_id
            WHERE i.id = ANY($1::int[])
              AND i.total_amount > 0
              AND p.payment_date IS NOT NULL
              AND p.amount IS NOT NULL
        )
        SELECT invoice_id,
               min(t_first) AS t_first,
               min(payment_date) FILTER (WHERE cum >= ${PAYMENT_CROSS_RATIO} * total_amount) AS t_59,
               min(payment_date) FILTER (WHERE cum >= total_amount - 0.01) AS t_full
        FROM pay_cum
        GROUP BY invoice_id
    `;
    const result = await client.query(sql, [ids]);

    const out = new Map();
    for (const row of result.rows) {
        const tFirst = row.t_first ? new Date(row.t_first) : null;
        const t59 = row.t_59 ? new Date(row.t_59) : null;
        const tFull = row.t_full ? new Date(row.t_full) : null;
        const days = (a, b) => (a && b ? Math.round((b - a) / 86400000 * 10) / 10 : null);

        out.set(row.invoice_id, {
            t59: row.t_59,
            tFull: row.t_full,
            daysFirstTo59: days(tFirst, t59),
            days59ToFull: days(t59, tFull)
        });
    }
    return out;
}

async function loadPaymentSubmission(client, opts = {}) {
    const limit = Math.min(Number(opts.limit) || 60, 200);

    const headSql = `
        SELECT
            a.id,
            a.entity_id,
            a.invoice_id,
            a.invoice_number,
            a.actor_user_id,
            a.actor_name,
            a.actor_role,
            a.source_app,
            a.changes,
            a.edited_at,
            c.name AS customer_name
        FROM invoice_audit_log a
        LEFT JOIN invoice i ON i.id = a.invoice_id
        LEFT JOIN customer c ON c.customer_id = i.linked_customer
        WHERE a.entity_type = 'submitted_payment' AND a.action_type = 'insert'
        ORDER BY a.edited_at DESC
        LIMIT $1
    `;
    const head = await client.query(headSql, [limit]);
    if (head.rows.length === 0) return [];

    const entityIds = head.rows.map((r) => r.entity_id).filter(Boolean);
    const invoiceIds = head.rows.map((r) => r.invoice_id).filter(Boolean);

    const outcomeByEntity = new Map();
    if (entityIds.length > 0) {
        const outcomeSql = `
            SELECT entity_id, entity_type, action_type, changes, edited_at
            FROM invoice_audit_log
            WHERE entity_id = ANY($1::text[])
              AND (
                    (entity_type = 'payment' AND action_type IN ('verify', 'delete'))
                 OR (entity_type = 'submitted_payment' AND action_type = 'delete')
              )
            ORDER BY edited_at ASC
        `;
        const outcomeRes = await client.query(outcomeSql, [entityIds]);
        for (const row of outcomeRes.rows) {
            const m = changeMap(row.changes);
            const outcome = row.entity_type === 'payment' && row.action_type === 'verify' ? 'verified' : 'deleted';
            // Keep the first terminal event per payment — verify/delete only fires once.
            if (!outcomeByEntity.has(row.entity_id)) {
                outcomeByEntity.set(row.entity_id, {
                    outcome,
                    at: row.edited_at,
                    verifiedAmount: m.amount ?? null
                });
            }
        }
    }

    const milestonesByInvoice = await loadPaymentCollectionMilestones(client, invoiceIds);

    return head.rows.map((row) => {
        const m = changeMap(row.changes);
        const resolved = outcomeByEntity.get(row.entity_id) || null;
        const submittedAmount = m.Amount ?? null;
        const amountMismatch =
            resolved && resolved.outcome === 'verified' && resolved.verifiedAmount !== null && submittedAmount !== null
                ? Number(resolved.verifiedAmount) !== Number(submittedAmount)
                : false;
        const milestone = milestonesByInvoice.get(row.invoice_id) || null;

        return {
            id: row.id,
            paymentId: row.entity_id,
            invoiceId: row.invoice_id,
            invoiceNumber: row.invoice_number,
            customerName: row.customer_name || null,
            amount: submittedAmount,
            method: m.Method || null,
            paymentDate: m.Date || null,
            status: resolved ? resolved.outcome : 'pending',
            resolvedAt: resolved ? resolved.at : null,
            amountMismatch,
            verifiedAmount: resolved ? resolved.verifiedAmount : null,
            // Collection cycle for this invoice as a whole (not just this one
            // payment): days from 1st payment to crossing 59% of the invoice
            // total, and from there to full payment. null when that milestone
            // hasn't been reached yet.
            daysFirstTo59: milestone ? milestone.daysFirstTo59 : null,
            days59ToFull: milestone ? milestone.days59ToFull : null,
            crossRatio: PAYMENT_CROSS_RATIO,
            actorUserId: row.actor_user_id,
            actorName: row.actor_name,
            actorRole: row.actor_role,
            sourceApp: row.source_app,
            occurredAt: row.edited_at
        };
    });
}

/**
 * PAYMENT VERIFICATION — field-level `payment:verify|update|delete` events,
 * plus the legacy `verified_payment:insert` rows (pre-2026-05-05 flow,
 * treated as a `verify` action). One entry per audit row, same shape as
 * `loadInvoiceEdit`.
 *
 * `payment:verify` carries no human actor (service-account id `67`,
 * `actor_name` always NULL) — the UI falls back to a generic label.
 * `payment:update` is almost always a `Method` correction (e.g.
 * `CASH -> Online Transfer`) fired seconds before the verify row.
 *
 * @param {object} client - pg client
 * @param {object} opts   - { limit }
 */
async function loadPaymentVerification(client, opts = {}) {
    const limit = Math.min(Number(opts.limit) || 60, 200);

    const sql = `
        SELECT
            a.id,
            a.entity_id,
            a.entity_type,
            a.action_type,
            a.invoice_id,
            a.invoice_number,
            a.actor_user_id,
            a.actor_name,
            a.actor_role,
            a.source_app,
            a.changes,
            a.edited_at,
            c.name AS customer_name
        FROM invoice_audit_log a
        LEFT JOIN invoice i ON i.id = a.invoice_id
        LEFT JOIN customer c ON c.customer_id = i.linked_customer
        WHERE (
                (a.entity_type = 'payment' AND a.action_type IN ('verify', 'update', 'delete'))
             OR (a.entity_type = 'verified_payment' AND a.action_type = 'insert')
        )
          AND jsonb_typeof(a.changes) = 'array'
        ORDER BY a.edited_at DESC
        LIMIT $1
    `;
    const result = await client.query(sql, [limit]);
    if (result.rows.length === 0) return [];

    // How long ago was this payment claim submitted? Joined on entity_id
    // (the `pay_<hex>` id shared with `submitted_payment:insert`) so every
    // verify/update/delete row can show elapsed time since submission, not
    // just the ones on the Submission page.
    const entityIds = result.rows.map((r) => r.entity_id).filter(Boolean);
    const submittedAtByEntity = new Map();
    if (entityIds.length > 0) {
        const subRes = await client.query(
            `SELECT entity_id, min(edited_at) AS submitted_at
             FROM invoice_audit_log
             WHERE entity_type = 'submitted_payment' AND action_type = 'insert'
               AND entity_id = ANY($1::text[])
             GROUP BY entity_id`,
            [entityIds]
        );
        for (const row of subRes.rows) {
            submittedAtByEntity.set(row.entity_id, row.submitted_at);
        }
    }

    return result.rows.map((row) => {
        const changes = Array.isArray(row.changes) ? row.changes : [];
        const isLegacy = row.entity_type === 'verified_payment';

        return {
            id: row.id,
            paymentId: row.entity_id,
            invoiceId: row.invoice_id,
            invoiceNumber: row.invoice_number,
            customerName: row.customer_name || null,
            // Legacy rows are a one-shot insert that already IS the verification.
            action: isLegacy ? 'verify' : row.action_type,
            legacy: isLegacy,
            // null when the submission itself isn't in this window (or predates
            // the submitted_payment flow, e.g. legacy verified_payment rows).
            submittedAt: submittedAtByEntity.get(row.entity_id) || null,
            actorUserId: row.actor_user_id,
            actorName: row.actor_name,
            actorRole: row.actor_role,
            sourceApp: row.source_app,
            occurredAt: row.edited_at,
            changes: changes.map((c) => ({
                field: c.field,
                before: c.before ?? null,
                after: c.after ?? null
            }))
        };
    });
}

/**
 * PAYMENT ACTIVITY — submission + verification merged into one chronological
 * stream, same "guaranteed-complete window" trick as `loadInvoiceAll`: cut
 * the merge at the newest of the two sources' "oldest row reached" so every
 * source is complete inside the returned window (no silent gaps from the
 * sparser source getting truncated first).
 *
 * @param {object} client - pg client
 * @param {object} opts   - { limit }
 * @returns {Promise<Array>} - [{ kind: 'submission'|'verification', occurredAt, ...row }]
 */
async function loadPaymentActivity(client, opts = {}) {
    const limit = Math.min(Number(opts.limit) || 60, 200);
    const perSource = Math.min(limit, 100);

    const [submission, verification] = await Promise.all([
        loadPaymentSubmission(client, { limit: perSource }),
        loadPaymentVerification(client, { limit: perSource })
    ]);

    const tagged = [
        ...submission.map((r) => ({ kind: 'submission', occurredAt: r.occurredAt, row: r })),
        ...verification.map((r) => ({ kind: 'verification', occurredAt: r.occurredAt, row: r }))
    ].filter((e) => e.occurredAt);

    if (tagged.length === 0) return [];

    const oldestPerSource = [submission, verification]
        .map((rows) => {
            if (rows.length < perSource) return null; // source wasn't truncated
            return new Date(rows[rows.length - 1].occurredAt).getTime();
        })
        .filter((t) => t !== null && !Number.isNaN(t));

    const cutoff = oldestPerSource.length ? Math.max(...oldestPerSource) : null;

    let merged = tagged;
    if (cutoff !== null) {
        merged = merged.filter((e) => new Date(e.occurredAt).getTime() >= cutoff);
    }

    merged.sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));

    return merged.slice(0, limit).map((e) => ({
        kind: e.kind,
        occurredAt: e.occurredAt,
        ...e.row
    }));
}

/**
 * PAYMENT VERIFICATION STATS — last-N-days summary for the Payment Activity
 * page: average submit→verify turnaround, and a daily verified-total series
 * for the chart. Independent of the paginated feeds above (those cut off by
 * row count; this always looks back a fixed number of days).
 *
 * @param {object} client - pg client
 * @param {object} opts   - { days } (default 30, max 180)
 */
async function loadPaymentVerificationStats(client, opts = {}) {
    const days = Math.min(Math.max(Number(opts.days) || 30, 1), 180);

    const verifySql = `
        SELECT
            a.entity_id,
            a.edited_at AS verified_at,
            (
                SELECT (elem->>'after')::numeric
                FROM jsonb_array_elements(a.changes) elem
                WHERE elem->>'field' = 'amount'
            ) AS verified_amount
        FROM invoice_audit_log a
        WHERE a.entity_type = 'payment' AND a.action_type = 'verify'
          AND jsonb_typeof(a.changes) = 'array'
          AND a.edited_at >= now() - make_interval(days => $1::int)
        ORDER BY a.edited_at ASC
    `;
    const verifyRes = await client.query(verifySql, [days]);
    const rows = verifyRes.rows;

    // Only rows with a known submission time count toward the turnaround
    // average — legacy/undated payments would silently skew it otherwise.
    const submittedAtByEntity = new Map();
    const entityIds = rows.map((r) => r.entity_id).filter(Boolean);
    if (entityIds.length > 0) {
        const subRes = await client.query(
            `SELECT entity_id, min(edited_at) AS submitted_at
             FROM invoice_audit_log
             WHERE entity_type = 'submitted_payment' AND action_type = 'insert'
               AND entity_id = ANY($1::text[])
             GROUP BY entity_id`,
            [entityIds]
        );
        for (const row of subRes.rows) {
            submittedAtByEntity.set(row.entity_id, row.submitted_at);
        }
    }

    let resolutionSumMs = 0;
    let resolutionCount = 0;
    let verifiedTotal = 0;
    const dailyMap = new Map(); // 'YYYY-MM-DD' -> { total, count }

    for (const row of rows) {
        const submittedAt = submittedAtByEntity.get(row.entity_id);
        if (submittedAt) {
            resolutionSumMs += new Date(row.verified_at) - new Date(submittedAt);
            resolutionCount++;
        }

        const amount = row.verified_amount !== null ? Number(row.verified_amount) : 0;
        verifiedTotal += amount;

        const dayKey = new Date(row.verified_at).toISOString().slice(0, 10);
        const bucket = dailyMap.get(dayKey) || { total: 0, count: 0 };
        bucket.total += amount;
        bucket.count += 1;
        dailyMap.set(dayKey, bucket);
    }

    // Fill every day in the window, including zero-verification days, so the
    // chart's timeline doesn't silently compress gaps.
    const daily = [];
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(today);
        d.setUTCDate(d.getUTCDate() - i);
        const key = d.toISOString().slice(0, 10);
        const bucket = dailyMap.get(key) || { total: 0, count: 0 };
        daily.push({ date: key, total: bucket.total, count: bucket.count });
    }

    return {
        windowDays: days,
        resolvedCount: resolutionCount,
        avgResolutionMs: resolutionCount > 0 ? resolutionSumMs / resolutionCount : null,
        verifiedCount: rows.length,
        verifiedTotal,
        daily
    };
}

/**
 * OFFICIAL RECEIPT — merges two sources, because only one of them knows
 * whether the send actually worked:
 *   - `invoice_audit_log` `payment:receipt_sent_manual` (all history, but
 *     no success/failure signal — it only logs that a WhatsApp number was
 *     targeted).
 *   - `activity_log` `entity_type='receipt', action='send'` (added
 *     2026-07-28, carries `status`/`error_message` from the WhatsApp API —
 *     first data ever recorded here was 35/35 sends FAILED with a 404).
 *
 * @param {object} client - pg client
 * @param {object} opts   - { limit }
 */
async function loadPaymentReceipt(client, opts = {}) {
    const limit = Math.min(Number(opts.limit) || 60, 200);
    const perSource = Math.min(limit, 150);

    const auditSql = `
        SELECT
            a.id, a.entity_id, a.invoice_id, a.invoice_number, a.actor_name,
            a.source_app, a.changes, a.edited_at,
            c.name AS customer_name
        FROM invoice_audit_log a
        LEFT JOIN invoice i ON i.id = a.invoice_id
        LEFT JOIN customer c ON c.customer_id = i.linked_customer
        WHERE a.entity_type = 'payment' AND a.action_type = 'receipt_sent_manual'
        ORDER BY a.edited_at DESC
        LIMIT $1
    `;
    // entity_id on these rows is the numeric invoice id (not the pay_<hex> code,
    // which lives in entity_label here) — join it back to invoice/customer the
    // same way, guarded against any non-numeric entity_id.
    const logSql = `
        SELECT
            l.id, l.entity_id, l.entity_label, l.actor_name, l.actor_role,
            l.status, l.error_message, l.occurred_at, l.metadata,
            i.invoice_number, c.name AS customer_name
        FROM activity_log l
        LEFT JOIN invoice i ON l.entity_id ~ '^[0-9]+$' AND i.id = l.entity_id::int
        LEFT JOIN customer c ON c.customer_id = i.linked_customer
        WHERE l.entity_type = 'receipt' AND l.action = 'send'
        ORDER BY l.occurred_at DESC
        LIMIT $1
    `;

    const [auditRes, logRes] = await Promise.all([
        client.query(auditSql, [perSource]),
        client.query(logSql, [perSource])
    ]);

    const fromAudit = auditRes.rows.map((row) => {
        const m = changeMap(row.changes);
        return {
            source: 'audit',
            id: `audit:${row.id}`,
            paymentId: row.entity_id,
            invoiceId: row.invoice_id,
            invoiceNumber: row.invoice_number,
            customerName: row.customer_name || null,
            sentBy: m.whatsapp_receipt || null,
            status: 'sent',
            errorMessage: null,
            actorName: row.actor_name,
            sourceApp: row.source_app,
            occurredAt: row.edited_at
        };
    });

    const fromLog = logRes.rows.map((row) => ({
        source: 'log',
        id: `log:${row.id}`,
        paymentId: row.entity_label || null,
        invoiceId: row.entity_id ? Number(row.entity_id) : null,
        invoiceNumber: row.invoice_number || null,
        customerName: row.customer_name || null,
        sentBy: row.actor_name || null,
        status: row.status || 'unknown',
        errorMessage: row.error_message || null,
        actorName: row.actor_name,
        sourceApp: 'ee-admin',
        occurredAt: row.occurred_at
    }));

    return [...fromAudit, ...fromLog]
        .sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt))
        .slice(0, limit);
}

module.exports = {
    loadCalculatorActivity,
    loadCalculatorUserSummaries,
    loadSalesAgentActivityBoard,
    loadSalesAgentActivitySummary,
    loadInvoicePrep,
    loadInvoiceEdit,
    loadInvoiceView,
    loadInvoiceAll,
    loadSedaActivity,
    loadSedaCycleTimes,
    loadPaymentSubmission,
    loadPaymentVerification,
    loadPaymentActivity,
    loadPaymentVerificationStats,
    loadPaymentReceipt
};
