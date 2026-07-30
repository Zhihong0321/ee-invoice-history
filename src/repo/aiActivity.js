'use strict';

/**
 * AI Workflow activity — reads `ai_activity_log`, the cross-app log every
 * AI agent run (Claude sessions, MiniMax TTS, etc.) writes to regardless of
 * which Eternalgy app it ran in. Very low volume today (a handful of rows
 * total) — unlike ee-admin's activity_log there is no 24h/30-day windowing
 * here, summary stats are all-time.
 */

const PAGE_SIZE_DEFAULT = 100;
const PAGE_SIZE_MAX = 300;

/**
 * @param {object} client - pg client
 * @param {object} opts   - { limit, apps: string[] }
 */
async function loadAiActivity(client, opts = {}) {
    const limit = Math.min(Math.max(parseInt(opts.limit, 10) || PAGE_SIZE_DEFAULT, 1), PAGE_SIZE_MAX);
    const apps = Array.isArray(opts.apps) && opts.apps.length ? opts.apps : null;

    const params = [];
    const clauses = [];
    if (apps) {
        params.push(apps);
        clauses.push(`app = ANY($${params.length}::text[])`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    params.push(limit);
    const sql = `
        SELECT id, app, app_env, agent, agent_kind, model, api_url,
               session_id, task_id, parent_task_id,
               triggered_by_user_id, triggered_by_ref, triggered_by_name,
               action, tool_name, entity_type, entity_id, entity_label,
               description, input_summary, output_summary,
               input_tokens, output_tokens, cost_usd, duration_ms,
               status, error_message, metadata, occurred_at
        FROM ai_activity_log
        ${where}
        ORDER BY occurred_at DESC, id DESC
        LIMIT $${params.length}
    `;
    const { rows } = await client.query(sql, params);
    return rows.map(shapeRow);
}

function shapeRow(row) {
    return {
        id: row.id,
        app: row.app,
        appEnv: row.app_env,
        agent: row.agent,
        agentKind: row.agent_kind,
        model: row.model,
        apiUrl: row.api_url,
        sessionId: row.session_id,
        taskId: row.task_id,
        parentTaskId: row.parent_task_id,
        triggeredByUserId: row.triggered_by_user_id,
        triggeredByRef: row.triggered_by_ref,
        triggeredByName: row.triggered_by_name,
        action: row.action,
        toolName: row.tool_name,
        entityType: row.entity_type,
        entityId: row.entity_id,
        entityLabel: row.entity_label,
        description: row.description,
        inputSummary: row.input_summary,
        outputSummary: row.output_summary,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        costUsd: row.cost_usd === null || row.cost_usd === undefined ? null : Number(row.cost_usd),
        durationMs: row.duration_ms,
        status: row.status || 'success',
        errorMessage: row.error_message,
        metadata: row.metadata || {},
        occurredAt: row.occurred_at
    };
}

/**
 * Stat strip: total events, distinct apps/agents, failures, cumulative cost
 * and tokens. All-time — the table is brand new and too sparse for a 24h
 * window to mean anything yet.
 */
async function loadAiActivitySummary(client) {
    const sql = `
        SELECT
            count(*)::int AS total,
            count(DISTINCT app)::int AS apps,
            count(DISTINCT agent)::int AS agents,
            count(*) FILTER (WHERE status <> 'success')::int AS failures,
            coalesce(sum(cost_usd), 0) AS total_cost,
            coalesce(sum(input_tokens), 0)::bigint AS total_input_tokens,
            coalesce(sum(output_tokens), 0)::bigint AS total_output_tokens
        FROM ai_activity_log
    `;
    const { rows } = await client.query(sql);
    const row = rows[0] || {};
    const total = Number(row.total || 0);
    const apps = Number(row.apps || 0);
    const agents = Number(row.agents || 0);
    const failures = Number(row.failures || 0);
    const totalCost = Number(row.total_cost || 0);
    const totalIn = Number(row.total_input_tokens || 0);
    const totalOut = Number(row.total_output_tokens || 0);

    return [
        {
            label: 'AI events',
            value: total,
            sub: `${apps} app${apps === 1 ? '' : 's'} · ${agents} agent${agents === 1 ? '' : 's'}`,
            note: 'All-time rows in ai_activity_log'
        },
        {
            label: 'Failures',
            value: failures,
            sub: failures === 0 ? 'all success' : `${failures} failed run${failures === 1 ? '' : 's'}`,
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
            note: 'Sum of input_tokens + output_tokens'
        }
    ];
}

const SOLAR_PRESENTATION_APP = 'solar-presentation';

/**
 * Combined Auto Proposal feed. The app emits a concise staff-facing event to
 * activity_log as well as detailed model/tool telemetry to ai_activity_log;
 * both are needed to see the whole proposal lifecycle in one timeline.
 */
async function loadSolarPresentationActivity(client, opts = {}) {
    const limit = Math.min(Math.max(parseInt(opts.limit, 10) || PAGE_SIZE_DEFAULT, 1), PAGE_SIZE_MAX);
    const sources = Array.isArray(opts.sources) && opts.sources.length ? new Set(opts.sources) : null;
    const includeAi = !sources || sources.has('ai');
    const includeActivity = !sources || sources.has('activity');
    const rows = [];

    if (includeAi) {
        const { rows: aiRows } = await client.query(`
            SELECT id, app, app_env, agent, agent_kind, model, api_url,
                   session_id, task_id, parent_task_id,
                   triggered_by_user_id, triggered_by_ref, triggered_by_name,
                   action, tool_name, entity_type, entity_id, entity_label,
                   description, input_summary, output_summary,
                   input_tokens, output_tokens, cost_usd, duration_ms,
                   status, error_message, metadata, occurred_at
            FROM ai_activity_log
            WHERE app = $1
            ORDER BY occurred_at DESC, id DESC
            LIMIT $2
        `, [SOLAR_PRESENTATION_APP, limit]);
        rows.push(...aiRows.map((row) => ({ kind: 'ai', ...shapeRow(row) })));
    }

    if (includeActivity) {
        const { rows: activityRows } = await client.query(`
            SELECT id, app, app_env, source_url, actor_kind, actor_user_id, actor_ref,
                   actor_name, actor_role, action, entity_type, entity_id, entity_label,
                   description, fields, status, error_message, request_id, occurred_at
            FROM activity_log
            WHERE app = $1
            ORDER BY occurred_at DESC, id DESC
            LIMIT $2
        `, [SOLAR_PRESENTATION_APP, limit]);
        rows.push(...activityRows.map((row) => ({
            kind: 'activity',
            id: row.id,
            app: row.app,
            appEnv: row.app_env,
            sourceUrl: row.source_url,
            actorKind: row.actor_kind,
            actorUserId: row.actor_user_id,
            actorRef: row.actor_ref,
            actorName: row.actor_name,
            actorRole: row.actor_role,
            action: row.action,
            entityType: row.entity_type,
            entityId: row.entity_id,
            entityLabel: row.entity_label,
            description: row.description,
            fields: row.fields || [],
            status: row.status || 'success',
            errorMessage: row.error_message,
            requestId: row.request_id,
            occurredAt: row.occurred_at
        })));
    }

    return rows
        .sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt) || Number(b.id) - Number(a.id))
        .slice(0, limit);
}

