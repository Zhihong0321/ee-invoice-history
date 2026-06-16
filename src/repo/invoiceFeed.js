'use strict';

/**
 * Invoice feed + detail reader for the browse/search overhaul.
 *
 * Two reads, both keyed off the reliable integer `invoice_id` FK that is
 * present on essentially every `invoice_audit_log` row (verified across all
 * 11 entity types in prod_main):
 *
 *   listInvoices()      one row per invoice, sorted by most-recent activity,
 *                       each carrying its latest action + a total event count.
 *                       Powers the front-page feed and text search.
 *
 *   loadInvoiceDetail() every audit log row for a single invoice, normalized
 *                       for the timeline (edits, items, views, payments,
 *                       SEDA, uploads — the lot).
 *
 * Customer names resolve through invoice.linked_customer -> customer.customer_id
 * (~91% coverage); the snapshot columns on `invoice` are effectively empty so
 * they are not used.
 */

const PAGE_SIZE = 25;
const DETAIL_LIMIT = 1000;

// ---------- small value helpers ----------

function trimOrNull(value) {
    if (value === null || value === undefined) return null;
    const s = String(value).trim();
    return s.length > 0 ? s : null;
}

function stringifyValue(value) {
    if (value === null || value === undefined || value === '') return 'Empty';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
        return value.length > 0 ? value.map(stringifyValue).join(', ') : 'Empty';
    }
    try {
        return JSON.stringify(value);
    } catch (err) {
        return String(value);
    }
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

function getChangeField(changes, field) {
    if (!Array.isArray(changes)) return null;
    const hit = changes.find((c) => String(c?.field || '').toLowerCase() === field);
    return hit ? hit.after : null;
}

// ---------- action categorisation (drives icon + colour in the UI) ----------

/**
 * Map a raw audit action_type onto a small set of display categories.
 * Returns { category, label } where category is one of:
 * created | updated | deleted | viewed | session | click | payment | other
 */
function categorizeAction(rawAction, entityType) {
    const a = String(rawAction || '').trim().toLowerCase();
    const e = String(entityType || '').trim().toLowerCase();

    if (a === 'invoice_viewed' || a === 'proposal_viewed') return { category: 'viewed', label: 'Viewed' };
    if (a.endsWith('session_ended')) return { category: 'session', label: 'Session ended' };
    if (a.endsWith('button_clicked')) return { category: 'click', label: 'Button clicked' };

    if (e.includes('payment')) {
        if (['insert', 'create', 'created', 'added', 'verify', 'verified'].includes(a)) {
            return { category: 'payment', label: a === 'verify' || a === 'verified' ? 'Payment verified' : 'Payment recorded' };
        }
    }

    if (['insert', 'create', 'created', 'add', 'added'].includes(a)) return { category: 'created', label: 'Added' };
    if (['delete', 'deleted', 'remove', 'removed'].includes(a)) return { category: 'deleted', label: 'Removed' };
    if (['update', 'updated', 'edit', 'edited', 'change', 'changed'].includes(a)) return { category: 'updated', label: 'Updated' };
    if (a === 'verify' || a === 'verified') return { category: 'payment', label: 'Verified' };

    return { category: 'other', label: rawAction ? String(rawAction).replace(/_/g, ' ') : 'Activity' };
}

// ---------- change-set parsing (edits) ----------

function normalizeChanges(rawChanges) {
    const parsed = safeJson(rawChanges);
    if (Array.isArray(parsed)) {
        return parsed.map((change) => ({
            field: trimOrNull(change?.field || change?.name || change?.column) || 'Updated value',
            before: stringifyValue(change?.before ?? change?.old ?? change?.from ?? null),
            after: stringifyValue(change?.after ?? change?.new ?? change?.to ?? null)
        }));
    }
    if (parsed && typeof parsed === 'object') {
        return Object.entries(parsed).map(([field, value]) => ({
            field,
            before: stringifyValue(value?.before ?? value?.old ?? null),
            after: stringifyValue(value?.after ?? value?.new ?? value)
        }));
    }
    return [];
}

