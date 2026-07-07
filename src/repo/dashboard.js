'use strict';

/**
 * Company-wide "live pulse" dashboard reader.
 *
 * Unlike invoiceFeed.js (one row per invoice), this reads invoice_audit_log
 * as a single cross-invoice stream: today's KPI counters (vs. yesterday),
 * revenue collected/pending, who is looking at an invoice right now, which
 * invoices are getting the most attention, and a chronological "what just
 * happened" feed across the whole book of business.
 *
 * All "today" boundaries use Asia/Kuala_Lumpur (the business's timezone,
 * confirmed against live traffic patterns and RM-denominated amounts).
 */

const { normalizeDetailRow } = require('./invoiceFeed');

const FEED_LIMIT = 50;
const TOP_MOVERS_LIMIT = 6;
const ACTIVE_VIEWER_WINDOW = '15 minutes';
const TOP_MOVERS_WINDOW = '24 hours';

function toDayKey(value) {
    // Postgres `date` values round-trip through the proxy as either
    // 'YYYY-MM-DD' or an ISO timestamp at midnight UTC — either way the
    // first 10 chars are the date we grouped by.
    return String(value).slice(0, 10);
}

function todayYesterdayKeys() {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur' });
    const today = fmt.format(new Date());
    const yesterday = fmt.format(new Date(Date.now() - 24 * 60 * 60 * 1000));
    return { today, yesterday };
}

function pctDelta(today, yesterday) {
    if (!yesterday) return today > 0 ? { direction: 'up', pct: null, label: 'New' } : { direction: 'flat', pct: 0, label: '—' };
    const pct = Math.round(((today - yesterday) / yesterday) * 100);
    if (pct === 0) return { direction: 'flat', pct: 0, label: '0%' };
    return { direction: pct > 0 ? 'up' : 'down', pct, label: `${pct > 0 ? '+' : ''}${pct}%` };
}

const GENERAL_METRICS = [
    { id: 'created', label: 'Invoices Created', pairs: [['invoice', 'insert']] },
    { id: 'edited', label: 'Invoices Edited', pairs: [['invoice', 'update'], ['invoice_item', 'insert'], ['invoice_item', 'update'], ['invoice_item', 'delete'], ['invoice_item', 'create']] },
    { id: 'documents', label: 'Documents Processed', pairs: [['invoice_upload', 'added'], ['seda_upload', 'added'], ['drawing', 'upload']] },
    { id: 'views', label: 'Customer Views', pairs: [['viewer_activity', 'invoice_viewed'], ['viewer_activity', 'proposal_viewed']] }
];

const SEDA_METRICS = [
    { id: 'seda_uploads', label: 'Docs Uploaded', pairs: [['seda_upload', 'added']] },
    { id: 'seda_reg_updates', label: 'Registrations Updated', pairs: [['seda_registration', 'updated']] },
    { id: 'seda_status_changes', label: 'Status Changes', pairs: [['seda', 'update']] }
];

/**
 * Single grouped read of entity_type/action_type counts for today +
 * yesterday (Asia/Kuala_Lumpur) — shared by every "today vs. yesterday" KPI
 * so we don't re-scan invoice_audit_log once per metric group.
 */
