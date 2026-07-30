'use strict';

/**
 * Admin Console Activity - reads the shared `activity_log` table for
 * `app='ee-admin'` rows (admin.atap.solar back-office actions).
 *
 * Unlike invoice_audit_log, activity_log:
 * - has complete actor identity (user_id, name, role, ref — all integer-keyed)
 * - includes IP, user_agent, source_url
 * - stores only field *names* in fields[], not before/after values
 * - has pre-rendered human-readable descriptions
 * - 30-day retention (hard-purged), so history is shallow
 *
 * Key design: collapses payment:verify + receipt:send into one lifecycle card
 * (same entity_id, fire in same millisecond).
 */

const PAGE_SIZE_DEFAULT = 80;
const PAGE_SIZE_MAX = 300;

/**
 * Map (entity_type, action) to a presentation area.
 * Per activity_log SOP Rule 4, action has no enum — this must handle unknowns.
 */
function areaForEvent(entityType, action) {
    const pair = `${entityType}:${action}`;

    if (pair === 'invoice:print') return 'print';
    if (pair === 'payment:verify' || pair === 'submitted_payment:update') return 'payment';
    if (pair === 'receipt:send') return 'receipt';
    if (entityType === 'customer') return 'customer';
    if (entityType === 'user') return 'user';
    if (entityType === 'attachment') return 'attachment';
    if (entityType === 'invoice' || entityType === 'invoice_item') return 'invoice';

    return 'other';
}

/**
 * Icon for each area.
 */
const AREA_ICONS = {
    print: '🖨',
    payment: '💳',
    receipt: '🧾',
    customer: '🏠',
    user: '👤',
    attachment: '📎',
    invoice: '✏️',
    other: '📌'
};

/**
 * Does this (entity_type, action) pair have a twin in invoice_audit_log?
 * The 6 pairs that do are the only place the actual human actor is named.
 */
function hasDuplicateInAudit(entityType, action) {
    const pair = `${entityType}:${action}`;
    return ['payment:verify', 'invoice:update', 'invoice_item:update',
            'invoice_item:create', 'invoice_item:delete'].includes(pair);
}

/**
 * Load admin console activity from activity_log WHERE app='ee-admin'.
 *
 * Collapses payment:verify + receipt:send on shared entity_id into one
 * lifecycle card. Resolves invoice/customer names. Flags audit duplicates.
 *
 * @param {object} client - pg client
 * @param {object} opts - { limit, areas: string[], includeDuplicates, cursor }
 * @returns {Promise<{rows, hasMore, nextCursor}>}
 */
async function loadAdminActivity(client, opts = {}) {
    const limit = Math.min(Math.max(parseInt(opts.limit, 10) || PAGE_SIZE_DEFAULT, 1), PAGE_SIZE_MAX);
    const areas = Array.isArray(opts.areas) && opts.areas.length ? opts.areas : null;
    const includeDuplicates = Boolean(opts.includeDuplicates);

    const params = [];
    const clauses = [`app = 'ee-admin'`];

    if (opts.cursor) {
        const [ts, id] = String(opts.cursor).split('|');
        if (ts && id) {
            params.push(ts, id);
            clauses.push(`(occurred_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`);
        }
    }

    const where = clauses.join(' AND ');

    // Over-fetch for collapse + filtering — pull 3× limit so collapse window stays wide
    params.push(limit * 3);

    const sql = `
        SELECT id, entity_type, action, entity_id, entity_label, description,
               fields, status, error_message, source_url, ip, user_agent,
               metadata, actor_user_id, actor_name, actor_role, actor_ref,
               occurred_at
        FROM activity_log
        WHERE ${where}
        ORDER BY occurred_at DESC, id DESC
        LIMIT $${params.length}
    `;

    const { rows: raw } = await client.query(sql, params);

    // Map each to an area and flag duplicates
    const tagged = raw.map(r => ({
        ...r,
        area: areaForEvent(r.entity_type, r.action),
        icon: AREA_ICONS[areaForEvent(r.entity_type, r.action)],
        isDuplicate: hasDuplicateInAudit(r.entity_type, r.action)
    }));

    // Area filter — keep only requested areas (or all if not specified)
    let filtered = tagged;
    if (areas) {
        filtered = tagged.filter(r => areas.includes(r.area));
    }

    // Hide duplicates unless opt-in
    if (!includeDuplicates) {
        filtered = filtered.filter(r => !r.isDuplicate);
    }

    // Collapse payment:verify + receipt:send on shared entity_id
    const collapsed = collapsePaymentReceipts(filtered);

    // Resolve invoice/customer names
    await resolveNames(client, collapsed);

    // Trim to actual limit
    const hasMore = collapsed.length > limit;
    const page = hasMore ? collapsed.slice(0, limit) : collapsed;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last
        ? `${new Date(last.occurred_at).toISOString()}|${last.id}`
        : null;

    return {
        rows: page.map(shapeRow),
        hasMore,
        nextCursor
    };
}

