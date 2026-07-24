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
    // Postgres `date` values arrive differently depending on DB_MODE:
    // - proxy mode (HTTP + JSON): a string, either 'YYYY-MM-DD' or an ISO
    //   timestamp at midnight UTC.
    // - direct mode (real pg.Pool): node-postgres parses SQL `date` columns
    //   into a native JS Date object. String(dateObject) calls .toString()
    //   ("Tue Jul 07 2026...", NOT ISO), which silently produced the wrong
    //   key and made every day-bucketed KPI read as zero in production.
    if (value instanceof Date) return value.toISOString().slice(0, 10);
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

// Newer audit-log types, each surfaced as its own KPI + section below.
const RECEIPT_METRICS = [
    { id: 'receipts_sent', label: 'Receipts Sent', pairs: [['payment', 'receipt_sent_manual']] }
];

const SEDA_REG_METRICS = [
    { id: 'new_registrations', label: 'New Registrations', pairs: [['seda_registration', 'insert']] }
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

    result.rows.forEach((row) => {
        const day = toDayKey(row.day);
        if (!buckets[day]) return;
        const key = `${row.entity_type}:${row.action_type}`;
        buckets[day][key] = (buckets[day][key] || 0) + Number(row.c);
    });

    return { today, yesterday, buckets };
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

/**
 * Payment receipts that were manually sent to the customer
 * (`entity_type='payment'`, `action_type='receipt_sent_manual'`) — a newer
 * audit-log type. The single change field `whatsapp_receipt` records the
 * channel/agent the receipt went out through (e.g. "Agent: 60162147294").
 */
async function loadReceiptsSent(client) {
    const result = await client.query(
        `SELECT a.id, a.invoice_id, a.changes, a.actor_name, a.edited_at,
                i.invoice_number, cu.name AS customer_name
           FROM invoice_audit_log a
           LEFT JOIN invoice i ON i.id = a.invoice_id
           LEFT JOIN customer cu ON cu.customer_id = i.linked_customer
          WHERE a.entity_type = 'payment' AND a.action_type = 'receipt_sent_manual'
          ORDER BY a.edited_at DESC
          LIMIT 12`
    );

    return result.rows.map((row) => {
        const changes = safeJson(row.changes);
        const receipt = (Array.isArray(changes) ? changes : []).find((c) => String(c?.field || '').toLowerCase() === 'whatsapp_receipt') || {};
        const via = String(receipt.after || '').replace(/^\s*agent:\s*/i, '').trim();
        return {
            invoice_id: row.invoice_id,
            invoice_number: row.invoice_number || (row.invoice_id ? `#${row.invoice_id}` : null),
            customer_name: row.customer_name || null,
            sent_by: row.actor_name || null,
            agent_phone: via || null,
            edited_at: row.edited_at
        };
    });
}

/**
 * Newly created SEDA registrations (`entity_type='seda_registration'`,
 * `action_type='insert'`) — a newer audit-log type, distinct from the
 * existing `seda_registration:updated` status edits already in SEDA Activity.
 * Each insert records the starting Registration/Admin status.
 */
async function loadNewSedaRegistrations(client) {
    const result = await client.query(
        `SELECT a.id, a.invoice_id, a.changes, a.edited_at,
                i.invoice_number, cu.name AS customer_name
           FROM invoice_audit_log a
           LEFT JOIN invoice i ON i.id = a.invoice_id
           LEFT JOIN customer cu ON cu.customer_id = i.linked_customer
          WHERE a.entity_type = 'seda_registration' AND a.action_type = 'insert'
          ORDER BY a.edited_at DESC
          LIMIT 12`
    );

    return result.rows.map((row) => {
        const changes = safeJson(row.changes);
        const arr = Array.isArray(changes) ? changes : [];
        const field = (name) => {
            const f = arr.find((c) => String(c?.field || '').toLowerCase() === name.toLowerCase());
            return f ? (f.after ?? null) : null;
        };
        return {
            invoice_id: row.invoice_id,
            invoice_number: row.invoice_number || (row.invoice_id ? `#${row.invoice_id}` : null),
            customer_name: row.customer_name || null,
            registration_status: field('Registration Status'),
            admin_status: field('Admin Status'),
            edited_at: row.edited_at
        };
    });
}

/**
 * Referral product's AI Assistant web-chat activity — read from the
 * standard multi-channel `et_messages` log (`channel = 'webchat'`), same
 * `prod_main` database this whole dashboard already reads. Content is
 * deliberately never selected or returned here: this is an activity signal
 * (message counts, conversation threads, timestamps), not a chat viewer.
 *
 * `channel='whatsapp'` rows in the same table are historical only (Referral
 * retired WhatsApp) — this reads webchat exclusively, and rows only start
 * appearing once the webchat route's backend logging ships; there is no
 * historical backfill for webchat.
 */
function maskWebchatPhone(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length < 4) return '••••';
    return `•••• ${digits.slice(-4)}`;
}

