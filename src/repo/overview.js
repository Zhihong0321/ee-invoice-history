'use strict';

/**
 * OVERVIEW — the app's landing page.
 *
 * Every page in the sidebar is a log of one department's activity. This
 * module answers, in a single round of queries, "how busy is each of those
 * logs right now?" so the landing page can render one box per section
 * without loading thirteen separate feeds.
 *
 * Four sources feed the boxes:
 *   invoice_audit_log  (edited_at)   — invoice / SEDA / payment / attachments
 *   activity_log       (occurred_at) — calculator / referral / admin / main-site / claims
 *   ai_activity_log    (occurred_at) — AI workflow runs
 *   request_logs       (created_at)  — AI router, and the ONLY one on the
 *                                      other database (tnb-tariff, routerPool)
 *
 * A row can belong to more than one section — an `invoice_upload` is both
 * invoice activity and a project attachment — so each query cross-joins a
 * lateral array of section keys instead of a single CASE. Rows that map to
 * no section drop out (unnest of an empty array yields no rows).
 *
 * Days are bucketed in Asia/Kuala_Lumpur, matching dashboard.js. A UTC
 * bucket would file KL's 9am into the previous day.
 */

const DAYS = 7;

/** Section keys as returned by SQL -> what the UI needs to render a box. */
const SECTIONS = [
    { key: 'calculator', route: 'sales/calculator', dept: 'SALES', title: 'Calculator', icon: '🧮', unit: 'calculations' },
    { key: 'autoProposal', route: 'sales/auto-proposal', dept: 'SALES', title: 'Auto Proposal', icon: '🎙️', unit: 'events' },
    { key: 'referral', route: 'sales/referral', dept: 'SALES', title: 'REFERRAL', icon: '🤝', unit: 'events' },
    { key: 'invoice', route: 'invoice/activity', dept: 'INVOICE', title: 'Invoice Activity', icon: '🧾', unit: 'events' },
    { key: 'seda', route: 'seda/activity', dept: 'SEDA', title: 'SEDA Activity', icon: '📑', unit: 'events' },
    { key: 'payment', route: 'finance/payment-activity', dept: 'FINANCE', title: 'Payment Activity', icon: '💳', unit: 'events' },
    { key: 'receipt', route: 'finance/receipt', dept: 'FINANCE', title: 'Official Receipt', icon: '🧷', unit: 'receipts' },
    { key: 'claim', route: 'finance/claim', dept: 'FINANCE', title: 'Claim Submission', icon: '📌', unit: 'claims' },
    { key: 'attachment', route: 'project/attachment', dept: 'PROJECT', title: 'Attachment Log', icon: '📎', unit: 'files' },
    { key: 'seoGeo', route: 'marketing/seo-geo-site', dept: 'MARKETING', title: 'SEO+GEO Site', icon: '🌐', unit: 'page views' },
    { key: 'admin', route: 'admin/console', dept: 'ADMIN', title: 'Admin Console', icon: '🛠️', unit: 'actions' },
    { key: 'aiWorkflow', route: 'ai-workflow/main', dept: 'AI WORKFLOW', title: 'AI Workflow', icon: '🤖', unit: 'runs' },
    { key: 'aiRouter', route: 'ai-router/logs', dept: 'AI ROUTER', title: 'Router Requests', icon: '🔀', unit: 'requests' },
];

/** Pages that exist in the nav but are not activity feeds — listed, not boxed. */
const OTHER_PAGES = [
    { route: 'sales/proposal', dept: 'SALES', title: 'Sales Agent Activity' },
    { route: 'warehouse/stock-demand', dept: 'WAREHOUSE', title: 'Stock Demand' },
    { route: 'marketing/ads-research', dept: 'MARKETING', title: 'Ads Research' },
    { route: 'pr/company-info', dept: 'PR', title: 'Company Info' },
    { route: 'pr/email', dept: 'PR', title: 'Email Received' },
    { route: 'hr/vacancy', dept: 'HR', title: 'Vacancy Handling' },
    { route: 'user-app/saj-api', dept: 'USER APP', title: 'SAJ API' },
    { route: 'user-app/activity', dept: 'USER APP', title: 'User APP Activity' },
];