/**
 * Collapse payment:verify + receipt:send rows that share entity_id into one
 * lifecycle card. Walks oldest → newest, pairs them, and returns a merged list.
 */
function collapsePaymentReceipts(rows) {
    const byId = new Map(); // entity_id → { verify, receipt }
    const output = [];

    // Walk newest → oldest (matches input order)
    for (const row of rows) {
        const isVerify = row.entity_type === 'payment' && row.action === 'verify';
        const isReceipt = row.entity_type === 'receipt' && row.action === 'send';

        if (!isVerify && !isReceipt) {
            output.push(row);
            continue;
        }

        const key = row.entity_id;
        if (!key) {
            output.push(row);
            continue;
        }

        const pair = byId.get(key) || {};

        if (isVerify) {
            if (pair.receipt) {
                // Already saw the receipt — collapse now and emit
                output.push(mergePaymentReceipt(row, pair.receipt));
                byId.delete(key);
            } else {
                // First half — hold for pairing
                pair.verify = row;
                byId.set(key, pair);
            }
        } else {
            // isReceipt
            if (pair.verify) {
                // Already saw the verify — collapse and emit
                output.push(mergePaymentReceipt(pair.verify, row));
                byId.delete(key);
            } else {
                // First half
                pair.receipt = row;
                byId.set(key, pair);
            }
        }
    }

    // Unpaired stragglers go through unchanged
    for (const pair of byId.values()) {
        if (pair.verify) output.push(pair.verify);
        if (pair.receipt) output.push(pair.receipt);
    }

    // Re-sort newest first (collapse reordered slightly)
    output.sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at));

    return output;
}

/**
 * Merge payment:verify + receipt:send into one lifecycle card.
 */
function mergePaymentReceipt(verify, receipt) {
    const amount = verify.metadata?.amount || null;
    const method = verify.metadata?.payment_method || null;
    const receiptStatus = receipt.status;
    const receiptError = receipt.error_message || null;

    return {
        ...verify, // keep verify as base (id, occurred_at, actor, etc.)
        area: 'payment', // consolidated area
        icon: '💳',
        entity_type: 'payment_lifecycle',
        action: 'verify_and_receipt',
        title: `Payment verified${amount ? ` (RM${amount})` : ''}`,
        description: `${verify.actor_name || 'Staff'} verified payment${amount ? ` RM${amount}` : ''}${method ? ` via ${method}` : ''} → receipt ${receiptStatus === 'success' ? 'sent' : 'FAILED'}`,
        receiptStatus,
        receiptError,
        // Merge metadata
        metadata: {
            ...verify.metadata,
            receipt_status: receiptStatus,
            receipt_error: receiptError,
            receipt_channel: receipt.metadata?.channel || null,
            receipt_trigger: receipt.metadata?.trigger || null
        },
        // Mark as composite
        isLifecycle: true
    };
}

/**
 * Resolve invoice_number + customer_name for rows that reference invoices.
 * Prefers entity_label, falls back to metadata.invoice_number, then joins.
 */
async function resolveNames(client, rows) {
    // Collect invoice ids and customer ids that need resolution
    const invoiceIds = new Set();
    const customerIds = new Set();

    for (const row of rows) {
        // Invoice number from entity_label or metadata
        if (!row.entity_label && row.metadata?.invoice_number) {
            row.entity_label = row.metadata.invoice_number;
        }

        // If entity is invoice/invoice_item/payment and entity_id looks numeric, collect it
        if (['invoice', 'invoice_item', 'payment', 'payment_lifecycle'].includes(row.entity_type)) {
            const id = parseInt(row.entity_id, 10);
            if (!isNaN(id)) invoiceIds.add(id);
        }

        // Customer entity_id in activity_log is customer_id (text bubble_id)
        if (row.entity_type === 'customer' && row.entity_id) {
            customerIds.add(row.entity_id);
        }
    }

    // Batch-fetch invoice data (for invoice_number + linked_customer)
    let invoiceMap = new Map();
    if (invoiceIds.size > 0) {
        const invSql = `
            SELECT id, bubble_id, invoice_number, linked_customer
            FROM invoice
            WHERE id = ANY($1::int[])
        `;
        const invRes = await client.query(invSql, [Array.from(invoiceIds)]);
        invRes.rows.forEach(r => {
            invoiceMap.set(r.id, r);
            if (r.linked_customer) customerIds.add(r.linked_customer);
        });
    }

    // Batch-fetch customer names — customer_id is TEXT (bubble id)
    let customerMap = new Map();
    if (customerIds.size > 0) {
        const custSql = `
            SELECT customer_id, name
            FROM customer
            WHERE customer_id = ANY($1::text[])
        `;
        const custRes = await client.query(custSql, [Array.from(customerIds)]);
        custRes.rows.forEach(r => customerMap.set(r.customer_id, r.name));
    }

    // Apply resolved names to rows
    for (const row of rows) {
        if (['invoice', 'invoice_item', 'payment', 'payment_lifecycle'].includes(row.entity_type)) {
            const invId = parseInt(row.entity_id, 10);
            const inv = invoiceMap.get(invId);
            if (inv) {
                if (!row.entity_label && inv.invoice_number) {
                    row.entity_label = inv.invoice_number;
                }
                if (inv.linked_customer) {
                    row.customer_name = customerMap.get(inv.linked_customer) || null;
                }
            }
        }

        if (row.entity_type === 'customer') {
            row.customer_name = customerMap.get(row.entity_id) || row.entity_label || null;
        }
    }
}