async function loadReferralWebchatBuckets(client) {
    const result = await client.query(
        `WITH msgs AS (
            SELECT (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS day,
                   LEAST(sender_phone, recipient_phone) || '|' || GREATEST(sender_phone, recipient_phone) AS thread_key
              FROM et_messages
             WHERE channel = 'webchat'
               AND created_at > now() - interval '3 days'
         )
         SELECT day, count(*) AS message_count, count(DISTINCT thread_key) AS thread_count
           FROM msgs
          GROUP BY 1`
    );

    const { today, yesterday } = todayYesterdayKeys();
    const buckets = { [today]: { messages: 0, threads: 0 }, [yesterday]: { messages: 0, threads: 0 } };
    result.rows.forEach((row) => {
        const day = toDayKey(row.day);
        if (!buckets[day]) return;
        buckets[day] = { messages: Number(row.message_count) || 0, threads: Number(row.thread_count) || 0 };
    });

    const t = buckets[today];
    const y = buckets[yesterday];
    return [
        { id: 'webchat_messages', label: 'Webchat Messages', today: t.messages, yesterday: y.messages, delta: pctDelta(t.messages, y.messages) },
        { id: 'webchat_conversations', label: 'Active Conversations', today: t.threads, yesterday: y.threads, delta: pctDelta(t.threads, y.threads) }
    ];
}

async function loadReferralWebchatThreads(client) {
    const result = await client.query(
        `SELECT direction, sender_phone, recipient_phone, created_at
           FROM et_messages
          WHERE channel = 'webchat'
          ORDER BY created_at DESC
          LIMIT 300`
    );

    const threads = new Map();
    result.rows.forEach((row) => {
        const a = row.sender_phone || '';
        const b = row.recipient_phone || '';
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        const customerPhone = /^60\d{8,11}$/.test(a) ? a : (/^60\d{8,11}$/.test(b) ? b : (a || b));

        let entry = threads.get(key);
        if (!entry) {
            // First row seen per key is the newest (rows arrive DESC by created_at).
            entry = { customerPhone, messageCount: 0, lastDirection: row.direction, lastActivity: row.created_at };
            threads.set(key, entry);
        }
        entry.messageCount += 1;
    });

    return Array.from(threads.values())
        .sort((x, y) => new Date(y.lastActivity) - new Date(x.lastActivity))
        .slice(0, 20)
        .map((t) => ({
            phone_masked: maskWebchatPhone(t.customerPhone),
            message_count: t.messageCount,
            last_direction: t.lastDirection,
            last_activity: t.lastActivity
        }));
}

async function loadReferralWebchat(client) {
    const [kpis, threads] = await Promise.all([
        loadReferralWebchatBuckets(client),
        loadReferralWebchatThreads(client)
    ]);
    return { kpis, threads };
}

/**
 * Events-per-minute over the last 60 minutes — the "is the system breathing"
 * pulse for the live wall. Cheap (indexed on edited_at, small grouped result).
 * Empty minutes are zero-filled in JS so the graph is a continuous 60-bar
 * shape. Uses the same Asia/Kuala_Lumpur convention as the day buckets.
 */
async function loadActivityPulse(client) {
    const result = await client.query(
        `SELECT date_trunc('minute', edited_at AT TIME ZONE 'Asia/Kuala_Lumpur') AS minute,
                count(*) AS c
           FROM invoice_audit_log
          WHERE edited_at > now() - interval '60 minutes'
          GROUP BY 1
          ORDER BY 1`
    );

    // Key observed counts by 'YYYY-MM-DDTHH:MM' (KL local, from the shifted timestamp).
    const counts = new Map();
    result.rows.forEach((row) => {
        const key = String(row.minute instanceof Date ? row.minute.toISOString() : row.minute).slice(0, 16);
        counts.set(key, Number(row.c) || 0);
    });

    // Build 60 contiguous minute buckets ending at "now" (KL local minute).
    const nowMs = Date.now();
    const buckets = [];
    for (let i = 59; i >= 0; i--) {
        const d = new Date(nowMs - i * 60 * 1000);
        // Shift to KL (UTC+8) so the key matches the DB's AT TIME ZONE output.
        const kl = new Date(d.getTime() + 8 * 60 * 60 * 1000);
        const key = kl.toISOString().slice(0, 16);
        buckets.push({ minute: d.toISOString(), count: counts.get(key) || 0 });
    }

    const sumRange = (fromEnd, len) => buckets.slice(buckets.length - fromEnd, buckets.length - fromEnd + len).reduce((s, b) => s + b.count, 0);
    const eventsLastMin = buckets[buckets.length - 1].count;
    const eventsLastHour = buckets.reduce((s, b) => s + b.count, 0);
    const recent5 = sumRange(5, 5);   // last 5 minutes
    const prior5 = sumRange(10, 5);   // the 5 minutes before that
    const trend = recent5 > prior5 ? 'up' : (recent5 < prior5 ? 'down' : 'flat');
    const peak = buckets.reduce((m, b) => Math.max(m, b.count), 0);

    return { buckets, eventsLastMin, eventsLastHour, recent5, prior5, trend, peak };
}

