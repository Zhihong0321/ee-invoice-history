'use strict';

/**
 * Reader for the shared cross-app `activity_log` table (prod_main).
 * Schema + rules: see EE-Admin-v5/SOP-SCHEMA-Activity-log.md.
 *
 * Per Rule 4 of that SOP, `action` and `entity_type` are free text with no
 * enum — this reader never filters against a fixed allow-list, it only
 * offers whatever distinct values currently exist in the table (facets).
 */

const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 200;

function buildFilters({ app, entityType, actor, search }, params) {
    const clauses = [];

    if (app) {
        params.push(app);
        clauses.push(`app = $${params.length}`);
    }
    if (entityType) {
        params.push(entityType);
        clauses.push(`entity_type = $${params.length}`);
    }
    if (actor) {
        params.push(`%${actor}%`);
        clauses.push(`actor_name ILIKE $${params.length}`);
    }
    if (search) {
        params.push(`%${search}%`);
        const idx = params.length;
        clauses.push(`(description ILIKE $${idx} OR entity_label ILIKE $${idx} OR action ILIKE $${idx})`);
    }

    return clauses;
}

/**
 * Cursor-paginated read of the global feed, most recent first.
 * Cursor shape: "<occurred_at ISO>|<id>" — per SOP §8, paginate on
 * (occurred_at, id), never OFFSET.
 */
async function loadActivityLog(client, opts = {}) {
    const limit = Math.min(Math.max(parseInt(opts.limit, 10) || PAGE_SIZE_DEFAULT, 1), PAGE_SIZE_MAX);
    const params = [];
    const clauses = buildFilters(opts, params);

    if (opts.cursor) {
        const [ts, id] = String(opts.cursor).split('|');
        if (ts && id) {
            params.push(ts, id);
            clauses.push(`(occurred_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`);
        }
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(limit + 1);

    const sql = `
        SELECT id, app, app_env, source_url, actor_kind, actor_user_id, actor_ref,
               actor_name, actor_role, action, entity_type, entity_id, entity_label,
               description, fields, status, error_message, request_id, occurred_at
        FROM activity_log
        ${where}
        ORDER BY occurred_at DESC, id DESC
        LIMIT $${params.length}
    `;

    const { rows } = await client.query(sql, params);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last
        ? `${new Date(last.occurred_at).toISOString()}|${last.id}`
        : null;

    return { rows: page, hasMore, nextCursor };
}

/** Distinct `app` and `entity_type` values currently in the table, for filter dropdowns. */
async function loadActivityLogFacets(client) {
    const [appsRes, entityTypesRes] = await Promise.all([
        client.query(`SELECT DISTINCT app FROM activity_log ORDER BY app`),
        client.query(`SELECT DISTINCT entity_type FROM activity_log WHERE entity_type IS NOT NULL ORDER BY entity_type`)
    ]);

    return {
        apps: appsRes.rows.map((r) => r.app),
        entityTypes: entityTypesRes.rows.map((r) => r.entity_type)
    };
}

/** Per-app counters (today vs all-time-within-retention) for the summary cards. */
async function loadActivityLogSummary(client) {
    const { rows } = await client.query(`
        SELECT app,
               count(*) FILTER (WHERE occurred_at >= now() - interval '24 hours') AS today,
               count(*) AS total,
               max(occurred_at) AS last_event_at
        FROM activity_log
        GROUP BY app
        ORDER BY today DESC, total DESC
    `);

    return rows.map((r) => ({
        app: r.app,
        today: Number(r.today),
        total: Number(r.total),
        lastEventAt: r.last_event_at
    }));
}

module.exports = { loadActivityLog, loadActivityLogFacets, loadActivityLogSummary };
