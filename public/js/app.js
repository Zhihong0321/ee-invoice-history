'use strict';

/**
 * Invoice History — browse & search frontend.
 *
 * Two views in one page, routed by the URL:
 *   /                  -> feed (one row per invoice, newest activity first)
 *   /?invoice=<id>     -> detail (every audit log row for that invoice)
 *
 * Data comes from:
 *   GET /api/invoices?search=&page=
 *   GET /api/invoices/:invoiceId/detail
 */

const app = document.getElementById('app');

const state = {
    search: '',
    page: 1,
    rows: [],
    hasMore: false,
    loading: false,
};

// ---------- category visuals ----------

const CAT = {
    created: { color: 'var(--c-created)', bg: 'var(--c-created-bg)' },
    updated: { color: 'var(--c-updated)', bg: 'var(--c-updated-bg)' },
    deleted: { color: 'var(--c-deleted)', bg: 'var(--c-deleted-bg)' },
    viewed:  { color: 'var(--c-viewed)',  bg: 'var(--c-viewed-bg)'  },
    session: { color: 'var(--c-session)', bg: 'var(--c-session-bg)' },
    click:   { color: 'var(--c-click)',   bg: 'var(--c-click-bg)'   },
    payment: { color: 'var(--c-payment)', bg: 'var(--c-payment-bg)' },
    other:   { color: 'var(--c-other)',   bg: 'var(--c-other-bg)'   },
};

const ICONS = {
    created: '<path d="M12 5v14M5 12h14"/>',
    updated: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    deleted: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    viewed:  '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    session: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    click:   '<path d="m9 9 5 12 1.8-5.2L21 14Z"/><path d="M7.2 2.2 8 5.1M5.1 8 2.2 7.2M14 4.1 12 6M6 12l-1.9 2"/>',
    payment: '<rect x="2" y="5" width="20" height="14" rx="2.5"/><path d="M2 10h20"/>',
    other:   '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/>',
};

function icon(cat, size) {
    const path = ICONS[cat] || ICONS.other;
    const s = size || 18;
    return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}

// ---------- formatting ----------