/**
 * Six semantic business categories for the live wall dashboard. Each maps one
 * or more entity_type values from invoice_audit_log to a human-friendly group
 * with icon, label, and top action breakdowns.
 */
const CATEGORY_DEFS = [
    {
        id: 'customer_views',
        label: 'Customer Views',
        icon: '👁',
        entityTypes: ['viewer_activity'],
        topActions: ['invoice_viewed', 'invoice_session_ended', 'invoice_button_clicked', 'proposal_viewed']
    },
    {
        id: 'invoices',
        label: 'Invoices',
        icon: '📄',
        entityTypes: ['invoice'],
        topActions: ['update', 'insert']
    },
    {
        id: 'line_items',
        label: 'Line Items',
        icon: '📝',
        entityTypes: ['invoice_item'],
        topActions: ['insert', 'update', 'delete', 'create']
    },
    {
        id: 'payments',
        label: 'Payments',
        icon: '💰',
        entityTypes: ['payment', 'submitted_payment', 'verified_payment'],
        topActions: ['verify', 'insert', 'update', 'delete']
    },
    {
        id: 'documents',
        label: 'Documents',
        icon: '📎',
        entityTypes: ['invoice_upload', 'seda_upload', 'drawing'],
        topActions: ['added', 'upload', 'deleted']
    },
    {
        id: 'seda',
        label: 'SEDA',
        icon: '🏛',
        entityTypes: ['seda', 'seda_registration'],
        topActions: ['insert', 'updated', 'update']
    }
];

/**
 * Load category-grouped activity: today/yesterday counts, action breakdowns,
 * 14-day sparklines, and last activity timestamp for each of the six semantic
 * categories. Powers the live wall's category cards.
 */
