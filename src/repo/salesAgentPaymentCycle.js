'use strict';

const { pool } = require('../db');

/**
 * SALES › Payment Cycle — per sales agent, how long it takes a case to move
 * money: from deposit (invoice."1st_payment_date") to crossing 59% of the
 * invoice total, and from that 59% crossing to full payment.
 *
 * Same milestone definition and cumulative-sum technique as
 * activityLogV2.js's loadPaymentCollectionMilestones / loadSedaCycleTimes
 * (PAYMENT_CROSS_RATIO = 0.59, full = total_amount - 0.01 to absorb rounding),
 * just grouped by invoice.linked_agent instead of returned per-invoice.
 *
 * Only invoices that actually have a recorded payment are counted (JOIN
 * payment) — an invoice with no money in yet has no deposit date to measure
 * from. Within that set, the two day-metrics are computed only for cases
 * that reached the milestone; cases still short of 59% or full payment
 * contribute to the case count / amount but not to the day averages.
 *
 * A third KPI, "average new cases per week", answers a different question —
 * how fast is this agent bringing in new deposits, not how fast do they
 * collect. It's each agent's deposit count divided by the span (in weeks)
 * between their earliest and latest deposit date, so a bursty agent (10
 * deposits in one week) reads differently from a steady one (10 deposits
 * spread over 10 weeks) even though both have caseCount = 10.
 */
const PAYMENT_CROSS_RATIO = 0.59;

function toNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function trimOrNull(value) {
    if (value === null || value === undefined) return null;
    const s = String(value).trim();
    return s === '' ? null : s;
}

function daysBetween(a, b) {
    if (!a || !b) return null;
    const ms = new Date(b) - new Date(a);
    return Math.round((ms / 86400000) * 10) / 10;
}

function avg(values) {
    if (!values.length) return null;
    return Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10) / 10;
}

function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const m = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    return Math.round(m * 10) / 10;
}

async function loadCaseRows() {
    const { rows } = await pool.query(`
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
             WHERE i.linked_agent IS NOT NULL
               AND i.total_amount > 0
               AND p.payment_date IS NOT NULL
               AND p.amount IS NOT NULL
        ),
        milestones AS (
            SELECT invoice_id,
                   min(t_first) AS t_first,
                   min(payment_date) FILTER (WHERE cum >= ${PAYMENT_CROSS_RATIO} * total_amount) AS t_59,
                   min(payment_date) FILTER (WHERE cum >= total_amount - 0.01) AS t_full
              FROM pay_cum
             GROUP BY invoice_id
        )
        SELECT i.id,
               i.invoice_number,
               i.total_amount,
               i.linked_agent,
               u.name AS agent_name,
               m.t_first,
               m.t_59,
               m.t_full
          FROM invoice i
          JOIN milestones m ON m.invoice_id = i.id
          LEFT JOIN "user" u ON u.bubble_id = i.linked_agent
         ORDER BY i.total_amount DESC NULLS LAST
    `);
    return rows;
}

/** Per-agent KPI board: deposit→59% and 59%→full cycle times, amount, case count. */
async function loadSalesAgentPaymentCycle() {
    const rows = await loadCaseRows();

    const byAgent = new Map();
    for (const row of rows) {
        const agentId = row.linked_agent;
        const agentName = trimOrNull(row.agent_name) || `Unknown agent (${agentId})`;
        let acc = byAgent.get(agentId);
        if (!acc) {
            acc = {
                agentId,
                agentName,
                caseCount: 0,
                totalAmount: 0,
                depositTo59: [],
                to59ToFull: [],
                depositDates: [],
            };
            byAgent.set(agentId, acc);
        }

        acc.caseCount += 1;
        acc.totalAmount += toNumber(row.total_amount);

        const d1 = daysBetween(row.t_first, row.t_59);
        const d2 = daysBetween(row.t_59, row.t_full);
        if (d1 !== null) acc.depositTo59.push(d1);
        if (d2 !== null) acc.to59ToFull.push(d2);
        if (row.t_first) acc.depositDates.push(new Date(row.t_first));
    }

    const agents = Array.from(byAgent.values())
        .map((a) => {
            let firstDepositAt = null;
            let lastDepositAt = null;
            let avgNewCasesPerWeek = null;
            if (a.depositDates.length) {
                firstDepositAt = new Date(Math.min(...a.depositDates));
                lastDepositAt = new Date(Math.max(...a.depositDates));
                const spanWeeks = Math.max((lastDepositAt - firstDepositAt) / 86400000 / 7, 1);
                avgNewCasesPerWeek = Math.round((a.depositDates.length / spanWeeks) * 10) / 10;
            }

            return {
                agentId: a.agentId,
                agentName: a.agentName,
                caseCount: a.caseCount,
                totalAmount: a.totalAmount,
                casesReached59: a.depositTo59.length,
                casesReachedFull: a.to59ToFull.length,
                avgDaysDepositTo59: avg(a.depositTo59),
                medianDaysDepositTo59: median(a.depositTo59),
                avgDays59ToFull: avg(a.to59ToFull),
                medianDays59ToFull: median(a.to59ToFull),
                depositsWithDate: a.depositDates.length,
                firstDepositAt,
                lastDepositAt,
                avgNewCasesPerWeek,
            };
        })
        .sort((a, b) => b.totalAmount - a.totalAmount);

    return {
        generatedAt: new Date().toISOString(),
        crossRatio: PAYMENT_CROSS_RATIO,
        totals: {
            agents: agents.length,
            cases: agents.reduce((s, a) => s + a.caseCount, 0),
            amount: agents.reduce((s, a) => s + a.totalAmount, 0),
        },
        agents,
    };
}

module.exports = { loadSalesAgentPaymentCycle };