/** Section arrays for invoice_audit_log rows. `a` is the table alias. */
const AUDIT_SECTIONS = `
      CASE WHEN a.entity_type IN ('invoice','invoice_item','invoice_upload','viewer_activity')
           THEN ARRAY['invoice'] ELSE ARRAY[]::text[] END
   || CASE WHEN a.entity_type IN ('seda','seda_upload','seda_registration')
           THEN ARRAY['seda'] ELSE ARRAY[]::text[] END
   || CASE WHEN a.entity_type IN ('payment','submitted_payment','verified_payment')
           THEN ARRAY['payment'] ELSE ARRAY[]::text[] END
   || CASE WHEN a.entity_type = 'payment' AND a.action_type = 'receipt_sent_manual'
           THEN ARRAY['receipt'] ELSE ARRAY[]::text[] END
   || CASE WHEN a.entity_type IN ('invoice_upload','seda_upload','drawing')
           THEN ARRAY['attachment'] ELSE ARRAY[]::text[] END
`;

/** Section arrays for activity_log rows. */
const ACTIVITY_SECTIONS = `
      CASE WHEN a.entity_type IN ('residential_roi_calculation','commercial_roi_lookup')
           THEN ARRAY['calculator'] ELSE ARRAY[]::text[] END
   || CASE WHEN a.app = 'solar-presentation' THEN ARRAY['autoProposal'] ELSE ARRAY[]::text[] END
   || CASE WHEN a.app = 'ee-referral'        THEN ARRAY['referral']     ELSE ARRAY[]::text[] END
   || CASE WHEN a.entity_type = 'claim_receipt' THEN ARRAY['claim']     ELSE ARRAY[]::text[] END
   || CASE WHEN a.app = 'main-site'          THEN ARRAY['seoGeo']       ELSE ARRAY[]::text[] END
   || CASE WHEN a.app = 'ee-admin'           THEN ARRAY['admin']        ELSE ARRAY[]::text[] END
`;

/** 'YYYY-MM-DD' keys for the last `DAYS` days in KL time, oldest first. */
function dayKeys() {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur' });
    const keys = [];
    for (let i = DAYS - 1; i >= 0; i -= 1) {
        keys.push(fmt.format(new Date(Date.now() - i * 24 * 60 * 60 * 1000)));
    }
    return keys;
}

function pctDelta(today, yesterday) {
    if (!yesterday) return today > 0 ? { direction: 'up', label: 'new' } : { direction: 'flat', label: '—' };
    const pct = Math.round(((today - yesterday) / yesterday) * 100);
    if (pct === 0) return { direction: 'flat', label: '0%' };
    return { direction: pct > 0 ? 'up' : 'down', label: `${pct > 0 ? '+' : ''}${pct}%` };
}

function trimOrNull(value) {
    if (value === null || value === undefined) return null;
    const s = String(value).trim();
    return s === '' ? null : s;
}

/**
 * Per-section, per-day counts. `sections` is the SQL expression producing a
 * text[] of section keys for each row; `tsCol` is that table's timestamp.
 */
function bucketSql(table, tsCol, sections) {
    return `
        SELECT s.sec AS sec,
               to_char(a.${tsCol} AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM-DD') AS day,
               count(*) AS n
          FROM ${table} a
          CROSS JOIN LATERAL unnest(${sections}) AS s(sec)
         WHERE a.${tsCol} > now() - interval '${DAYS + 1} days'
         GROUP BY 1, 2
    `;
}

/** Newest row per section, for the "last activity" line on each box. */
function lastSql(table, tsCol, sections, labelExpr) {
    return `
        SELECT DISTINCT ON (s.sec)
               s.sec AS sec,
               a.${tsCol} AS ts,
               ${labelExpr} AS label
          FROM ${table} a
          CROSS JOIN LATERAL unnest(${sections}) AS s(sec)
         WHERE a.${tsCol} > now() - interval '90 days'
         ORDER BY s.sec, a.${tsCol} DESC
    `;
}

