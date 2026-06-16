'use strict';

/**
 * Frontend for ee-invoice-history.
 *
 * The timeline rendering is lifted *verbatim* from
 *   E:\Solar Calculator v2\public\templates\my_invoice.html
 * (the `openHistoryModal` function, lines 523-607). Only the API URL has
 * been swapped from `/api/v1/invoices/:bubbleId/history` to this app's
 * `/api/invoices/:bubbleId/history`. Helpers `escapeHtml` and
 * `formatHistoryValue` are also lifted (lines 458-470).
 *
 * The result is a full-page version of the exact modal users see in the
 * parent app — same Tailwind classes, same badges, same "Before / After"
 * grid, same color tokens. No auth wall.
 */

const state = {
    bubbleId: null,
    isLoading: false,
};

// ---------- helpers (lifted from my_invoice.html) ----------

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatHistoryValue(value) {
    const normalized = String(value ?? '').trim();
    return normalized.length > 0 ? normalized : 'Empty';
}

// ---------- health badge ----------

async function pingHealth() {
    const badge = document.getElementById('healthBadge');
    try {
        const res = await fetch('/api/healthz');
        const body = await res.json();
        if (res.ok && body.db === 'up') {
            badge.textContent = 'db: up';
            badge.className = 'text-[10px] sm:text-xs font-medium text-emerald-600 px-2 py-1.5 rounded-md';
        } else {
            badge.textContent = 'db: down';
            badge.className = 'text-[10px] sm:text-xs font-medium text-red-600 px-2 py-1.5 rounded-md';
        }
    } catch (err) {
        badge.textContent = 'db: ?';
        badge.className = 'text-[10px] sm:text-xs font-medium text-amber-600 px-2 py-1.5 rounded-md';
    }
}

// ---------- history rendering (lifted from my_invoice.html, API URL swapped) ----------