const REFERRAL_AI_APP = '00product-ai';

/**
 * Referral is a webchat-first product: there is no `activity_log` app row
 * for it (it never wrote there), so "activity" for this feed means the raw
 * `et_messages` webchat stream (channel='webchat') instead — the same table
 * dashboard.js's live-wall widget already reads for Referral. AI runs come
 * from `ai_activity_log` filtered to app='00product-ai', the LLM that answers
 * those webchat questions.
 *
 * Message content is intentionally never selected here (same restraint as
 * dashboard.js's loadReferralWebchat) — this is an activity signal
 * (direction, delivery status, timestamp), not a chat viewer. Customer phone
 * numbers are masked to their last 4 digits.
 */
function maskReferralPhone(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length < 4) return '••••';
    return `•••• ${digits.slice(-4)}`;
}

async function loadReferralWebchatEvents(client, limit) {
    const { rows } = await client.query(`
        SELECT id, direction, sender_phone, recipient_phone, message_type,
               delivery_status, created_at
        FROM et_messages
        WHERE channel = 'webchat'
        ORDER BY created_at DESC, id DESC
        LIMIT $1
    `, [limit]);

    return rows.map((row) => {
        const isCustomer = (p) => /^\d{8,15}$/.test(String(p || '').replace(/\D/g, ''));
        const customerPhone = isCustomer(row.sender_phone) ? row.sender_phone
            : (isCustomer(row.recipient_phone) ? row.recipient_phone : null);
        return {
            kind: 'activity',
            id: row.id,
            direction: row.direction,
            phoneMasked: customerPhone ? maskReferralPhone(customerPhone) : null,
            messageType: row.message_type,
            deliveryStatus: row.delivery_status,
            occurredAt: row.created_at
        };
    });
}

/**
 * Combined Referral feed: webchat events (`et_messages`) + the AI runs that
 * answered them (`ai_activity_log` where app='00product-ai'), merged into one
 * chronological timeline. Mirrors loadSolarPresentationActivity's two-source
 * shape, but the "activity" side is et_messages instead of activity_log.
 */
async function loadReferralActivity(client, opts = {}) {
    const limit = Math.min(Math.max(parseInt(opts.limit, 10) || PAGE_SIZE_DEFAULT, 1), PAGE_SIZE_MAX);
    const sources = Array.isArray(opts.sources) && opts.sources.length ? new Set(opts.sources) : null;
    const includeAi = !sources || sources.has('ai');
    const includeActivity = !sources || sources.has('activity');
    const rows = [];

    if (includeAi) {
        const aiRows = await loadAiActivity(client, { apps: [REFERRAL_AI_APP], limit });
        rows.push(...aiRows.map((row) => ({ kind: 'ai', ...row })));
    }

    if (includeActivity) {
        rows.push(...await loadReferralWebchatEvents(client, limit));
    }

    return rows
        .sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt) || Number(b.id) - Number(a.id))
        .slice(0, limit);
}

module.exports = {
    loadAiActivity,
    loadAiActivitySummary,
    loadSolarPresentationActivity,
    loadReferralActivity
};