/** Fold a bucket/last query's rows into the shared accumulators. */
function absorb(counts, lasts, bucketRows, lastRows) {
    for (const row of bucketRows) {
        const sec = counts[row.sec] || (counts[row.sec] = {});
        sec[row.day] = (sec[row.day] || 0) + Number(row.n);
    }
    for (const row of lastRows) {
        lasts[row.sec] = { at: row.ts, label: trimOrNull(row.label) };
    }
}

/**
 * @param {object} client      - pg client on prod_main
 * @param {object} routerClient - pg client on the router DB, or null if it is down
 */
async function loadOverview(client, routerClient) {
    const counts = {};
    const lasts = {};

    const auditBuckets = client.query(bucketSql('invoice_audit_log', 'edited_at', AUDIT_SECTIONS));
    const auditLast = client.query(lastSql('invoice_audit_log', 'edited_at', AUDIT_SECTIONS,
        `a.entity_type || ' · ' || a.action_type`));
    const actBuckets = client.query(bucketSql('activity_log', 'occurred_at', ACTIVITY_SECTIONS));
    const actLast = client.query(lastSql('activity_log', 'occurred_at', ACTIVITY_SECTIONS, 'a.description'));
    const aiBuckets = client.query(bucketSql('ai_activity_log', 'occurred_at', `ARRAY['aiWorkflow']`));
    const aiLast = client.query(lastSql('ai_activity_log', 'occurred_at', `ARRAY['aiWorkflow']`, 'a.description'));

    const [ab, al, cb, cl, ib, il] = await Promise.all([
        auditBuckets, auditLast, actBuckets, actLast, aiBuckets, aiLast,
    ]);
    absorb(counts, lasts, ab.rows, al.rows);
    absorb(counts, lasts, cb.rows, cl.rows);
    absorb(counts, lasts, ib.rows, il.rows);

    // The router lives on a different database. If it is unreachable the rest
    // of the landing page must still render, so this failure is swallowed and
    // the box simply reports no data.
    let routerDown = false;
    if (routerClient) {
        try {
            const [rb, rl] = await Promise.all([
                routerClient.query(bucketSql('request_logs', 'created_at', `ARRAY['aiRouter']`)),
                routerClient.query(lastSql('request_logs', 'created_at', `ARRAY['aiRouter']`,
                    `coalesce(a.provider_name, '') || ' · ' || coalesce(a.model, '')`)),
            ]);
            absorb(counts, lasts, rb.rows, rl.rows);
        } catch (err) {
            console.warn('[overview] router DB unavailable:', err.message);
            routerDown = true;
        }
    } else {
        routerDown = true;
    }

    const days = dayKeys();
    const today = days[days.length - 1];
    const yesterday = days[days.length - 2];

    const sections = SECTIONS.map((meta) => {
        const byDay = counts[meta.key] || {};
        const spark = days.map((d) => byDay[d] || 0);
        const todayCount = byDay[today] || 0;
        const yesterdayCount = byDay[yesterday] || 0;
        const last = lasts[meta.key] || null;

        return {
            ...meta,
            today: todayCount,
            yesterday: yesterdayCount,
            delta: pctDelta(todayCount, yesterdayCount),
            total: spark.reduce((s, n) => s + n, 0),
            spark,
            lastAt: last ? last.at : null,
            lastLabel: last ? last.label : null,
            offline: meta.key === 'aiRouter' && routerDown,
        };
    });

    return {
        generatedAt: new Date().toISOString(),
        days,
        windowDays: DAYS,
        totalToday: sections.reduce((s, x) => s + x.today, 0),
        totalWindow: sections.reduce((s, x) => s + x.total, 0),
        sections,
        otherPages: OTHER_PAGES,
    };
}

module.exports = { loadOverview };