async function openHistoryView(bubbleId) {
    const container = document.getElementById('historyList');
    const invoiceTag = document.getElementById('historyInvoice');
    const countTag = document.getElementById('historyCount');

    container.innerHTML = '<div class="text-center py-4"><div class="loading-spinner h-6 w-6 rounded-full mx-auto border-slate-300 border-t-slate-600"></div></div>';
    invoiceTag.textContent = bubbleId;
    countTag.classList.add('hidden');
    const compactLayout = window.matchMedia('(max-width: 640px)').matches;

    try {
        const res = await fetch(`/api/invoices/${encodeURIComponent(bubbleId)}/history`);
        const data = await res.json();
        if (!data.ok) {
            throw new Error(data.error || 'Request failed');
        }
        const rows = data.data.rows || [];
        if (rows.length === 0) {
            container.innerHTML = '<p class="text-center text-slate-500 py-4 text-sm">No history recorded.</p>';
            countTag.textContent = '0 entries';
            countTag.classList.remove('hidden');
            return;
        }

        countTag.textContent = `${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}`;
        countTag.classList.remove('hidden');

        container.innerHTML = rows.map((action, index) => {
            const date = new Date(action.edited_at || action.created_at).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            const isLast = index === rows.length - 1;
            const details = action.details || {};
            const changes = Array.isArray(action.changes) ? action.changes : [];
            const actorParts = [action.edited_by_name, action.edited_by_phone, action.edited_by_role]
                .filter(Boolean)
                .map(escapeHtml);
            const badgeClass = action.action_type === 'ADDED'
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                : action.action_type === 'DELETED'
                    ? 'bg-rose-50 text-rose-700 border-rose-200'
                    : 'bg-blue-50 text-blue-700 border-blue-200';

            return `
                <div class="relative pl-4 sm:pl-5 ${!isLast ? 'pb-4 sm:pb-5 border-l border-slate-200' : ''}">
                    <div class="absolute -left-1.5 top-1.5 h-2.5 w-2.5 rounded-full bg-slate-300 ring-4 ring-white"></div>
                    <div class="flex flex-wrap items-center justify-between gap-2 mb-1">
                        <div class="flex flex-wrap items-center gap-2">
                            <span class="inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] ${badgeClass}">${escapeHtml(action.action_type.replace(/_/g, ' '))}</span>
                            <span class="text-[9px] font-semibold uppercase tracking-[0.12em] text-slate-400">${escapeHtml((action.entity_type || 'invoice').replace(/_/g, ' '))}</span>
                        </div>
                        <span class="text-[9px] text-slate-400 font-mono">${date}</span>
                    </div>
                    <p class="${compactLayout ? 'text-[11px]' : 'text-xs'} font-semibold text-slate-700 mb-1 leading-snug">${escapeHtml(details.description || details.change_summary || 'Update recorded')}</p>
                    ${actorParts.length > 0 ? `<p class="text-[10px] text-slate-500 mb-2 leading-snug">${actorParts.join(' • ')}</p>` : ''}
                    ${changes.length > 0 ? `
                        <div class="space-y-2">
                            ${changes.map((change) => compactLayout ? `
                                <div class="rounded-xl border border-slate-200 bg-slate-50 p-2.5">
                                    <div class="flex items-center justify-between gap-2">
                                        <p class="text-[9px] font-bold uppercase tracking-[0.14em] text-slate-500">${escapeHtml(change.field || 'Updated value')}</p>
                                        <span class="inline-flex items-center rounded-full bg-white px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[0.12em] text-slate-400">Before / After</span>
                                    </div>
                                    <div class="mt-2 space-y-1.5">
                                        <div class="flex gap-2">
                                            <span class="inline-flex shrink-0 items-center rounded-full bg-rose-50 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[0.12em] text-rose-600">B</span>
                                            <p class="min-w-0 flex-1 text-[10px] leading-snug text-slate-600 break-words whitespace-pre-wrap">${escapeHtml(formatHistoryValue(change.before))}</p>
                                        </div>
                                        <div class="flex gap-2">
                                            <span class="inline-flex shrink-0 items-center rounded-full bg-emerald-50 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[0.12em] text-emerald-600">A</span>
                                            <p class="min-w-0 flex-1 text-[10px] leading-snug text-slate-800 break-words whitespace-pre-wrap">${escapeHtml(formatHistoryValue(change.after))}</p>
                                        </div>
                                    </div>
                                </div>
                            ` : `
                                <div class="rounded-xl border border-slate-200 bg-slate-50 p-2.5">
                                    <p class="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">${escapeHtml(change.field || 'Updated value')}</p>
                                    <div class="mt-2 grid gap-2 sm:grid-cols-2">
                                        <div class="rounded-lg border border-rose-100 bg-white p-2">
                                            <p class="text-[9px] font-bold uppercase tracking-[0.16em] text-rose-500">Before</p>
                                            <p class="mt-1 text-[11px] text-slate-600 break-words whitespace-pre-wrap">${escapeHtml(formatHistoryValue(change.before))}</p>
                                        </div>
                                        <div class="rounded-lg border border-emerald-100 bg-white p-2">
                                            <p class="text-[9px] font-bold uppercase tracking-[0.16em] text-emerald-600">After</p>
                                            <p class="mt-1 text-[11px] text-slate-800 break-words whitespace-pre-wrap">${escapeHtml(formatHistoryValue(change.after))}</p>
                                        </div>
                                    </div>
                                </div>
                            `).join('')}
                            ${!compactLayout && changes.length > 3 ? `<p class="text-[10px] font-medium text-slate-400">+ ${changes.length - 3} more changes</p>` : ''}
                        </div>
                    ` : ''}
                </div>
            `;
        }).join('');
    } catch (err) {
        container.innerHTML = `<p class="text-red-500 text-center text-xs">${escapeHtml(err.message)}</p>`;
        countTag.classList.add('hidden');
    }
}

// ---------- search flow ----------

function setLoading(isLoading) {
    const btn = document.getElementById('loadBtn');
    btn.disabled = isLoading;
    btn.innerHTML = isLoading
        ? '<div class="loading-spinner h-3 w-3 rounded-full"></div> Loading…'
        : '<i class="fa-solid fa-magnifying-glass"></i> Load';
}

function setHint(text, isError = false) {
    const hint = document.getElementById('searchHint');
    hint.textContent = text;
    hint.classList.toggle('text-red-500', isError);
    hint.classList.toggle('text-slate-400', !isError);
}

async function onSearchSubmit(event) {
    event.preventDefault();
    const input = document.getElementById('bubbleIdInput');
    const bubbleId = (input.value || '').trim();
    if (!bubbleId) return;

    setLoading(true);
    setHint('Loading…');
    state.bubbleId = bubbleId;
    await openHistoryView(bubbleId);
    setLoading(false);
}

// ---------- wire up ----------

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('searchForm').addEventListener('submit', onSearchSubmit);
    pingHealth();

    // Deep-link via ?bubbleId=...
    const params = new URLSearchParams(window.location.search);
    const initial = (params.get('bubbleId') || '').trim();
    if (initial) {
        document.getElementById('bubbleIdInput').value = initial;
        onSearchSubmit(new Event('submit', { cancelable: true }));
    }
});