// ---------- viewer-activity friendly summary ----------

function summarizeViewerActivity(action, changes) {
    const duration = Number(getChangeField(changes, 'duration_seconds'));
    const pageType = trimOrNull(getChangeField(changes, 'page_type'));
    const button = trimOrNull(getChangeField(changes, 'button_name'));
    const target = pageType ? pageType.replace(/_/g, ' ') : 'invoice';

    if (action === 'invoice_viewed' || action === 'proposal_viewed') {
        return `Opened the ${target}`;
    }
    if (action.endsWith('session_ended')) {
        if (Number.isFinite(duration) && duration > 0) {
            const mins = Math.floor(duration / 60);
            const secs = duration % 60;
            const dur = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
            return `Finished viewing (${dur} on page)`;
        }
        return 'Finished viewing';
    }
    if (action.endsWith('button_clicked')) {
        return button ? `Clicked "${button}"` : 'Clicked a button';
    }
    return 'Viewer activity';
}

// ---------- actor resolution ----------

function resolveActor(row) {
    const name = trimOrNull(row.actor_name);
    const phone = trimOrNull(row.actor_phone);
    const role = trimOrNull(row.actor_role);

    if (name || phone) {
        return { name: name || phone, phone: name ? phone : null, role, is_known: true };
    }

    // Unknown human source — surface the system/DB origin instead.
    const sys = trimOrNull(row.source_app) || trimOrNull(row.application_name) || trimOrNull(row.db_user);
    const ip = trimOrNull(row.client_addr);
    return {
        name: sys || 'Unknown source',
        phone: ip ? `IP ${ip}` : null,
        role: role || 'system',
        is_known: false
    };
}

// ---------- detail row normaliser ----------

function normalizeDetailRow(row) {
    const entityType = trimOrNull(row.entity_type) || 'invoice';
    const rawAction = trimOrNull(row.action_type) || '';
    const { category, label } = categorizeAction(rawAction, entityType);
    const changesArr = safeJson(row.changes);
    const isViewer = entityType === 'viewer_activity';

    const changes = isViewer ? [] : normalizeChanges(row.changes);
    const actor = resolveActor(row);

    let summary;
    if (isViewer) {
        summary = summarizeViewerActivity(rawAction, Array.isArray(changesArr) ? changesArr : []);
    } else if (changes.length === 0) {
        summary = `${label} ${entityType.replace(/_/g, ' ')}`;
    } else if (changes.length === 1) {
        summary = `${label} ${changes[0].field}`;
    } else {
        summary = `${label} ${entityType.replace(/_/g, ' ')} (${changes.length} changes)`;
    }

    return {
        id: row.id,
        entity_type: entityType,
        raw_action: rawAction,
        category,
        action_label: label,
        summary,
        changes,
        actor,
        edited_at: row.edited_at
    };
}

// ---------- public reads ----------

/**
 * One row per invoice, newest activity first, with text search across
 * invoice_number and customer name. Fetches limit+1 to compute hasMore.
 */
