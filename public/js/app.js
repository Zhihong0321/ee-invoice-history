'use strict';

/**
 * Frontend for ee-invoice-history.
 *
 * Lifts the timeline rendering shape from
 *   E:\Solar Calculator v2\public\templates\my_invoice.html
 * (the `openHistoryModal` function and its `escapeHtml` / `formatHistoryValue`
 * helpers). The original was a modal; this version inlines the same
 * timeline into a full page with a search input and a second tab for
 * viewer-activity.
 */

const TZ = 'Asia/Kuala_Lumpur';
const LOCALE = 'en-MY';

const state = {
    bubbleId: null,
    activeTab: 'history',
    history: null,           // { invoiceId, rows: [] }
    activity: null,          // { invoiceId, invoiceNumber, summary, events }
    activeTabSwitchInFlight: false,
};

// ---------- helpers ----------

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

function formatDateTime(input) {
    if (!input) return '—';
    try {
        return new Date(input).toLocaleString(LOCALE, {
            timeZone: TZ,
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch (err) {
        return String(input);
    }
}

function formatDuration(seconds) {
    if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}m ${s}s`;
}

function badgeClassFor(actionType) {
    if (actionType === 'ADDED') return 'badge badge--added';
    if (actionType === 'DELETED') return 'badge badge--deleted';
    return 'badge badge--updated';
}

// ---------- API ----------

async function fetchJson(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    let body = null;
    try {
        body = await res.json();
    } catch (err) {
        throw new Error(`Bad JSON from server (${res.status})`);
    }
    if (!res.ok || body.ok === false) {
        throw new Error((body && body.error) || `Request failed (${res.status})`);
    }
    return body.data;
}

async function loadHistory(bubbleId) {
    return fetchJson(`/api/invoices/${encodeURIComponent(bubbleId)}/history`);
}

async function loadActivity(bubbleId) {
    return fetchJson(`/api/invoices/${encodeURIComponent(bubbleId)}/viewer-activity`);
}

async function pingHealth() {
    const badge = document.getElementById('healthBadge');
    try {
        const res = await fetch('/api/healthz');
        const body = await res.json();
        if (res.ok && body.db === 'up') {
            badge.textContent = 'db: up';
            badge.className = 'badge badge--ok';
        } else {
            badge.textContent = 'db: down';
            badge.className = 'badge badge--err';
        }
    } catch (err) {
        badge.textContent = 'db: ?';
        badge.className = 'badge badge--err';
    }
}

// ---------- rendering: history ----------

function renderHistoryRows(rows) {
    if (!rows || rows.length === 0) {
        return '<p class="empty">No history recorded for this invoice.</p>';
    }

    const compactLayout = window.matchMedia('(max-width: 640px)').matches;

    return rows.map((action, index) => {
        const isLast = index === rows.length - 1;
        const details = action.details || {};
        const changes = Array.isArray(action.changes) ? action.changes : [];
        const date = formatDateTime(action.edited_at || action.created_at);
        const actorParts = [action.edited_by_name, action.edited_by_phone, action.edited_by_role]
            .filter(Boolean)
            .map(escapeHtml);

        return `
            <article class="timeline-item ${!isLast ? 'timeline-item--has-next' : ''}">
                <span class="timeline-dot" aria-hidden="true"></span>
                <div class="timeline-head">
                    <div class="timeline-head__left">
                        <span class="${badgeClassFor(action.action_type)}">${escapeHtml(action.action_type.replace(/_/g, ' '))}</span>
                        <span class="entity-tag">${escapeHtml((action.entity_type || 'invoice').replace(/_/g, ' '))}</span>
                    </div>
                    <time class="timeline-head__time" datetime="${escapeHtml(action.edited_at || '')}">${escapeHtml(date)}</time>
                </div>
                <p class="timeline-desc">${escapeHtml(details.description || 'Update recorded')}</p>
                ${actorParts.length > 0 ? `<p class="timeline-actor">${actorParts.join(' • ')}</p>` : ''}
                ${changes.length > 0 ? renderChanges(changes, compactLayout) : ''}
            </article>
        `;
    }).join('');
}

function renderChanges(changes, compactLayout) {
    const items = changes.map((change) => {
        const field = escapeHtml(change.field || 'Updated value');
        const before = escapeHtml(formatHistoryValue(change.before));
        const after = escapeHtml(formatHistoryValue(change.after));
        if (compactLayout) {
            return `
                <div class="change change--compact">
                    <div class="change__head">
                        <p class="change__field">${field}</p>
                        <span class="change__pill">Before / After</span>
                    </div>
                    <div class="change__body">
                        <div class="change__row">
                            <span class="change__letter change__letter--b">B</span>
                            <p class="change__value change__value--b">${before}</p>
                        </div>
                        <div class="change__row">
                            <span class="change__letter change__letter--a">A</span>
                            <p class="change__value change__value--a">${after}</p>
                        </div>
                    </div>
                </div>
            `;
        }
        return `
            <div class="change">
                <p class="change__field">${field}</p>
                <div class="change__grid">
                    <div class="change__col change__col--b">
                        <p class="change__col-label">Before</p>
                        <p class="change__value">${before}</p>
                    </div>
                    <div class="change__col change__col--a">
                        <p class="change__col-label">After</p>
                        <p class="change__value">${after}</p>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    const overflow = !compactLayout && changes.length > 3
        ? `<p class="change-overflow">+ ${changes.length - 3} more changes</p>`
        : '';

    return `<div class="changes">${items}${overflow}</div>`;
}

function renderHistory(data) {
    const container = document.getElementById('historyContainer');
    if (!data) {
        container.innerHTML = '<p class="empty">Invoice not found.</p>';
        return;
    }
    container.innerHTML = `
        <header class="panel-head">
            <h2>${escapeHtml(data.invoiceId)}</h2>
            <span class="panel-head__count">${data.rows.length} entr${data.rows.length === 1 ? 'y' : 'ies'}</span>
        </header>
        <div class="timeline">${renderHistoryRows(data.rows)}</div>
    `;
}

// ---------- rendering: viewer activity ----------

function renderActivitySummary(summary) {
    if (!summary) return '';
    return `
        <div class="summary__grid">
            <div class="summary__cell">
                <span class="summary__num">${summary.total_events}</span>
                <span class="summary__label">Events</span>
            </div>
            <div class="summary__cell">
                <span class="summary__num">${summary.invoice_views}</span>
                <span class="summary__label">Invoice views</span>
            </div>
            <div class="summary__cell">
                <span class="summary__num">${summary.proposal_views}</span>
                <span class="summary__label">Proposal views</span>
            </div>
            <div class="summary__cell">
                <span class="summary__num">${summary.button_clicks}</span>
                <span class="summary__label">Button clicks</span>
            </div>
            <div class="summary__cell">
                <span class="summary__num">${summary.unique_visitors}</span>
                <span class="summary__label">Unique visitors</span>
            </div>
            <div class="summary__cell">
                <span class="summary__num">${formatDuration(summary.average_duration_seconds)}</span>
                <span class="summary__label">Avg duration</span>
            </div>
        </div>
        <p class="summary__last">Last activity: <time>${escapeHtml(formatDateTime(summary.last_activity_at))}</time></p>
    `;
}

function renderActivity(data) {
    const container = document.getElementById('activityContainer');
    const summaryEl = document.getElementById('activitySummary');

    if (!data) {
        summaryEl.hidden = true;
        container.innerHTML = '<p class="empty">Invoice not found.</p>';
        return;
    }

    summaryEl.hidden = false;
    summaryEl.innerHTML = renderActivitySummary(data.summary);

    if (!data.events || data.events.length === 0) {
        container.innerHTML = `
            <header class="panel-head">
                <h2>${escapeHtml(data.invoiceNumber || data.invoiceId)}</h2>
                <span class="panel-head__count">0 events</span>
            </header>
            <p class="empty">No viewer activity recorded.</p>
        `;
        return;
    }

    const rows = data.events.map((event) => {
        const eventType = escapeHtml((event.event_type || '').replace(/_/g, ' ') || 'event');
        const viewer = escapeHtml(event.visitor_label || (event.device_hash ? `device ${event.device_hash.slice(0, 8)}` : 'unknown'));
        const pageType = event.page_type ? escapeHtml(event.page_type) : '';
        const button = event.button_name ? escapeHtml(event.button_name) : '';
        const duration = formatDuration(event.duration_seconds);
        const time = formatDateTime(event.viewed_at || event.created_at);
        const viewerType = escapeHtml(event.viewer_type || '');

        return `
            <article class="activity-row">
                <div class="activity-row__head">
                    <span class="${badgeClassFor('UPDATED')}">${eventType}</span>
                    ${viewerType ? `<span class="viewer-tag">${viewerType}</span>` : ''}
                    <time class="activity-row__time">${escapeHtml(time)}</time>
                </div>
                <p class="activity-row__visitor">${viewer}</p>
                <div class="activity-row__meta">
                    ${pageType ? `<span><strong>Page:</strong> ${pageType}</span>` : ''}
                    ${button ? `<span><strong>Button:</strong> ${button}</span>` : ''}
                    <span><strong>Duration:</strong> ${escapeHtml(duration)}</span>
                    ${event.device_hash ? `<span class="activity-row__hash" title="${escapeHtml(event.device_hash)}">${escapeHtml(event.device_hash.slice(0, 12))}…</span>` : ''}
                </div>
            </article>
        `;
    }).join('');

    container.innerHTML = `
        <header class="panel-head">
            <h2>${escapeHtml(data.invoiceNumber || data.invoiceId)}</h2>
            <span class="panel-head__count">${data.events.length} event${data.events.length === 1 ? '' : 's'}</span>
        </header>
        <div class="activity-list">${rows}</div>
    `;
}

// ---------- tabs ----------

function switchTab(tabName) {
    state.activeTab = tabName;
    document.querySelectorAll('.tab').forEach((btn) => {
        const isActive = btn.dataset.tab === tabName;
        btn.classList.toggle('is-active', isActive);
        btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    document.querySelectorAll('.tab-panel').forEach((panel) => {
        const isActive = panel.id === `tab-${tabName}`;
        panel.classList.toggle('is-active', isActive);
        panel.hidden = !isActive;
    });

    // Lazy-load viewer activity the first time the tab is opened.
    if (tabName === 'activity' && state.bubbleId && !state.activity) {
        fetchActivity(state.bubbleId);
    }
}

// ---------- search flow ----------

function setLoading(isLoading) {
    const btn = document.getElementById('loadBtn');
    btn.disabled = isLoading;
    btn.textContent = isLoading ? 'Loading…' : 'Load';
}

function setHint(text, isError = false) {
    const hint = document.getElementById('searchHint');
    hint.textContent = text;
    hint.classList.toggle('search__hint--err', isError);
}

async function fetchHistory(bubbleId) {
    const container = document.getElementById('historyContainer');
    container.innerHTML = '<div class="loading">Loading history…</div>';
    try {
        const data = await loadHistory(bubbleId);
        state.history = data;
        renderHistory(data);
        setHint(`Loaded history for ${bubbleId}.`);
    } catch (err) {
        state.history = null;
        container.innerHTML = `<p class="empty empty--err">${escapeHtml(err.message)}</p>`;
        setHint(err.message, true);
    }
}

async function fetchActivity(bubbleId) {
    const container = document.getElementById('activityContainer');
    const summaryEl = document.getElementById('activitySummary');
    summaryEl.hidden = true;
    container.innerHTML = '<div class="loading">Loading viewer activity…</div>';
    try {
        const data = await loadActivity(bubbleId);
        state.activity = data;
        renderActivity(data);
    } catch (err) {
        state.activity = null;
        container.innerHTML = `<p class="empty empty--err">${escapeHtml(err.message)}</p>`;
    }
}

async function onSearchSubmit(event) {
    event.preventDefault();
    const input = document.getElementById('bubbleIdInput');
    const bubbleId = (input.value || '').trim();
    if (!bubbleId) return;

    setLoading(true);
    setHint('Loading…');
    state.bubbleId = bubbleId;
    state.history = null;
    state.activity = null;

    // Always fetch history. Fetch activity only if the user is already on that tab.
    const historyPromise = fetchHistory(bubbleId);
    const activityPromise = state.activeTab === 'activity' ? fetchActivity(bubbleId) : Promise.resolve();

    await Promise.all([historyPromise, activityPromise]);
    setLoading(false);
}

// ---------- wire up ----------

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('searchForm').addEventListener('submit', onSearchSubmit);
    document.querySelectorAll('.tab').forEach((btn) => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
    pingHealth();

    // Allow deep-linking via ?bubbleId=...
    const params = new URLSearchParams(window.location.search);
    const initial = (params.get('bubbleId') || '').trim();
    if (initial) {
        const input = document.getElementById('bubbleIdInput');
        input.value = initial;
        onSearchSubmit(new Event('submit', { cancelable: true }));
    }
});
