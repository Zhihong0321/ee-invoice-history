'use strict';

const { pool } = require('../db');

/**
 * WAREHOUSE — live stock demand traced from every invoice that has a payment.
 *
 * The question this answers is "what hardware do I have to have on the shelf
 * right now?", split by how safe the job is:
 *
 *   Group 1 — paid < 59% AND SEDA not approved yet (null / Pending / Submitted)
 *             => soft demand, don't commit stock yet.
 *   Group 2 — paid >= 59% AND SEDA approved
 *             => hard demand, reserve the panels and inverters.
 *
 * Anything that satisfies neither pair (e.g. fully paid but SEDA still
 * pending) lands in a third "Unmatched" group rather than being dropped —
 * a warehouse view that silently loses invoices is worse than useless.
 *
 * Data model (all Bubble-era text ids):
 *   invoice.linked_package            -> package.bubble_id
 *   invoice.linked_seda_registration  -> seda_registration.bubble_id (.seda_status)
 *   invoice.linked_customer           -> customer.customer_id
 *   payment.linked_invoice            -> invoice.bubble_id  (verified money only)
 *   package.linked_package_item[]     -> package_item.bubble_id (.qty, .product)
 *   package_item.product              -> product.bubble_id (.name, .label)
 *
 * `package_item` is the authoritative bill of materials (it carries qty).
 * Older packages predate it, so `package.panel`/`panel_qty` and
 * `package.inverter_1..4` are used as a fallback when a package has no
 * usable item rows.
 */

const PAID_THRESHOLD = 0.59;

const SEDA_APPROVED = new Set(['approved', 'approved by seda']);
const SEDA_PENDING = new Set(['', 'pending', 'submitted', 'submission']);

function trimOrNull(value) {
    if (value === null || value === undefined) return null;
    const s = String(value).trim();
    return s === '' ? null : s;
}

function toNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

/** null / Pending / Submitted => 'pending'; Approved => 'approved'; rest => 'other'. */
function sedaBucket(status) {
    const key = String(status || '').trim().toLowerCase();
    if (SEDA_APPROVED.has(key)) return 'approved';
    if (SEDA_PENDING.has(key)) return 'pending';
    return 'other';
}

/**
 * Product classification. `label` is only filled in on a minority of rows
 * (30 of 68 products), so the name is the real signal — every panel is a
 * "... Panel ..." or "... TOPCon ..." and every inverter says "Inverter"
 * somewhere. `solar_output_rating` is a weak signal on its own: the ARMORVOLT
 * EV chargers reuse it for charger wattage (7000-22000), so it only counts
 * as a panel at real module wattages.
 */
function classifyProduct(name, label, solarRating) {
    const n = String(name || '').toLowerCase();
    const l = String(label || '').toLowerCase();
    if (l.includes('inverter') || n.includes('inverter')) return 'inverter';
    if (l === 'solar panel' || n.includes('panel') || n.includes('topcon')) return 'panel';
    const rating = Number(solarRating);
    if (Number.isFinite(rating) && rating > 0 && rating <= 1000) return 'panel';
    return null;
}

/** "650W JinkoSolar Panel N-Type TOPCon  " -> "650W JinkoSolar Panel N-Type TOPCon" */
function cleanName(name) {
    return String(name || '').replace(/\s+/g, ' ').trim();
}

/** Every invoice that has at least one verified payment, newest first. */
async function loadInvoiceRows() {
    const { rows } = await pool.query(`
        SELECT i.id,
               i.bubble_id,
               i.invoice_number,
               i.invoice_date,
               i.total_amount,
               i.linked_package,
               i.panel_qty       AS invoice_panel_qty,
               c.name            AS customer_name,
               sr.seda_status,
               sr.system_size,
               pay.paid,
               pay.payment_count,
               pay.last_payment_date
          FROM invoice i
          JOIN (
                SELECT linked_invoice,
                       sum(amount)       AS paid,
                       count(*)          AS payment_count,
                       max(payment_date) AS last_payment_date
                  FROM payment
                 WHERE linked_invoice IS NOT NULL
                 GROUP BY linked_invoice
               ) pay ON pay.linked_invoice = i.bubble_id
          LEFT JOIN customer c ON c.customer_id = i.linked_customer
          LEFT JOIN seda_registration sr ON sr.bubble_id = i.linked_seda_registration
         ORDER BY i.invoice_date DESC NULLS LAST
    `);
    return rows;
}