async function loadDayBuckets(client) {
    const result = await client.query(
        `SELECT (edited_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS day,
                entity_type, action_type, count(*) AS c
           FROM invoice_audit_log
          WHERE edited_at > now() - interval '3 days'
          GROUP BY 1, 2, 3`
    );

    const { today, yesterday } = todayYesterdayKeys();
    const buckets = { [today]: {}, [yesterday]: {} };

    if (result.rows.length === 0) {
        // 3 days of activity across the whole company coming back empty is
        // never legitimate during business hours — surface it instead of
        // silently rendering an all-zero KPI row.
        console.warn('[dashboard] loadDayBuckets got 0 rows for the last 3 days — likely a transient proxy/DB hiccup, not real zero activity');
    }

    const seenDayKeys = new Set();
    result.rows.forEach((row) => {
        const day = toDayKey(row.day);
        seenDayKeys.add(day);
        if (!buckets[day]) return;
        const key = `${row.entity_type}:${row.action_type}`;
        buckets[day][key] = (buckets[day][key] || 0) + Number(row.c);
    });

    // TEMPORARY DEBUG — remove once the production all-zero KPI bug is root-caused.
    const debug = {
        computedToday: today,
        computedYesterday: yesterday,
        rawRowCount: result.rows.length,
        seenDayKeys: [...seenDayKeys],
        sampleRawDayValues: result.rows.slice(0, 5).map((r) => r.day),
        nodeVersion: process.version,
        resolvedTz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        serverNowIso: new Date().toISOString()
    };

    return { today, yesterday, buckets, debug };
}

function countMetrics(bucketData, metrics) {
    const { today, yesterday, buckets } = bucketData;
    const sumFor = (day, pairs) => pairs.reduce((total, [entity, action]) => total + (buckets[day][`${entity}:${action}`] || 0), 0);

    return metrics.map((metric) => {
        const t = sumFor(today, metric.pairs);
        const y = sumFor(yesterday, metric.pairs);
        return {
            id: metric.id,
            label: metric.label,
            today: t,
            yesterday: y,
            delta: pctDelta(t, y)
        };
    });
}

/**
 * Revenue collected (verified payments) and pending (submitted, unverified),
 * today vs. yesterday, plus outstanding balance.
 *
 * "Outstanding" only counts invoices that have at least one payment amount
 * > 0 recorded against them (a submitted or verified payment) — an invoice
 * that has never had a payment made against it is a quote/draft still in
 * progress, not a receivable, so its full balance would overstate what's
 * actually owed.
 */
async function loadRevenue(client) {
    const { today, yesterday } = todayYesterdayKeys();

    const [amountsResult, outstandingResult] = await Promise.all([
        client.query(
            `SELECT (edited_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS day,
                    entity_type, sum((c ->> 'after')::numeric) AS total, count(*) AS n
               FROM invoice_audit_log, LATERAL jsonb_array_elements(changes::jsonb) c
              WHERE entity_type IN ('payment', 'submitted_payment')
                AND ((entity_type = 'payment' AND action_type = 'verify')
                     OR (entity_type = 'submitted_payment' AND action_type = 'insert'))
                AND lower(c ->> 'field') = 'amount'
                AND c ->> 'after' ~ '^[0-9]+(\\.[0-9]+)?$'
                AND edited_at > now() - interval '3 days'
              GROUP BY 1, 2`
        ),
        client.query(
            `WITH paid_invoices AS (
                SELECT DISTINCT a.invoice_id
                  FROM invoice_audit_log a, LATERAL jsonb_array_elements(a.changes::jsonb) c
                 WHERE a.entity_type IN ('payment', 'submitted_payment')
                   AND ((a.entity_type = 'payment' AND a.action_type = 'verify')
                        OR (a.entity_type = 'submitted_payment' AND a.action_type = 'insert'))
                   AND lower(c ->> 'field') = 'amount'
                   AND c ->> 'after' ~ '^[0-9]+(\\.[0-9]+)?$'
                   AND (c ->> 'after')::numeric > 0
             )
             SELECT count(*) AS n, sum(i.balance_due) AS total_balance
               FROM paid_invoices p
               JOIN invoice i ON i.id = p.invoice_id
              WHERE i.is_deleted IS NOT TRUE AND i.status IS DISTINCT FROM 'deleted'`
        )
    ]);

    const buckets = { [today]: {}, [yesterday]: {} };
    amountsResult.rows.forEach((row) => {
        const day = toDayKey(row.day);
        if (!buckets[day]) return;
        buckets[day][row.entity_type] = { total: Number(row.total) || 0, n: Number(row.n) || 0 };
    });

    const verifiedToday = buckets[today].payment || { total: 0, n: 0 };
    const verifiedYesterday = buckets[yesterday].payment || { total: 0, n: 0 };
    const pendingToday = buckets[today].submitted_payment || { total: 0, n: 0 };

    return {
        collected_today: verifiedToday.total,
        collected_today_count: verifiedToday.n,
        collected_delta: pctDelta(verifiedToday.total, verifiedYesterday.total),
        pending_today: pendingToday.total,
        pending_today_count: pendingToday.n,
        outstanding_total: Number(outstandingResult.rows[0]?.total_balance) || 0,
        outstanding_invoices: Number(outstandingResult.rows[0]?.n) || 0
    };
}