async function listInvoices(client, { search = '', page = 1, pageSize = PAGE_SIZE } = {}) {
    const term = trimOrNull(search);
    const size = Math.min(Math.max(parseInt(pageSize, 10) || PAGE_SIZE, 1), 100);
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const offset = (pageNum - 1) * size;

    const params = [];
    let searchClause = '';
    if (term) {
        params.push(`%${term}%`);
        searchClause = `AND (i.invoice_number ILIKE $${params.length} OR c.name ILIKE $${params.length})`;
    }
    params.push(size + 1); // fetch one extra to detect more pages
    const limitParam = `$${params.length}`;
    params.push(offset);
    const offsetParam = `$${params.length}`;

    const sql = `
        WITH ranked AS (
            SELECT invoice_id,
                   row_number() OVER (PARTITION BY invoice_id ORDER BY edited_at DESC) AS rn,
                   count(*)     OVER (PARTITION BY invoice_id)                         AS event_count,
                   action_type, entity_type, edited_at
              FROM invoice_audit_log
             WHERE invoice_id IS NOT NULL
        )
        SELECT r.invoice_id,
               r.event_count,
               r.action_type AS last_action,
               r.entity_type AS last_entity,
               r.edited_at   AS last_activity,
               i.bubble_id,
               i.invoice_number,
               i.status,
               i.total_amount,
               i.created_at,
               c.name AS customer_name
          FROM ranked r
          JOIN invoice i ON i.id = r.invoice_id
          LEFT JOIN customer c ON c.customer_id = i.linked_customer
         WHERE r.rn = 1
           ${searchClause}
         ORDER BY r.edited_at DESC
         LIMIT ${limitParam} OFFSET ${offsetParam}`;

    const result = await client.query(sql, params);
    const rows = result.rows.slice(0, size).map((row) => {
        const { category, label } = categorizeAction(row.last_action, row.last_entity);
        return {
            invoice_id: row.invoice_id,
            bubble_id: row.bubble_id || null,
            invoice_number: row.invoice_number || `#${row.invoice_id}`,
            customer_name: trimOrNull(row.customer_name),
            status: trimOrNull(row.status),
            total_amount: row.total_amount !== null ? Number(row.total_amount) : null,
            created_at: row.created_at,
            event_count: Number(row.event_count) || 0,
            last_activity: row.last_activity,
            last_action: row.last_action,
            last_entity: row.last_entity,
            last_category: category,
            last_label: label
        };
    });

    return {
        rows,
        page: pageNum,
        pageSize: size,
        hasMore: result.rows.length > size
    };
}

/**
 * Every audit log row for one invoice (by integer invoice_id), normalized
 * for the timeline, plus the invoice's header meta.
 */
async function loadInvoiceDetail(client, invoiceId) {
    const id = parseInt(invoiceId, 10);
    if (!Number.isFinite(id)) return null;

    const metaResult = await client.query(
        `SELECT i.id, i.bubble_id, i.invoice_number, i.status,
                i.total_amount, i.paid_amount, i.balance_due, i.created_at,
                c.name  AS customer_name,
                c.phone AS customer_phone
           FROM invoice i
           LEFT JOIN customer c ON c.customer_id = i.linked_customer
          WHERE i.id = $1
          LIMIT 1`,
        [id]
    );
    const meta = metaResult.rows[0];
    if (!meta) return null;

    const logResult = await client.query(
        `SELECT id, invoice_id, invoice_number, entity_type, entity_id, action_type,
                changes, actor_user_id, actor_name, actor_phone, actor_role,
                source_app, db_user, application_name, client_addr, edited_at
           FROM invoice_audit_log
          WHERE invoice_id = $1
          ORDER BY edited_at DESC
          LIMIT ${DETAIL_LIMIT}`,
        [id]
    );

    const rows = logResult.rows.map(normalizeDetailRow);

    return {
        invoice: {
            invoice_id: meta.id,
            bubble_id: meta.bubble_id || null,
            invoice_number: meta.invoice_number || `#${meta.id}`,
            customer_name: trimOrNull(meta.customer_name),
            customer_phone: trimOrNull(meta.customer_phone),
            status: trimOrNull(meta.status),
            total_amount: meta.total_amount !== null ? Number(meta.total_amount) : null,
            paid_amount: meta.paid_amount !== null ? Number(meta.paid_amount) : null,
            balance_due: meta.balance_due !== null ? Number(meta.balance_due) : null,
            created_at: meta.created_at
        },
        rows,
        total: rows.length
    };
}

module.exports = {
    listInvoices,
    loadInvoiceDetail,
    // exported for unit reuse / testing
    categorizeAction,
    normalizeDetailRow
};