/**
 * Shape a row into the frontend contract.
 */
function shapeRow(row) {
    return {
        id: row.id,
        area: row.area,
        icon: row.icon,
        entityType: row.entity_type,
        action: row.action,
        title: row.title || row.entity_label || `${row.entity_type} ${row.action}`,
        description: row.description || '',
        invoiceNumber: row.entity_label || null,
        customerName: row.customer_name || null,
        fields: row.fields || [],
        status: row.status || 'success',
        errorMessage: row.error_message || null,
        sourceUrl: row.source_url || null,
        ip: row.ip || null,
        userAgent: row.user_agent || null,
        metadata: row.metadata || {},
        actorUserId: row.actor_user_id,
        actorName: row.actor_name,
        actorRole: row.actor_role,
        actorRef: row.actor_ref,
        isDuplicate: row.isDuplicate || false,
        isLifecycle: row.isLifecycle || false,
        receiptStatus: row.receiptStatus || null,
        receiptError: row.receiptError || null,
        occurredAt: row.occurred_at
    };
}

/**
 * Summary stats for the admin console stat strip.
 * Returns tiles: today vs yesterday, distinct actors today, failures today,
 * per-area counts today.
 */
async function loadAdminSummary(client) {
    const sql = `
        WITH buckets AS (
            SELECT
                id,
                entity_type,
                action,
                status,
                actor_user_id,
                occurred_at >= now() - interval '24 hours' AS is_today,
                occurred_at >= now() - interval '48 hours'
                    AND occurred_at < now() - interval '24 hours' AS is_yesterday
            FROM activity_log
            WHERE app = 'ee-admin'
              AND occurred_at >= now() - interval '48 hours'
        ),
        area_counts AS (
            SELECT entity_type || ':' || action AS pair, count(*) AS n
            FROM buckets
            WHERE is_today
            GROUP BY entity_type, action
        )
        SELECT
            (SELECT count(*) FROM buckets WHERE is_today) AS today,
            (SELECT count(*) FROM buckets WHERE is_yesterday) AS yesterday,
            (SELECT count(DISTINCT actor_user_id) FROM buckets WHERE is_today) AS actors_today,
            (SELECT count(*) FROM buckets WHERE is_today AND status <> 'success') AS failures_today,
            (SELECT jsonb_object_agg(pair, n) FROM area_counts) AS area_counts_today
    `;

    const { rows } = await client.query(sql);
    const row = rows[0] || {};

    const today = Number(row.today || 0);
    const yesterday = Number(row.yesterday || 0);
    const actorsToday = Number(row.actors_today || 0);
    const failuresToday = Number(row.failures_today || 0);

    // Map entity:action counts to areas
    const areaCounts = {};
    if (row.area_counts_today) {
        for (const [pair, count] of Object.entries(row.area_counts_today)) {
            const [entityType, action] = pair.split(':');
            const area = areaForEvent(entityType, action);
            areaCounts[area] = (areaCounts[area] || 0) + Number(count || 0);
        }
    }

    return [
        {
            label: 'Events today',
            value: today,
            sub: yesterday ? `${yesterday} yesterday` : 'no data yesterday',
            note: 'Total activity_log rows from ee-admin'
        },
        {
            label: 'Active staff',
            value: actorsToday,
            sub: `${actorsToday} distinct actor${actorsToday === 1 ? '' : 's'}`,
            note: 'Unique actor_user_id values today'
        },
        {
            label: 'Failures',
            value: failuresToday,
            sub: failuresToday === 0 ? 'all success' : `${failuresToday} failed action${failuresToday === 1 ? '' : 's'}`,
            note: 'Rows with status != success',
            danger: failuresToday > 0
        },
        ...Object.entries(areaCounts).map(([area, count]) => ({
            label: `${AREA_ICONS[area] || '📌'} ${area}`,
            value: count,
            sub: `${count} event${count === 1 ? '' : 's'}`,
            note: `${area} area count today`
        }))
    ];
}

module.exports = {
    loadAdminActivity,
    loadAdminSummary
};