/**
 * Bill of materials for the packages these invoices point at. One row per
 * package; `items` is the package_item list resolved to product names.
 */
async function loadPackages(packageIds) {
    if (!packageIds.length) return new Map();

    const { rows } = await pool.query(`
        SELECT pk.bubble_id,
               pk.package_name,
               pk.type          AS package_type,
               pk.panel_qty,
               panel.name       AS panel_name,
               panel.solar_output_rating AS panel_rating,
               inv1.name AS inverter_1_name,
               inv2.name AS inverter_2_name,
               inv3.name AS inverter_3_name,
               inv4.name AS inverter_4_name,
               COALESCE(
                 json_agg(
                   json_build_object('name', pr.name, 'label', pr.label,
                                     'rating', pr.solar_output_rating, 'qty', pi.qty)
                   ORDER BY pi.sort NULLS LAST, pi.id
                 ) FILTER (WHERE pi.id IS NOT NULL),
                 '[]'::json
               ) AS items
          FROM package pk
          LEFT JOIN product panel ON panel.bubble_id = pk.panel
          LEFT JOIN product inv1  ON inv1.bubble_id  = pk.inverter_1
          LEFT JOIN product inv2  ON inv2.bubble_id  = pk.inverter_2
          LEFT JOIN product inv3  ON inv3.bubble_id  = pk.inverter_3
          LEFT JOIN product inv4  ON inv4.bubble_id  = pk.inverter_4
          LEFT JOIN LATERAL unnest(COALESCE(pk.linked_package_item, '{}')) AS li(bid) ON true
          LEFT JOIN package_item pi ON pi.bubble_id = li.bid
          LEFT JOIN product pr ON pr.bubble_id = pi.product
         WHERE pk.bubble_id = ANY($1::text[])
         GROUP BY pk.bubble_id, pk.package_name, pk.type, pk.panel_qty,
                  panel.name, panel.solar_output_rating,
                  inv1.name, inv2.name, inv3.name, inv4.name
    `, [packageIds]);

    const map = new Map();
    for (const row of rows) {
        const panels = [];
        const inverters = [];

        const items = Array.isArray(row.items) ? row.items : JSON.parse(row.items || '[]');
        for (const item of items) {
            const kind = classifyProduct(item.name, item.label, item.rating);
            if (!kind) continue;
            const entry = { model: cleanName(item.name), qty: Math.max(1, toNumber(item.qty) || 1) };
            if (kind === 'panel') panels.push(entry);
            else inverters.push(entry);
        }

        // Fallbacks for packages that predate package_item. Still run the
        // names through the classifier — EV-charger packages point
        // `inverter_1` at the charger itself, which is not warehouse stock
        // for this view.
        if (!panels.length && row.panel_name && classifyProduct(row.panel_name, null, row.panel_rating) === 'panel') {
            panels.push({ model: cleanName(row.panel_name), qty: toNumber(row.panel_qty) || 0 });
        }
        if (!inverters.length) {
            for (const name of [row.inverter_1_name, row.inverter_2_name, row.inverter_3_name, row.inverter_4_name]) {
                if (name && classifyProduct(name, null, null) === 'inverter') {
                    inverters.push({ model: cleanName(name), qty: 1 });
                }
            }
        }

        map.set(row.bubble_id, {
            packageId: row.bubble_id,
            packageName: trimOrNull(row.package_name),
            packageType: trimOrNull(row.package_type),
            panels,
            inverters,
        });
    }
    return map;
}

/** Roll a list of {model, qty} up into totals, biggest first. */
function tally(entries) {
    const byModel = new Map();
    for (const { model, qty, invoiceCount } of entries) {
        const key = model || '(unknown)';
        const acc = byModel.get(key) || { model: key, qty: 0, invoices: 0 };
        acc.qty += qty;
        acc.invoices += invoiceCount || 0;
        byModel.set(key, acc);
    }
    return Array.from(byModel.values()).sort((a, b) => b.qty - a.qty || a.model.localeCompare(b.model));
}

