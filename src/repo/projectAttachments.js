'use strict';

/**
 * PROJECT › Attachment Log — every file that was attached to (or removed
 * from) an invoice: site-survey photos, roof images, SEDA documents and
 * engineering drawings.
 *
 * Source is `invoice_audit_log`, NOT `activity_log`. Both tables record
 * attachment events, but only the audit log covers the whole history:
 *   - invoice_upload  added/deleted   since 2026-05-10
 *   - seda_upload     added/deleted   since 2026-05-08
 *   - drawing         upload          since 2026-06-11
 * `activity_log` only started carrying `entity_type='attachment'` on
 * 2026-07-28 and is purged on a 30-day retention, so using it as the spine
 * would throw away almost everything.
 *
 * The trade-off: audit `drawing` rows have `actor_name = NULL` (they are
 * written by the ee-admin service). They DO carry `actor_user_id`, so the
 * frontend resolves the name through the shared user-profile cache, the
 * same way every other feed does.
 *
 * Each row is classified into a `kind`. Two of them matter enough to be
 * told apart at a glance, because both are a PV layout drawing and they
 * would otherwise read identically in one stream:
 *   - system_drawing — "PV System Drawing", uploaded from agent-os by the
 *     sales agent, stored in R2 under /pv_drawings/
 *   - pv_drawing     — the engineering-v2 `pv` drawing produced in
 *     admin.atap.solar by the back office
 */

const PAGE_SIZE_DEFAULT = 80;
const PAGE_SIZE_MAX = 300;

const UPLOAD_ENTITY_TYPES = ['invoice_upload', 'seda_upload', 'drawing'];

/**
 * Field labels seen in `changes`, grouped into the kinds the UI colours.
 * Anything unlisted falls through to seda_doc (for seda_upload) or other.
 */
const ROOF_IMAGE_FIELDS = [
    'Roof Image',
    'Roof — all angles',
    'Roof — close-up'
];

const SITE_IMAGE_FIELDS = [
    'Site Assessment Image',
    'Other site photo',
    'House front view',
    'House DB',
    'Planned inverter location',
    'Sun path direction',
    'TNB Meter Image'
];

const KIND_LABELS = {
    system_drawing: 'PV System Drawing',
    pv_drawing: 'PV Drawing · Admin',
    roof_drawing: 'Roof Drawing · Admin',
    roof_image: 'Roof Image',
    site_image: 'Site Image',
    seda_doc: 'SEDA Document',
    other: 'Attachment'
};

/**
 * The classification lives in SQL rather than JS so that a `kinds` filter can
 * be pushed down into the query — filtering in JS over a page would silently
 * under-fill it. The two field lists are still the JS constants above, bound
 * as parameters, so there is one place to edit when a new label appears.
 *
 * `drawing` rows are always the ee-admin engineering-v2 surface — their field
 * is the bare upload type (`pv` / `roof`), not a human label.
 *
 * @param {Array} params - query params, appended to in place
 * @returns {string} a CASE expression yielding the kind
 */
function kindCaseSql(params) {
    params.push(ROOF_IMAGE_FIELDS, SITE_IMAGE_FIELDS);
    const roof = `$${params.length - 1}::text[]`;
    const site = `$${params.length}::text[]`;
    const field = `a.changes->0->>'field'`;

    return `
        CASE
            WHEN a.entity_type = 'drawing' AND ${field} = 'pv'   THEN 'pv_drawing'
            WHEN a.entity_type = 'drawing' AND ${field} = 'roof' THEN 'roof_drawing'
            WHEN a.entity_type = 'drawing'                       THEN 'other'
            WHEN ${field} = 'PV System Drawing'                  THEN 'system_drawing'
            WHEN ${field} = ANY(${roof})                         THEN 'roof_image'
            WHEN ${field} = ANY(${site})                         THEN 'site_image'
            WHEN a.entity_type = 'seda_upload'                   THEN 'seda_doc'
            ELSE 'other'
        END
    `;
}

/**
 * `added` / `upload` both mean the file arrived; `deleted` means it was
 * pulled. Normalising here keeps the UI from having to know that
 * invoice_upload says "added" while drawing says "upload".
 */
function actionForRow(actionType) {
    return actionType === 'deleted' ? 'removed' : 'added';
}

/**
 * The stored URL is the only file identity an audit row has. Take the last
 * path segment, drop the epoch-ms prefix the admin uploader bolts on, and
 * URL-decode it so the card can show something a human recognises.
 */
function fileNameFromUrl(url) {
    if (!url) return null;
    const raw = String(url).split('?')[0].split('/').pop() || '';
    if (!raw) return null;

    let last;
    try {
        last = decodeURIComponent(raw);
    } catch (err) {
        last = raw;
    }
    // admin.atap.solar: "1785222538310-lk.jpeg" -> "lk.jpeg". R2 names are
    // machine-generated end to end, so they are shown as stored.
    return last.replace(/^\d{10,}-/, '') || last;
}

/**
 * Only R2 public objects can be rendered inline; admin.atap.solar files sit
 * behind the admin session and would show as broken images.
 */
function isPubliclyViewable(url) {
    return typeof url === 'string' && url.includes('.r2.dev/');
}