/**
 * Viewers active on an invoice/proposal in the last 15 minutes — the
 * "someone is looking at this right now" signal.
 */
async function loadActiveViewers(client) {
    const result = await client.query(
        `SELECT DISTINCT ON (a.invoice_id, a.actor_phone)
                a.invoice_id, a.actor_name, a.actor_phone, a.action_type, a.edited_at,
                i.invoice_number, cu.name AS customer_name
           FROM invoice_audit_log a
           LEFT JOIN invoice i ON i.id = a.invoice_id
           LEFT JOIN customer cu ON cu.customer_id = i.linked_customer
          WHERE a.entity_type = 'viewer_activity'
            AND a.edited_at > now() - interval '${ACTIVE_VIEWER_WINDOW}'
          ORDER BY a.invoice_id, a.actor_phone, a.edited_at DESC
          LIMIT 20`
    );

    return result.rows
        .map((row) => ({
            invoice_id: row.invoice_id,
            invoice_number: row.invoice_number || (row.invoice_id ? `#${row.invoice_id}` : null),
            customer_name: row.customer_name || row.actor_name || 'Unknown visitor',
            is_active_now: row.action_type === 'invoice_viewed' || row.action_type === 'proposal_viewed',
            last_action: row.action_type,
            edited_at: row.edited_at
        }))
        .sort((a, b) => new Date(b.edited_at) - new Date(a.edited_at));
}

/**
 * Invoices with the most audit-log activity in the last 24 hours — "what's
 * moving" at a glance.
 */
async function loadTopMovers(client) {
    const result = await client.query(
        `WITH recent AS (
            SELECT invoice_id,
                   count(*) AS event_count,
                   max(edited_at) AS last_activity,
                   (array_agg(action_type ORDER BY edited_at DESC))[1] AS last_action,
                   (array_agg(entity_type ORDER BY edited_at DESC))[1] AS last_entity
              FROM invoice_audit_log
             WHERE edited_at > now() - interval '${TOP_MOVERS_WINDOW}'
               AND invoice_id IS NOT NULL
             GROUP BY invoice_id
         )
         SELECT r.invoice_id, r.event_count, r.last_activity, r.last_action, r.last_entity,
                i.invoice_number, i.total_amount, cu.name AS customer_name
           FROM recent r
           JOIN invoice i ON i.id = r.invoice_id
           LEFT JOIN customer cu ON cu.customer_id = i.linked_customer
          ORDER BY r.event_count DESC
          LIMIT ${TOP_MOVERS_LIMIT}`
    );

    const { categorizeAction } = require('./invoiceFeed');
    return result.rows.map((row) => {
        const { category, label } = categorizeAction(row.last_action, row.last_entity);
        return {
            invoice_id: row.invoice_id,
            invoice_number: row.invoice_number || `#${row.invoice_id}`,
            customer_name: row.customer_name || null,
            total_amount: row.total_amount !== null ? Number(row.total_amount) : null,
            event_count: Number(row.event_count),
            last_activity: row.last_activity,
            last_category: category,
            last_label: label
        };
    });
}

/**
 * The raw chronological "company dynamics" feed — every entity type, every
 * invoice, newest first. This is the centerpiece: proof the system captures
 * everything as it happens.
 */