async function loadCategories(client) {
    const [dayData, sparklineData, lastActivityData] = await Promise.all([
        // Today + yesterday entity/action counts
        client.query(
            `SELECT (edited_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS day,
                    entity_type, action_type, count(*) AS c
               FROM invoice_audit_log
              WHERE edited_at > now() - interval '3 days'
              GROUP BY 1, 2, 3`
        ),
        // 14-day daily series per entity_type for sparklines
        client.query(
            `SELECT (edited_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS day,
                    entity_type, count(*) AS c
               FROM invoice_audit_log
              WHERE edited_at > now() - interval '14 days'
              GROUP BY 1, 2
              ORDER BY 1 DESC`
        ),
        // Last activity per entity_type
        client.query(
            `SELECT entity_type, max(edited_at) AS last_activity
               FROM invoice_audit_log
              WHERE edited_at > now() - interval '24 hours'
              GROUP BY 1`
        )
    ]);

    const { today, yesterday } = todayYesterdayKeys();

    // Build day buckets: { day: { 'entity:action': count } }
    const dayBuckets = { [today]: {}, [yesterday]: {} };
    dayData.rows.forEach((row) => {
        const day = toDayKey(row.day);
        if (!dayBuckets[day]) return;
        const key = `${row.entity_type}:${row.action_type}`;
        dayBuckets[day][key] = (dayBuckets[day][key] || 0) + Number(row.c);
    });

    // Build sparkline buckets: { entity_type: { day: count } }
    const sparklineBuckets = {};
    sparklineData.rows.forEach((row) => {
        const day = toDayKey(row.day);
        const et = row.entity_type;
        if (!sparklineBuckets[et]) sparklineBuckets[et] = {};
        sparklineBuckets[et][day] = Number(row.c) || 0;
    });

    // Build last activity map: { entity_type: iso_timestamp }
    const lastActivityMap = {};
    lastActivityData.rows.forEach((row) => {
        lastActivityMap[row.entity_type] = row.last_activity;
    });

    // Generate 14 contiguous day keys (today back to 13 days ago)
    const days14 = [];
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur' });
    for (let i = 0; i < 14; i++) {
        days14.push(fmt.format(new Date(Date.now() - i * 24 * 60 * 60 * 1000)));
    }
    days14.reverse(); // oldest first

    return CATEGORY_DEFS.map((def) => {
        // Sum today/yesterday across all entity types in this category
        let todayTotal = 0;
        let yesterdayTotal = 0;
        def.entityTypes.forEach((et) => {
            def.topActions.forEach((action) => {
                const key = `${et}:${action}`;
                todayTotal += dayBuckets[today][key] || 0;
                yesterdayTotal += dayBuckets[yesterday][key] || 0;
            });
        });

        // Action breakdown: sum today's counts per action across category's entity types
        const actionCounts = {};
        def.entityTypes.forEach((et) => {
            def.topActions.forEach((action) => {
                const key = `${et}:${action}`;
                const count = dayBuckets[today][key] || 0;
                actionCounts[action] = (actionCounts[action] || 0) + count;
            });
        });

        const actions = Object.entries(actionCounts)
            .filter(([, count]) => count > 0)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([action, count]) => {
                const { label } = require('./invoiceFeed').categorizeAction(action, def.entityTypes[0]);
                return { label, count };
            });

        // 14-day sparkline: sum across all entity types in this category
        const sparkline = days14.map((day) => {
            let sum = 0;
            def.entityTypes.forEach((et) => {
                sum += (sparklineBuckets[et] && sparklineBuckets[et][day]) || 0;
            });
            return sum;
        });

        // Last activity: most recent across all entity types in this category
        const lastActivities = def.entityTypes.map((et) => lastActivityMap[et]).filter(Boolean);
        const lastActivity = lastActivities.length > 0 ? lastActivities.reduce((a, b) => (a > b ? a : b)) : null;

        return {
            id: def.id,
            label: def.label,
            icon: def.icon,
            today: todayTotal,
            yesterday: yesterdayTotal,
            delta: pctDelta(todayTotal, yesterdayTotal),
            actions,
            sparkline,
            lastActivity
        };
    });
}

/**
 * Lightweight payload for the /live.html wall board, safe to poll every few
 * seconds. Runs ONLY cheap, index-friendly reads — deliberately skips
 * loadRevenue (its LATERAL jsonb scan + outstanding-balance join is what makes
 * loadDashboard slow). KPI counters are the same today-vs-yesterday counts the
 * mobile dashboard shows, derived from the single shared loadDayBuckets read.
 */
async function loadLive(client) {
    const bucketData = await loadDayBuckets(client);

    const [categories, feed, activeViewers, pulse] = await Promise.all([
        loadCategories(client),
        loadLiveFeed(client),
        loadActiveViewers(client),
        loadActivityPulse(client)
    ]);

    // Augment feed items with category_id for frontend filtering
    const entityToCategory = new Map();
    CATEGORY_DEFS.forEach((def) => {
        def.entityTypes.forEach((et) => entityToCategory.set(et, def.id));
    });
    feed.forEach((item) => {
        item.category_id = entityToCategory.get(item.entity_type) || 'other';
    });

    return {
        generatedAt: new Date().toISOString(),
        categories,
        kpis: countMetrics(bucketData, GENERAL_METRICS),
        seda: countMetrics(bucketData, SEDA_METRICS),
        receipts: countMetrics(bucketData, RECEIPT_METRICS),
        newRegistrations: countMetrics(bucketData, SEDA_REG_METRICS),
        feed,
        activeViewers,
        pulse
    };
}

async function loadDashboard(client) {
    const bucketData = await loadDayBuckets(client);

    const [revenue, activeViewers, topMovers, feed, sedaPipeline, sedaTransitions, receiptsSent, newSedaRegistrations, referralWebchat] = await Promise.all([
        loadRevenue(client),
        loadActiveViewers(client),
        loadTopMovers(client),
        loadLiveFeed(client),
        loadSedaPipeline(client),
        loadSedaTransitions(client),
        loadReceiptsSent(client),
        loadNewSedaRegistrations(client),
        loadReferralWebchat(client)
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
        receipts: {
            kpis: countMetrics(bucketData, RECEIPT_METRICS),
            list: receiptsSent
        },
        newSedaRegistrations: {
            kpis: countMetrics(bucketData, SEDA_REG_METRICS),
            list: newSedaRegistrations
        },
        referralWebchat
    };
}

module.exports = {
    loadDashboard,
    loadLive
};