function normalizeRow(row) {
    // Upload rows carry exactly one change entry: the file that moved.
    const change = Array.isArray(row.changes) ? row.changes[0] : null;
    const field = change && change.field !== undefined ? change.field : null;
    const fileUrl = change
        ? (change.after !== undefined && change.after !== null ? change.after : (change.before ?? null))
        : null;

    return {
        id: `audit:${row.id}`,
        entityType: row.entity_type,
        actionType: row.action_type,
        action: actionForRow(row.action_type),
        kind: row.kind,
        kindLabel: KIND_LABELS[row.kind] || KIND_LABELS.other,
        // The raw label is worth keeping — "TNB Bill Month 2" is more useful
        // on the card than the coarse "SEDA Document" bucket it lands in.
        field,
        fileUrl,
        fileName: fileNameFromUrl(fileUrl),
        viewable: isPubliclyViewable(fileUrl),
        invoiceId: row.invoice_id,
        invoiceNumber: row.invoice_number,
        customerName: row.customer_name || null,
        actorUserId: row.actor_user_id,
        actorName: row.actor_name || null,
        sourceApp: row.source_app || null,
        occurredAt: row.edited_at
    };
}

/**
 * Load the attachment feed, newest first.
 *
 * @param {object} client - pg client
 * @param {object} opts   - { kinds: string[], limit, cursor }
 *   kinds  - restrict to these classified kinds (empty/absent = all)
 *   cursor - "<edited_at ISO>|<id>" from a previous page
 * @returns {Promise<{rows: Array, hasMore: boolean, nextCursor: string|null}>}
 */
async function loadProjectAttachments(client, opts = {}) {
    const limit = Math.min(Number(opts.limit) || PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX);
    const params = [];
    const kindCase = kindCaseSql(params);

    params.push(UPLOAD_ENTITY_TYPES);
    const where = [`a.entity_type = ANY($${params.length})`];

    const wanted = Array.isArray(opts.kinds) ? opts.kinds.filter(Boolean) : [];
    if (wanted.length) {
        params.push(wanted);
        where.push(`(${kindCase}) = ANY($${params.length}::text[])`);
    }

    if (opts.cursor) {
        const [ts, id] = String(opts.cursor).split('|');
        if (ts && id && !Number.isNaN(Number(id))) {
            params.push(ts, Number(id));
            where.push(`(a.edited_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`);
        }
    }

    // Ask for one more than the page so `hasMore` needs no second query.
    params.push(limit + 1);

    const sql = `
        SELECT
            a.id, a.entity_type, a.action_type, a.changes,
            a.invoice_id, a.invoice_number,
            a.actor_user_id, a.actor_name, a.source_app, a.edited_at,
            c.name AS customer_name,
            (${kindCase}) AS kind
        FROM invoice_audit_log a
        LEFT JOIN invoice i ON i.id = a.invoice_id
        LEFT JOIN customer c ON c.customer_id = i.linked_customer
        WHERE ${where.join(' AND ')}
        ORDER BY a.edited_at DESC, a.id DESC
        LIMIT $${params.length}
    `;

    const res = await client.query(sql, params);
    const rows = res.rows.map(normalizeRow);

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];

    return {
        rows: page,
        hasMore,
        nextCursor: hasMore && last
            ? `${new Date(last.occurredAt).toISOString()}|${last.id.replace('audit:', '')}`
            : null
    };
}

/**
 * Totals per kind across the whole log (not just the loaded page), so the
 * stat strip and the filter chips can show real counts.
 *
 * @param {object} client - pg client
 * @returns {Promise<{total, added, removed, byKind: object, firstAt, lastAt}>}
 */
async function loadProjectAttachmentSummary(client) {
    const params = [];
    const kindCase = kindCaseSql(params);
    params.push(UPLOAD_ENTITY_TYPES);

    const sql = `
        SELECT
            (${kindCase}) AS kind,
            a.action_type,
            count(*)::int AS n,
            min(a.edited_at) AS first_at,
            max(a.edited_at) AS last_at
        FROM invoice_audit_log a
        WHERE a.entity_type = ANY($${params.length})
        GROUP BY 1, 2
    `;
    const res = await client.query(sql, params);

    const byKind = {};
    let total = 0;
    let added = 0;
    let removed = 0;
    let firstAt = null;
    let lastAt = null;

    for (const row of res.rows) {
        const bucket = byKind[row.kind] || (byKind[row.kind] = {
            kind: row.kind,
            label: KIND_LABELS[row.kind] || KIND_LABELS.other,
            added: 0,
            removed: 0,
            total: 0
        });

        bucket.total += row.n;
        total += row.n;
        if (actionForRow(row.action_type) === 'removed') {
            bucket.removed += row.n;
            removed += row.n;
        } else {
            bucket.added += row.n;
            added += row.n;
        }

        if (!firstAt || new Date(row.first_at) < new Date(firstAt)) firstAt = row.first_at;
        if (!lastAt || new Date(row.last_at) > new Date(lastAt)) lastAt = row.last_at;
    }

    return { total, added, removed, byKind, firstAt, lastAt };
}

module.exports = {
    loadProjectAttachments,
    loadProjectAttachmentSummary,
    KIND_LABELS
};