async function loadLiveFeed(client) {
    const result = await client.query(
        `SELECT a.id, a.invoice_id, a.entity_type, a.action_type, a.changes,
                a.actor_name, a.actor_phone, a.actor_role,
                a.source_app, a.application_name, a.db_user, a.client_addr,
                a.edited_at,
                i.invoice_number, cu.name AS customer_name
           FROM invoice_audit_log a
           LEFT JOIN invoice i ON i.id = a.invoice_id
           LEFT JOIN customer cu ON cu.customer_id = i.linked_customer
          ORDER BY a.edited_at DESC
          LIMIT ${FEED_LIMIT}`
    );

    return result.rows.map((row) => ({
        ...normalizeDetailRow(row),
        invoice_id: row.invoice_id,
        invoice_number: row.invoice_number || (row.invoice_id ? `#${row.invoice_id}` : null),
        customer_name: row.customer_name || null
    }));
}

function safeJson(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch (err) {
        return null;
    }
}

/**
 * Snapshot of where SEDA (solar rebate) registrations sit in the government
 * approval pipeline — only counting registrations that have actually
 * entered the process (excludes invoices with no seda_status at all, which
 * just means the customer never opted into a SEDA application).
 */
async function loadSedaPipeline(client) {
    const result = await client.query(
        `SELECT trim(seda_status) AS status, count(*) AS c
           FROM seda_registration
          WHERE seda_status IS NOT NULL AND trim(seda_status) <> ''
          GROUP BY 1`
    );

    const stages = { pending: 0, submitted: 0, approved: 0, other: 0 };
    result.rows.forEach((row) => {
        const v = String(row.status || '').toLowerCase();
        const n = Number(row.c) || 0;
        if (v.includes('approved')) stages.approved += n;
        else if (v === 'submitted') stages.submitted += n;
        else if (v === 'pending') stages.pending += n;
        else stages.other += n;
    });

    return stages;
}

/**
 * Most recent SEDA status transitions (Pending -> Submitted -> Approved) —
 * the government-facing side of the tracking system, shown as a before/after
 * feed so it reads as "the system is watching this workflow field by field".
 */
async function loadSedaTransitions(client) {
    const result = await client.query(
        `SELECT a.invoice_id, a.changes, a.edited_at, i.invoice_number, cu.name AS customer_name
           FROM invoice_audit_log a
           LEFT JOIN invoice i ON i.id = a.invoice_id
           LEFT JOIN customer cu ON cu.customer_id = i.linked_customer
          WHERE a.entity_type = 'seda'
          ORDER BY a.edited_at DESC
          LIMIT 8`
    );

    return result.rows.map((row) => {
        const changes = safeJson(row.changes);
        const statusChange = (Array.isArray(changes) ? changes : []).find((c) => String(c?.field || '').toLowerCase() === 'seda_status') || {};
        return {
            invoice_id: row.invoice_id,
            invoice_number: row.invoice_number || (row.invoice_id ? `#${row.invoice_id}` : null),
            customer_name: row.customer_name || null,
            before: statusChange.before || null,
            after: statusChange.after || null,
            edited_at: row.edited_at
        };
    });
}

async function loadDashboard(client) {
    const bucketData = await loadDayBuckets(client);

    const [revenue, activeViewers, topMovers, feed, sedaPipeline, sedaTransitions] = await Promise.all([
        loadRevenue(client),
        loadActiveViewers(client),
        loadTopMovers(client),
        loadLiveFeed(client),
        loadSedaPipeline(client),
        loadSedaTransitions(client)
    ]);

    return {
        generatedAt: new Date().toISOString(),
        kpis: countMetrics(bucketData, GENERAL_METRICS),
        revenue,
        activeViewers,
        topMovers,
        feed,
        seda: {
            kpis: countMetrics(bucketData, SEDA_METRICS),
            pipeline: sedaPipeline,
            transitions: sedaTransitions
        },
        _debug: bucketData.debug
    };
}

module.exports = {
    loadDashboard
};