function buildGroup(key, title, description, invoices) {
    const panelEntries = [];
    const inverterEntries = [];
    let totalAmount = 0;
    let totalPaid = 0;

    for (const inv of invoices) {
        totalAmount += inv.totalAmount;
        totalPaid += inv.paid;
        for (const p of inv.panels) panelEntries.push({ model: p.model, qty: p.qty, invoiceCount: 1 });
        for (const v of inv.inverters) inverterEntries.push({ model: v.model, qty: v.qty, invoiceCount: 1 });
    }

    const panels = tally(panelEntries);
    const inverters = tally(inverterEntries);

    return {
        key,
        title,
        description,
        invoiceCount: invoices.length,
        totalAmount,
        totalPaid,
        panelQty: panels.reduce((s, p) => s + p.qty, 0),
        inverterQty: inverters.reduce((s, v) => s + v.qty, 0),
        panels,
        inverters,
        invoices,
    };
}

/** Live snapshot — every invoice with a payment, grouped and tallied. */
async function loadWarehouse() {
    const rows = await loadInvoiceRows();
    const packageIds = Array.from(new Set(rows.map((r) => trimOrNull(r.linked_package)).filter(Boolean)));
    const packages = await loadPackages(packageIds);

    let unlinkedPackages = 0;
    const invoices = rows.map((row) => {
        const pkg = packages.get(trimOrNull(row.linked_package)) || null;
        if (!pkg) unlinkedPackages += 1;

        const totalAmount = toNumber(row.total_amount);
        const paid = toNumber(row.paid);
        const pct = totalAmount > 0 ? paid / totalAmount : null;
        const status = trimOrNull(row.seda_status);

        return {
            id: row.id,
            bubbleId: row.bubble_id,
            invoiceNumber: trimOrNull(row.invoice_number) || `#${row.id}`,
            invoiceDate: row.invoice_date,
            customerName: trimOrNull(row.customer_name),
            totalAmount,
            paid,
            paidPct: pct === null ? null : Math.round(pct * 1000) / 10,
            paymentCount: Number(row.payment_count) || 0,
            lastPaymentDate: row.last_payment_date,
            sedaStatus: status,
            sedaBucket: sedaBucket(status),
            systemSize: row.system_size === null ? null : toNumber(row.system_size),
            packageId: pkg ? pkg.packageId : null,
            packageName: pkg ? pkg.packageName : null,
            packageType: pkg ? pkg.packageType : null,
            panels: pkg ? pkg.panels : [],
            inverters: pkg ? pkg.inverters : [],
            _pct: pct,
        };
    });

    const group1 = [];
    const group2 = [];
    const other = [];
    for (const inv of invoices) {
        const under = inv._pct !== null && inv._pct < PAID_THRESHOLD;
        const over = inv._pct !== null && inv._pct >= PAID_THRESHOLD;
        delete inv._pct;
        if (under && inv.sedaBucket === 'pending') group1.push(inv);
        else if (over && inv.sedaBucket === 'approved') group2.push(inv);
        else other.push(inv);
    }

    const dates = invoices.map((i) => i.invoiceDate).filter(Boolean);

    return {
        generatedAt: new Date().toISOString(),
        unlinkedPackages,
        coverage: {
            firstInvoiceDate: dates.length ? dates[dates.length - 1] : null,
            lastInvoiceDate: dates.length ? dates[0] : null,
        },
        totals: {
            invoices: invoices.length,
            amount: invoices.reduce((s, i) => s + i.totalAmount, 0),
            paid: invoices.reduce((s, i) => s + i.paid, 0),
        },
        groups: [
            buildGroup('group1', 'Group 1 — Soft demand',
                'Paid under 59% and SEDA still Pending / Submitted / not registered. Do not commit stock.',
                group1),
            buildGroup('group2', 'Group 2 — Hard demand',
                'Paid 59% or more and SEDA Approved. Reserve these panels and inverters.',
                group2),
            buildGroup('other', 'Unmatched',
                'Neither rule fits — e.g. paid 59%+ but SEDA still pending, or under 59% but already approved.',
                other),
        ],
    };
}

module.exports = { loadWarehouse };
