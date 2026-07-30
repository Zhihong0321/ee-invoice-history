'use strict';

/**
 * AI Router activity — reads `request_logs` from the tnb-tariff database
 * (a different DB than the rest of this app; see ../routerDb.js). Every
 * request that passed through the AI router: which provider/model handled
 * it, tokens, latency, cost, and whether it succeeded.
 */

const PAGE_SIZE_DEFAULT = 100;
const PAGE_SIZE_MAX = 300;

/**
 * @param {object} client - router pg client (see routerDb.js)
 * @param {object} opts   - { limit, status, providers: string[] }
 */
async function loadAiRouterLogs(client, opts = {}) {
    const limit = Math.min(Math.max(parseInt(opts.limit, 10) || PAGE_SIZE_DEFAULT, 1), PAGE_SIZE_MAX);
    const providers = Array.isArray(opts.providers) && opts.providers.length ? opts.providers : null;
    const status = opts.status && opts.status !== 'all' ? opts.status : null;

    const params = [];
    const clauses = [];
    if (providers) {
        params.push(providers);
        clauses.push(`provider_name = ANY($${params.length}::text[])`);
    }
    if (status) {
        params.push(status);
        clauses.push(`status = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    params.push(limit);
    const sql = `
        SELECT id, api_key_prefix, provider_name, model, model_mapped,
               prompt_tokens, completion_tokens, total_tokens,
               latency_ms, ttfb_ms, is_streaming, status, error_message,
               ip_address, created_at, cost_usd
        FROM request_logs
        ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT $${params.length}
    `;
    const { rows } = await client.query(sql, params);
    return rows.map(shapeRow);
}

function shapeRow(row) {
    return {
        id: row.id,
        apiKeyPrefix: row.api_key_prefix,
        providerName: row.provider_name,
        model: row.model,
        modelMapped: row.model_mapped,
        promptTokens: row.prompt_tokens,
        completionTokens: row.completion_tokens,
        totalTokens: row.total_tokens,
        latencyMs: row.latency_ms,
        ttfbMs: row.ttfb_ms,
        isStreaming: !!row.is_streaming,
        status: row.status || 'success',
        errorMessage: row.error_message,
        ipAddress: row.ip_address,
        costUsd: row.cost_usd === null || row.cost_usd === undefined ? null : Number(row.cost_usd),
        occurredAt: row.created_at
    };
}

/**
 * Stat strip: total requests, error rate, cumulative cost, tokens, and
 * distinct providers/models. All-time — same low-volume shape as
 * ai_activity_log, no 24h windowing.
 */
async function loadAiRouterSummary(client) {
    const sql = `
        SELECT
            count(*)::int AS total,
            count(DISTINCT provider_name)::int AS providers,
            count(DISTINCT model)::int AS models,
            count(*) FILTER (WHERE status <> 'success')::int AS failures,
            coalesce(sum(cost_usd), 0) AS total_cost,
            coalesce(sum(prompt_tokens), 0)::bigint AS total_prompt_tokens,
            coalesce(sum(completion_tokens), 0)::bigint AS total_completion_tokens,
            coalesce(avg(latency_ms), 0)::int AS avg_latency_ms
        FROM request_logs
    `;
    const { rows } = await client.query(sql);
    const row = rows[0] || {};
    const total = Number(row.total || 0);
    const providers = Number(row.providers || 0);
    const models = Number(row.models || 0);
    const failures = Number(row.failures || 0);
    const totalCost = Number(row.total_cost || 0);
    const totalIn = Number(row.total_prompt_tokens || 0);
    const totalOut = Number(row.total_completion_tokens || 0);
    const avgLatency = Number(row.avg_latency_ms || 0);

    return [
        {
            label: 'Requests',
            value: total,
            sub: `${providers} provider${providers === 1 ? '' : 's'} · ${models} model${models === 1 ? '' : 's'}`,
            note: 'All-time rows in request_logs'
        },
        {
            label: 'Failures',
            value: failures,
            sub: failures === 0 ? 'all success' : `${failures} failed request${failures === 1 ? '' : 's'}`,
            note: 'Rows with status != success',
            danger: failures > 0
        },
        {
            label: 'Cost',
            value: totalCost > 0 ? `$${totalCost.toFixed(4)}` : '$0',
            sub: 'Cumulative cost_usd',
            note: 'Sum of cost_usd across all rows'
        },
        {
            label: 'Tokens',
            value: (totalIn + totalOut).toLocaleString(),
            sub: `${totalIn.toLocaleString()} in / ${totalOut.toLocaleString()} out`,
            note: 'Sum of prompt_tokens + completion_tokens'
        },
        {
            label: 'Avg latency',
            value: `${avgLatency.toLocaleString()}ms`,
            sub: 'Mean latency_ms across all rows',
            note: 'Mean latency_ms across all rows'
        }
    ];
}

module.exports = {
    loadAiRouterLogs,
    loadAiRouterSummary
};