function escapeHtml(v) {
    return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtMoney(n) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    const num = Number(n);
    return 'RM ' + num.toLocaleString('en-MY', { minimumFractionDigits: num % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

function timeAgo(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 45) return 'just now';
    if (s < 90) return '1m ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    const dd = Math.floor(h / 24);
    if (dd < 7) return dd + 'd ago';
    if (dd < 30) return Math.floor(dd / 7) + 'w ago';
    if (dd < 365) return Math.floor(dd / 30) + 'mo ago';
    return Math.floor(dd / 365) + 'y ago';
}

function fmtAbs(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtDayLabel(iso) {
    const d = new Date(iso);
    const today = new Date();
    const y = new Date(); y.setDate(today.getDate() - 1);
    const same = (a, b) => a.toDateString() === b.toDateString();
    if (same(d, today)) return 'Today';
    if (same(d, y)) return 'Yesterday';
    return d.toLocaleDateString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: 'long', day: 'numeric' });
}

function statusPill(status) {
    if (!status) return '';
    const map = {
        draft:   ['#92400E', '#FEF3C7'],
        deleted: ['#9F1239', '#FFE4E6'],
        paid:    ['#065F46', '#D1FAE5'],
        payment_submitted: ['#1E40AF', '#DBEAFE'],
    };
    const [fg, bg] = map[status] || ['#57534E', '#F5F4F2'];
    return `<span class="pill" style="color:${fg};background:${bg}">${escapeHtml(status.replace(/_/g, ' '))}</span>`;
}

// ---------- health ----------

async function pingHealth() {
    const dot = document.getElementById('dot');
    const txt = document.getElementById('statusText');
    try {
        const r = await fetch('/api/healthz');
        const b = await r.json();
        if (r.ok && b.db === 'up') { dot.className = 'dot up'; txt.textContent = 'live'; }
        else { dot.className = 'dot down'; txt.textContent = 'db down'; }
    } catch (e) { dot.className = 'dot down'; txt.textContent = 'offline'; }
}

// ---------- feed view ----------

function feedCardHtml(inv) {
    const cat = CAT[inv.last_category] || CAT.other;
    const cust = inv.customer_name
        ? `<div class="cust">${escapeHtml(inv.customer_name)}</div>`
        : `<div class="cust muted">No customer linked</div>`;
    return `
        <button class="card" data-id="${inv.invoice_id}" style="animation-delay:var(--d,0ms)">
            <div class="ic" style="background:${cat.bg};color:${cat.color}">${icon(inv.last_category, 19)}</div>
            <div class="card-body">
                <div class="card-top">
                    <span class="invno">${escapeHtml(inv.invoice_number)}</span>
                    ${statusPill(inv.status)}
                </div>
                ${cust}
                <div class="sub"><b>${escapeHtml(inv.last_label)}</b> · ${inv.event_count} ${inv.event_count === 1 ? 'event' : 'events'}</div>
            </div>
            <div class="card-right">
                <div class="amt">${fmtMoney(inv.total_amount)}</div>
                <div class="when">${timeAgo(inv.last_activity)}</div>
            </div>
        </button>`;
}

function renderFeedShell() {
    app.innerHTML = `
        <div class="searchwrap">
            <div class="search">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                <input id="q" type="text" inputmode="search" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Search invoice no. or customer…" value="${escapeHtml(state.search)}">
                <button class="clear ${state.search ? 'show' : ''}" id="clear" aria-label="Clear">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
                </button>
            </div>
        </div>
        <div class="meta-row" id="meta"></div>
        <div class="feed" id="feed"></div>`;

    const q = document.getElementById('q');
    const clear = document.getElementById('clear');
    let t;
    q.addEventListener('input', () => {
        clear.classList.toggle('show', q.value.length > 0);
        clearTimeout(t);
        t = setTimeout(() => loadFeed(q.value.trim(), true), 280);
    });
    clear.addEventListener('click', () => { q.value = ''; clear.classList.remove('show'); q.focus(); loadFeed('', true); });
    document.getElementById('feed').addEventListener('click', (e) => {
        const card = e.target.closest('.card');
        if (card) goDetail(card.dataset.id);
    });
}

async function loadFeed(search, reset) {
    state.search = search;
    if (reset) { state.page = 1; state.rows = []; }
    state.loading = true;

    const feed = document.getElementById('feed');
    const meta = document.getElementById('meta');
    if (reset) {
        feed.innerHTML = Array.from({ length: 6 }, () => '<div class="skel"></div>').join('');
        meta.textContent = '';
    }

    try {
        const r = await fetch(`/api/invoices?search=${encodeURIComponent(search)}&page=${state.page}`);
        const b = await r.json();
        if (!b.ok) throw new Error(b.error || 'Failed to load');
        state.rows = state.rows.concat(b.data.rows);
        state.hasMore = b.data.hasMore;

        if (state.rows.length === 0) {
            feed.innerHTML = `<div class="empty"><div class="big">No invoices found</div><div>${search ? 'Nothing matches “' + escapeHtml(search) + '”.' : 'No activity recorded yet.'}</div></div>`;
            meta.textContent = '';
            return;
        }

        meta.textContent = search
            ? `${state.rows.length}${state.hasMore ? '+' : ''} ${state.rows.length === 1 ? 'match' : 'matches'}`
            : 'Latest activity';

        feed.innerHTML = state.rows.map((inv, i) => feedCardHtml(inv)).join('')
            + (state.hasMore ? '<button class="loadmore" id="more">Load more</button>' : '');

        // stagger only the freshest cards
        const cards = feed.querySelectorAll('.card');
        const start = reset ? 0 : cards.length - b.data.rows.length;
        for (let i = start; i < cards.length; i++) cards[i].style.setProperty('--d', `${(i - start) * 40}ms`);

        const more = document.getElementById('more');
        if (more) more.addEventListener('click', async () => {
            more.disabled = true; more.textContent = 'Loading…';
            state.page += 1;
            await loadFeed(state.search, false);
        });
    } catch (e) {
        feed.innerHTML = `<div class="empty"><div class="big">Couldn’t load</div><div>${escapeHtml(e.message)}</div></div>`;
    } finally {
        state.loading = false;
    }
}

// ---------- detail view ----------

function entryHtml(row) {
    const cat = CAT[row.category] || CAT.other;
    const a = row.actor || {};
    const actorBits = [a.name, a.role, a.phone].filter(Boolean).map(escapeHtml);
    const actorLine = actorBits.length
        ? `<div class="actor ${a.is_known ? '' : 'unknown'}">${escapeHtml(a.name)}${a.role ? ` · <span class="role">${escapeHtml(a.role)}</span>` : ''}${a.phone ? ` · ${escapeHtml(a.phone)}` : ''}</div>`
        : '';

    const changes = (row.changes || []).map((c) => `
        <div class="chg">
            <div class="field">${escapeHtml(c.field)}</div>
            ${c.before && c.before !== 'Empty' ? `<div class="ba"><span class="tag b">WAS</span><div class="val b">${escapeHtml(c.before)}</div></div>` : ''}
            <div class="ba"><span class="tag a">NOW</span><div class="val a">${escapeHtml(c.after)}</div></div>
        </div>`).join('');

    return `
        <div class="node">
            <div class="rail"><div class="ic-sm" style="background:${cat.bg};color:${cat.color}">${icon(row.category, 17)}</div></div>
            <div class="entry">
                <div class="e-top">
                    <span class="summary">${escapeHtml(row.summary)}</span>
                    <span class="ent">${escapeHtml((row.entity_type || '').replace(/_/g, ' '))}</span>
                </div>
                ${actorLine}
                <div class="etime" title="${escapeHtml(fmtAbs(row.edited_at))}">${timeAgo(row.edited_at)} · ${escapeHtml(fmtAbs(row.edited_at))}</div>
                ${changes ? `<div class="changes">${changes}</div>` : ''}
            </div>
        </div>`;
}

async function renderDetail(id) {
    app.innerHTML = `<button class="back" id="back"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg> All invoices</button><div class="spinner"></div>`;
    document.getElementById('back').addEventListener('click', goFeed);

    try {
        const r = await fetch(`/api/invoices/${encodeURIComponent(id)}/detail`);
        const b = await r.json();
        if (!b.ok) throw new Error(b.error || 'Failed to load');
        const { invoice: inv, rows, total } = b.data;

        // group rows by day
        let groups = '';
        let lastDay = null;
        rows.forEach((row) => {
            const day = fmtDayLabel(row.edited_at);
            if (day !== lastDay) {
                if (lastDay !== null) groups += '</div>';
                groups += `<div class="daygroup"><div class="dayline">${escapeHtml(day)}</div>`;
                lastDay = day;
            }
            groups += entryHtml(row);
        });
        if (lastDay !== null) groups += '</div>';

        app.innerHTML = `
            <button class="back" id="back"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg> All invoices</button>
            <div class="head">
                <div class="row1">
                    <h1 class="serif">${escapeHtml(inv.customer_name || inv.invoice_number)}</h1>
                    ${statusPill(inv.status)}
                </div>
                <span class="invno">${escapeHtml(inv.invoice_number)}</span>${inv.customer_phone ? `<span class="phone"> · ${escapeHtml(inv.customer_phone)}</span>` : ''}
                <div class="stats">
                    <div class="stat"><div class="k">Total</div><div class="v">${fmtMoney(inv.total_amount)}</div></div>
                    <div class="stat"><div class="k">Paid</div><div class="v">${fmtMoney(inv.paid_amount)}</div></div>
                    <div class="stat"><div class="k">Balance</div><div class="v">${fmtMoney(inv.balance_due)}</div></div>
                </div>
            </div>
            <div class="tl-head"><h2 class="serif">Activity</h2><span>${total} ${total === 1 ? 'entry' : 'entries'}</span></div>
            <div class="timeline">${rows.length ? groups : '<div class="empty"><div class="big">No activity</div><div>This invoice has no audit log entries.</div></div>'}</div>`;
        document.getElementById('back').addEventListener('click', goFeed);

        const entries = app.querySelectorAll('.entry');
        entries.forEach((el, i) => el.style.animationDelay = `${Math.min(i, 12) * 35}ms`);
        window.scrollTo(0, 0);
    } catch (e) {
        app.innerHTML = `<button class="back" id="back"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg> All invoices</button><div class="empty"><div class="big">Couldn’t load invoice</div><div>${escapeHtml(e.message)}</div></div>`;
        document.getElementById('back').addEventListener('click', goFeed);
    }
}

// ---------- routing ----------

function goDetail(id) {
    history.pushState({ view: 'detail', id }, '', `/?invoice=${encodeURIComponent(id)}`);
    renderDetail(id);
}
function goFeed() {
    history.pushState({ view: 'feed' }, '', '/');
    renderFeedShell();
    loadFeed(state.search, true);
}

function route() {
    const id = new URLSearchParams(location.search).get('invoice');
    if (id) {
        renderDetail(id);
    } else {
        renderFeedShell();
        loadFeed(state.search, true);
    }
}

window.addEventListener('popstate', route);
document.addEventListener('DOMContentLoaded', () => { pingHealth(); route(); });
