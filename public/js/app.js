'use strict';

/**
 * ee-invoice-history — browse, search and view frontend.
 * Rebuilt 100% using the premium template_new design system.
 */

// Application State
const state = {
    theme: localStorage.getItem('theme') || 'light',
    view: 'feed', // 'feed' | 'detail'
    invoiceId: null,
    searchQuery: '',
    filter: 'all',
    invoices: [], // full loaded list of invoices (for client-side search/filter counts)
    invoiceDetail: null, // loaded detail data (invoice header meta + history rows)
    loading: false,
    health: 'connecting' // 'connecting' | 'live' | 'db_down' | 'offline'
};

// Colors and Visual Definitions mapping to template_new
const CATEGORIES = {
    created:  { label: 'Created',  color: '#2563EB' },
    sent:     { label: 'Sent',     color: '#7C3AED' },
    viewed:   { label: 'Viewed',   color: '#64748B' },
    payment:  { label: 'Payment',  color: '#059669' },
    updated:  { label: 'Updated',  color: '#D97706' },
    refunded: { label: 'Refunded', color: '#EA580C' },
    voided:   { label: 'Voided',   color: '#DC2626' },
    reminder: { label: 'Reminder', color: '#0891B2' },
    other:    { label: 'Activity', color: '#64748B' }
};

const STATUS_COLORS = {
    draft:             '#64748B',
    paid:              '#059669',
    payment_submitted: '#2563EB',
    deleted:           '#DC2626',
    updated:           '#D97706',
    sent:              '#7C3AED',
    overdue:           '#DC2626',
    void:              '#DC2626',
    refunded:          '#EA580C',
    default:           '#64748B'
};

// Helpers for parsing & formatting
function escapeHtml(v) {
    return String(v ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function fmtMoney(n) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    const num = Number(n);
    return 'RM ' + num.toLocaleString('en-MY', {
        minimumFractionDigits: num % 1 ? 2 : 0,
        maximumFractionDigits: 2
    });
}

function getDayLabel(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const today = new Date();
    const y = new Date();
    y.setDate(today.getDate() - 1);
    const same = (a, b) => a.toDateString() === b.toDateString();
    
    if (same(d, today)) return 'Today';
    if (same(d, y)) return 'Yesterday';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getEventTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    });
}

function getInitials(name) {
    if (!name) return '??';
    return name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
}

function applyTheme() {
    const isDark = state.theme === 'dark';
    document.body.className = isDark ? 'theme-dark' : 'theme-light';
    localStorage.setItem('theme', state.theme);
}

function toggleTheme() {
    state.theme = state.theme === 'light' ? 'dark' : 'light';
    applyTheme();
    renderHeader();
}

// Health Check Probe
async function checkHealth() {
    try {
        const r = await fetch('/api/healthz');
        const b = await r.json();
        if (r.ok && b.db === 'up') {
            state.health = 'live';
        } else {
            state.health = 'db_down';
        }
    } catch (e) {
        state.health = 'offline';
    }
    const indicator = document.getElementById('health-indicator');
    const statusText = document.getElementById('health-text');
    if (indicator && statusText) {
        if (state.health === 'live') {
            indicator.style.background = '#22C55E';
            indicator.style.boxShadow = '0 0 0 3px color-mix(in srgb, #22C55E 22%, transparent)';
            statusText.textContent = 'Live · audit & activity log';
        } else if (state.health === 'db_down') {
            indicator.style.background = '#EA580C';
            indicator.style.boxShadow = '0 0 0 3px color-mix(in srgb, #EA580C 22%, transparent)';
            statusText.textContent = 'Database down';
        } else {
            indicator.style.background = '#EF4444';
            indicator.style.boxShadow = '0 0 0 3px color-mix(in srgb, #EF4444 22%, transparent)';
            statusText.textContent = 'Offline';
        }
    }
}

// Render the Header / Top Chrome area
function renderHeader() {
    const headerEl = document.getElementById('view-header');
    if (!headerEl) return;

    const isDark = state.theme === 'dark';
    const mix = isDark ? 22 : 13;

    if (state.view === 'feed') {
        headerEl.innerHTML = `
            <div style="position:sticky; top:0; z-index:30; background:color-mix(in srgb, var(--surface) 84%, transparent); backdrop-filter:blur(16px); -webkit-backdrop-filter:blur(16px); border-bottom:1px solid var(--border); padding:14px 16px 12px;">
                <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
                    <div style="display:flex; align-items:center; gap:11px; min-width:0;">
                        <div style="width:36px; height:36px; flex:0 0 36px; border-radius:11px; background:var(--accent); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2.5px; box-shadow:0 2px 8px color-mix(in srgb, var(--accent) 40%, transparent);">
                            <span style="width:15px; height:2px; border-radius:2px; background:rgba(255,255,255,.95);"></span>
                            <span style="width:15px; height:2px; border-radius:2px; background:rgba(255,255,255,.6);"></span>
                            <span style="width:9px; height:2px; border-radius:2px; background:rgba(255,255,255,.95);"></span>
                        </div>
                        <div style="min-width:0;">
                            <div style="font-size:16px; font-weight:700; color:var(--text); letter-spacing:-.01em; line-height:1.1;">Invoice History</div>
                            <div style="display:flex; align-items:center; gap:6px; margin-top:3px;">
                                <span id="health-indicator" style="width:6px; height:6px; border-radius:50%; background:#22C55E; animation:ihpulse 2.4s ease-in-out infinite; box-shadow:0 0 0 3px color-mix(in srgb,#22C55E 22%, transparent);"></span>
                                <span id="health-text" style="font-size:11.5px; color:var(--text2); font-weight:500;">Live · audit &amp; activity log</span>
                            </div>
                        </div>
                    </div>

                    <button id="btn-theme-toggle" aria-label="Toggle theme" style="width:38px; height:38px; flex:0 0 38px; border-radius:11px; border:1px solid var(--border); background:var(--surface); display:flex; align-items:center; justify-content:center; cursor:pointer; color:var(--text2); outline:none;">
                        ${isDark ? `
                            <span style="width:14px; height:14px; border-radius:50%; background:var(--accent); box-shadow:0 0 0 2px color-mix(in srgb, var(--accent) 32%, transparent);"></span>
                        ` : `
                            <span style="position:relative; width:16px; height:16px; display:block;">
                                <span style="position:absolute; inset:0; border-radius:50%; background:var(--text2);"></span>
                                <span style="position:absolute; top:-3px; right:-3px; width:13px; height:13px; border-radius:50%; background:var(--surface);"></span>
                            </span>
                        `}
                    </button>
                </div>

                <!-- SEARCH -->
                <div style="position:relative; margin-top:13px;">
                    <span style="position:absolute; left:13px; top:50%; transform:translateY(-50%); pointer-events:none; display:flex;">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.5" y2="16.5"></line></svg>
                    </span>
                    <input id="input-search" value="${escapeHtml(state.searchQuery)}" placeholder="Search invoice, person, customer…" style="width:100%; height:42px; border-radius:12px; border:1px solid var(--border); background:var(--surface2); padding:0 14px 0 38px; font-size:14px; font-family:inherit; color:var(--text); outline:none;">
                </div>

                <!-- FILTER CHIPS -->
                <div id="filter-chips" style="display:flex; gap:8px; overflow-x:auto; margin:11px -16px 0; padding:1px 16px 2px;">
                    <!-- Filter chips dynamically populated -->
                </div>
            </div>
        `;

        // Render live count filter chips
        renderFilterChips();

        // Attach events
        document.getElementById('btn-theme-toggle').onclick = toggleTheme;
        const searchInput = document.getElementById('input-search');
        let debounceTimer;
        searchInput.oninput = (e) => {
            state.searchQuery = e.target.value;
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                renderFeedTimeline();
            }, 100);
        };
    } else {
        // Detail View Header
        const detail = state.invoiceDetail;
        if (!detail) return;

        const statusColor = STATUS_COLORS[detail.invoice.status] || STATUS_COLORS.default;
        const statusText = detail.invoice.status ? detail.invoice.status.replace(/_/g, ' ') : 'draft';

        headerEl.innerHTML = `
            <div style="position:sticky; top:0; z-index:30; background:color-mix(in srgb, var(--surface) 84%, transparent); backdrop-filter:blur(16px); -webkit-backdrop-filter:blur(16px); border-bottom:1px solid var(--border); padding:10px 16px 10px;">
                <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
                    <button id="btn-back" style="display:inline-flex; align-items:center; gap:6px; border:0; background:transparent; color:var(--text2); font-size:13.5px; font-weight:600; cursor:pointer; padding:8px 0; font-family:inherit; outline:none;">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
                        All Invoices
                    </button>
                    
                    <button id="btn-theme-toggle" aria-label="Toggle theme" style="width:38px; height:38px; flex:0 0 38px; border-radius:11px; border:1px solid var(--border); background:var(--surface); display:flex; align-items:center; justify-content:center; cursor:pointer; color:var(--text2); outline:none;">
                        ${isDark ? `
                            <span style="width:14px; height:14px; border-radius:50%; background:var(--accent); box-shadow:0 0 0 2px color-mix(in srgb, var(--accent) 32%, transparent);"></span>
                        ` : `
                            <span style="position:relative; width:16px; height:16px; display:block;">
                                <span style="position:absolute; inset:0; border-radius:50%; background:var(--text2);"></span>
                                <span style="position:absolute; top:-3px; right:-3px; width:13px; height:13px; border-radius:50%; background:var(--surface);"></span>
                            </span>
                        `}
                    </button>
                </div>
            </div>
            
            <!-- Invoice Meta Summary Card -->
            <div class="animated-fadein" style="margin:16px 16px 4px; background:var(--surface); border:1px solid var(--border); border-radius:15px; box-shadow:var(--shadow); padding:13px 14px;">
                <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
                    <h1 style="font-size:17px; font-weight:700; color:var(--text); margin:0; letter-spacing:-.01em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:250px;">
                        ${escapeHtml(detail.invoice.customer_name || 'No customer linked')}
                    </h1>
                    <span style="display:inline-flex; align-items:center; height:23px; padding:0 9px; border-radius:8px; background:color-mix(in srgb, ${statusColor} ${mix}%, transparent); color:${statusColor}; font-size:11px; font-weight:600; text-transform:capitalize; white-space:nowrap;">
                        ${escapeHtml(statusText)}
                    </span>
                </div>
                <div style="display:flex; align-items:center; gap:7px; margin-top:4px; font-size:12.5px; color:var(--text2);">
                    <span style="font-family:'IBM Plex Mono',monospace; color:var(--accent); font-weight:500;">${escapeHtml(detail.invoice.invoice_number)}</span>
                    ${detail.invoice.customer_phone ? `
                        <span style="color:var(--text3);">·</span>
                        <span>${escapeHtml(detail.invoice.customer_phone)}</span>
                    ` : ''}
                </div>
                
                <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; margin-top:12px;">
                    <div style="background:var(--surface2); border:1px solid var(--border); border-radius:10px; padding:7px 9px;">
                        <div style="font-size:9.5px; font-weight:600; text-transform:uppercase; letter-spacing:.05em; color:var(--text3);">Total</div>
                        <div style="font-family:'IBM Plex Mono',monospace; font-size:12.5px; font-weight:600; color:var(--text); margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                            ${fmtMoney(detail.invoice.total_amount)}
                        </div>
                    </div>
                    <div style="background:var(--surface2); border:1px solid var(--border); border-radius:10px; padding:7px 9px;">
                        <div style="font-size:9.5px; font-weight:600; text-transform:uppercase; letter-spacing:.05em; color:var(--text3);">Paid</div>
                        <div style="font-family:'IBM Plex Mono',monospace; font-size:12.5px; font-weight:600; color:#059669; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                            ${fmtMoney(detail.invoice.paid_amount)}
                        </div>
                    </div>
                    <div style="background:var(--surface2); border:1px solid var(--border); border-radius:10px; padding:7px 9px;">
                        <div style="font-size:9.5px; font-weight:600; text-transform:uppercase; letter-spacing:.05em; color:var(--text3);">Balance</div>
                        <div style="font-family:'IBM Plex Mono',monospace; font-size:12.5px; font-weight:600; color:${detail.invoice.balance_due > 0 ? '#EA580C' : '#059669'}; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                            ${fmtMoney(detail.invoice.balance_due)}
                        </div>
                    </div>
                </div>
            </div>
        `;

        document.getElementById('btn-back').onclick = navigateToFeed;
        document.getElementById('btn-theme-toggle').onclick = toggleTheme;
    }
    
    // Always check/update health probe values
    checkHealth();
}

// Compute live counts and render filter chips
function renderFilterChips() {
    const chipsContainer = document.getElementById('filter-chips');
    if (!chipsContainer) return;

    const countFor = (id) => {
        return state.invoices.filter(inv => {
            if (id === 'all') return true;
            if (id === 'payment') return inv.last_category === 'payment' || inv.last_category === 'refunded';
            if (id === 'sent') return inv.last_category === 'sent' || inv.last_category === 'reminder';
            return inv.last_category === id;
        }).length;
    };

    const chips = [
        { id: 'all',      label: 'All' },
        { id: 'created',  label: 'Created' },
        { id: 'sent',     label: 'Sent' },
        { id: 'viewed',   label: 'Viewed' },
        { id: 'payment',  label: 'Payments' },
        { id: 'updated',  label: 'Edits' },
        { id: 'voided',   label: 'Voided' }
    ];

    chipsContainer.innerHTML = chips.map(chip => {
        const active = state.filter === chip.id;
        const count = countFor(chip.id);
        const countStyle = active
            ? 'font-size:11px; font-weight:600; opacity:.85; font-variant-numeric:tabular-nums; margin-left:5px;'
            : 'font-size:11px; font-weight:600; color:var(--text3); font-variant-numeric:tabular-nums; margin-left:5px;';
        
        const style = `
            flex:0 0 auto;
            display:inline-flex;
            align-items:center;
            height:34px;
            padding:0 14px;
            border-radius:999px;
            font-size:13px;
            font-weight:500;
            font-family:inherit;
            white-space:nowrap;
            cursor:pointer;
            border:1px solid ${active ? 'transparent' : 'var(--border)'};
            background:${active ? 'var(--accent)' : 'var(--surface)'};
            color:${active ? '#FFFFFF' : 'var(--text2)'};
            outline:none;
        `;

        return `
            <button class="filter-chip" data-id="${chip.id}" style="${style}">
                ${chip.label}
                ${count > 0 ? `<span style="${countStyle}">${count}</span>` : ''}
            </button>
        `;
    }).join('');

    // Attach click events
    chipsContainer.querySelectorAll('.filter-chip').forEach(btn => {
        btn.onclick = () => {
            state.filter = btn.dataset.id;
            renderFilterChips();
            renderFeedTimeline();
        };
    });
}

// Filter and search logic on the feed invoices list
function getFilteredInvoices() {
    const q = state.searchQuery.trim().toLowerCase();
    
    return state.invoices.filter(inv => {
        // Search filter
        const matchSearch = !q || 
            (inv.invoice_number + ' ' + (inv.customer_name || '') + ' ' + (inv.last_label || '')).toLowerCase().includes(q);
        
        if (!matchSearch) return false;

        // Chip filter
        const f = state.filter;
        if (f === 'all') return true;
        if (f === 'payment') return inv.last_category === 'payment' || inv.last_category === 'refunded';
        if (f === 'sent') return inv.last_category === 'sent' || inv.last_category === 'reminder';
        return inv.last_category === f;
    });
}

// Group array items by day
function groupEventsByDay(events, keyName) {
    const groups = [];
    events.forEach(e => {
        const day = getDayLabel(e[keyName]);
        let g = groups.find(x => x.label === day);
        if (!g) {
            g = { label: day, events: [], count: 0 };
            groups.push(g);
        }
        g.events.push(e);
        g.count = g.events.length;
    });
    return groups;
}

// Render the Timeline for Feed view
function renderFeedTimeline() {
    const container = document.getElementById('view-content');
    if (!container) return;

    if (state.loading && state.invoices.length === 0) {
        container.innerHTML = `
            <div style="text-align:center; padding:60px 24px; color:var(--text3);">
                <div style="font-size:15px; font-weight:600; color:var(--text2);">Loading invoices...</div>
            </div>
        `;
        return;
    }

    const filtered = getFilteredInvoices();
    if (filtered.length === 0) {
        container.innerHTML = `
            <div style="text-align:center; padding:60px 24px; color:var(--text3);">
                <div style="font-size:15px; font-weight:600; color:var(--text2);">No matching events</div>
                <div style="font-size:13px; margin-top:5px;">Try a different search or filter.</div>
            </div>
        `;
        return;
    }

    const isDark = state.theme === 'dark';
    const mix = isDark ? 22 : 13;

    // Group invoices by last_activity date
    const groups = groupEventsByDay(filtered, 'last_activity');

    let html = '';
    let staggerCounter = 0;

    groups.forEach(g => {
        html += `
            <div style="margin-top:16px;">
                <div style="display:flex; align-items:center; gap:10px; margin:0 2px 4px;">
                    <span style="font-size:11.5px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--text3);">${escapeHtml(g.label)}</span>
                    <span style="flex:1; height:1px; background:var(--border);"></span>
                    <span style="font-size:11.5px; color:var(--text3); font-variant-numeric:tabular-nums;">${g.count}</span>
                </div>
        `;

        g.events.forEach(inv => {
            const meta = CATEGORIES[inv.last_category] || CATEGORIES.other;
            const statusColor = STATUS_COLORS[inv.status] || STATUS_COLORS.default;
            const statusText = inv.status ? inv.status.replace(/_/g, ' ') : 'draft';
            const staggerClass = staggerCounter < 8 ? `stagger-${staggerCounter}` : '';
            staggerCounter++;

            html += `
                <div class="animated-fadein ${staggerClass}" style="display:flex; gap:12px; cursor:pointer;" onclick="navigateToDetail(${inv.invoice_id})">
                    <!-- rail -->
                    <div style="position:relative; width:16px; flex:0 0 16px;">
                        <span style="position:absolute; left:7px; top:0; bottom:0; width:2px; background:var(--border);"></span>
                        <span style="position:absolute; left:1px; top:20px; width:14px; height:14px; border-radius:50%; background:${meta.color}; border:3px solid var(--bg);"></span>
                    </div>
                    <!-- card -->
                    <div style="flex:1; min-width:0; margin-bottom:12px; background:var(--surface); border:1px solid var(--border); border-radius:15px; box-shadow:var(--shadow); padding:13px 14px; transition:transform 0.15s ease;" onmouseenter="this.style.transform='translateY(-2px)'" onmouseleave="this.style.transform='none'">
                        <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
                            <span style="display:inline-flex; align-items:center; gap:6px; height:23px; padding:0 9px; border-radius:8px; background:color-mix(in srgb, ${meta.color} ${mix}%, transparent); color:${meta.color}; font-size:11.5px; font-weight:600; letter-spacing:.01em;">
                                <span style="width:6px; height:6px; border-radius:50%; background:${meta.color};"></span>${escapeHtml(meta.label)}
                            </span>
                            <span style="display:inline-flex; align-items:center; height:23px; padding:0 9px; border-radius:8px; background:color-mix(in srgb, ${statusColor} ${mix}%, transparent); color:${statusColor}; font-size:11px; font-weight:600; text-transform:capitalize; white-space:nowrap;">${escapeHtml(statusText)}</span>
                        </div>

                        <div style="margin-top:10px; font-size:14.5px; font-weight:600; color:var(--text); line-height:1.35; letter-spacing:-.005em;">
                            ${escapeHtml(inv.customer_name || 'No customer linked')}
                        </div>

                        <div style="display:flex; align-items:center; gap:7px; margin-top:4px; font-size:12.5px; color:var(--text2); min-width:0;">
                            <span style="font-family:'IBM Plex Mono',monospace; color:var(--accent); font-weight:500;">${escapeHtml(inv.invoice_number)}</span>
                            <span style="color:var(--text3);">·</span>
                            <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                                ${escapeHtml(inv.last_label)} · ${inv.event_count} ${inv.event_count === 1 ? 'event' : 'events'}
                            </span>
                        </div>

                        ${inv.total_amount !== null ? `
                            <div style="display:inline-flex; align-items:baseline; gap:3px; margin-top:11px; padding:7px 13px; border-radius:10px; background:color-mix(in srgb, var(--accent) ${mix}%, transparent); color:var(--accent); font-family:'IBM Plex Mono',monospace; font-weight:600; font-size:16px;">
                                ${fmtMoney(inv.total_amount)}
                            </div>
                        ` : ''}

                        <div style="display:flex; align-items:center; gap:8px; margin-top:12px; padding-top:11px; border-top:1px solid var(--border);">
                            <span style="font-size:12px; color:var(--text3); font-variant-numeric:tabular-nums; white-space:nowrap;">
                                Last active: ${getEventTime(inv.last_activity)}
                            </span>
                        </div>
                    </div>
                </div>
            `;
        });
        html += '</div>';
    });

    html += '<div style="text-align:center; padding:22px 0 8px; font-size:11.5px; color:var(--text3); font-family:\'IBM Plex Mono\',monospace;">— end of log · invoice_history_feed —</div>';

    container.innerHTML = html;
}

// Render the Timeline for Detail View
function renderDetailTimeline() {
    const container = document.getElementById('view-content');
    if (!container) return;

    const detail = state.invoiceDetail;
    if (!detail) {
        container.innerHTML = `
            <div style="text-align:center; padding:60px 24px; color:var(--text3);">
                <div style="font-size:15px; font-weight:600; color:var(--text2);">Loading timeline...</div>
            </div>
        `;
        return;
    }

    if (detail.rows.length === 0) {
        container.innerHTML = `
            <div style="text-align:center; padding:60px 24px; color:var(--text3);">
                <div style="font-size:15px; font-weight:600; color:var(--text2);">No activity</div>
                <div style="font-size:13px; margin-top:5px;">This invoice has no audit log entries.</div>
            </div>
        `;
        return;
    }

    const isDark = state.theme === 'dark';
    const mix = isDark ? 22 : 13;

    // Group audit log rows by date
    const groups = groupEventsByDay(detail.rows, 'edited_at');

    let html = '';
    let staggerCounter = 0;

    groups.forEach(g => {
        html += `
            <div style="margin-top:16px;">
                <div style="display:flex; align-items:center; gap:10px; margin:0 2px 4px;">
                    <span style="font-size:11.5px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--text3);">${escapeHtml(g.label)}</span>
                    <span style="flex:1; height:1px; background:var(--border);"></span>
                    <span style="font-size:11.5px; color:var(--text3); font-variant-numeric:tabular-nums;">${g.count}</span>
                </div>
        `;

        g.events.forEach(ev => {
            const meta = CATEGORIES[ev.category] || CATEGORIES.other;
            const isSystem = ev.actor && ev.actor.role === 'system';
            const initials = isSystem ? '' : getInitials(ev.actor ? ev.actor.name : '');
            
            const staggerClass = staggerCounter < 8 ? `stagger-${staggerCounter}` : '';
            staggerCounter++;

            html += `
                <div class="animated-fadein ${staggerClass}" style="display:flex; gap:12px;">
                    <!-- rail -->
                    <div style="position:relative; width:16px; flex:0 0 16px;">
                        <span style="position:absolute; left:7px; top:0; bottom:0; width:2px; background:var(--border);"></span>
                        <span style="position:absolute; left:1px; top:20px; width:14px; height:14px; border-radius:50%; background:${meta.color}; border:3px solid var(--bg);"></span>
                    </div>
                    <!-- card -->
                    <div style="flex:1; min-width:0; margin-bottom:12px; background:var(--surface); border:1px solid var(--border); border-radius:15px; box-shadow:var(--shadow); padding:13px 14px;">
                        <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
                            <span style="display:inline-flex; align-items:center; gap:6px; height:23px; padding:0 9px; border-radius:8px; background:color-mix(in srgb, ${meta.color} ${mix}%, transparent); color:${meta.color}; font-size:11.5px; font-weight:600; letter-spacing:.01em;">
                                <span style="width:6px; height:6px; border-radius:50%; background:${meta.color};"></span>${escapeHtml(meta.label)}
                            </span>
                            <span style="display:inline-flex; align-items:center; height:23px; padding:0 9px; border-radius:8px; background:color-mix(in srgb, var(--accent) ${mix}%, transparent); color:var(--accent); font-size:11px; font-weight:600; white-space:nowrap; text-transform:capitalize;">
                                ${escapeHtml(ev.action_label)}
                            </span>
                        </div>

                        <div style="margin-top:10px; font-size:14.5px; font-weight:600; color:var(--text); line-height:1.35; letter-spacing:-.005em;">
                            ${escapeHtml(ev.summary)}
                        </div>

                        <div style="display:flex; align-items:center; gap:7px; margin-top:4px; font-size:12.5px; color:var(--text2); min-width:0;">
                            <span style="font-family:'IBM Plex Mono',monospace; color:var(--accent); font-weight:500;">${escapeHtml(detail.invoice.invoice_number)}</span>
                            <span style="color:var(--text3);">·</span>
                            <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                                ${escapeHtml(detail.invoice.customer_name || 'No customer linked')}
                            </span>
                        </div>

                        <!-- Diff / Changes Box -->
                        ${ev.changes && ev.changes.length > 0 ? `
                            <div style="margin-top:11px; border:1px solid var(--border); border-radius:11px; background:var(--surface2); overflow:hidden;">
                                <div style="padding:7px 11px; font-size:10.5px; font-weight:600; text-transform:uppercase; letter-spacing:.05em; color:var(--text3);">Changes</div>
                                ${ev.changes.map(chg => `
                                    <div style="display:flex; align-items:center; gap:8px; padding:8px 11px; border-top:1px solid var(--border);">
                                        <span style="width:66px; flex:0 0 66px; font-size:10.5px; text-transform:uppercase; letter-spacing:.03em; color:var(--text3); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(chg.field)}">
                                            ${escapeHtml(chg.field)}
                                        </span>
                                        ${chg.before && chg.before !== 'Empty' ? `
                                            <span style="font-family:'IBM Plex Mono',monospace; font-size:12px; color:var(--text3); text-decoration:line-through; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:80px;" title="${escapeHtml(chg.before)}">
                                                ${escapeHtml(chg.before)}
                                            </span>
                                            <span style="color:var(--text3); font-size:12px;">→</span>
                                        ` : ''}
                                        <span style="font-family:'IBM Plex Mono',monospace; font-size:12px; color:var(--text); font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:120px;" title="${escapeHtml(chg.after)}">
                                            ${escapeHtml(chg.after)}
                                        </span>
                                    </div>
                                `).join('')}
                            </div>
                        ` : ''}

                        <!-- Actor Info Footer -->
                        <div style="display:flex; align-items:center; gap:8px; margin-top:12px; padding-top:11px; border-top:1px solid var(--border);">
                            ${isSystem ? `
                                <span style="display:inline-flex; align-items:center; justify-content:center; width:25px; height:25px; flex:0 0 25px; border-radius:8px; background:color-mix(in srgb, var(--accent) 14%, transparent); color:var(--accent); font-size:8.5px; font-weight:700; font-family:'IBM Plex Mono',monospace;">SYS</span>
                            ` : `
                                <span style="display:inline-flex; align-items:center; justify-content:center; width:25px; height:25px; flex:0 0 25px; border-radius:50%; background:var(--surface2); border:1px solid var(--border); color:var(--text2); font-size:10px; font-weight:600;">${escapeHtml(initials)}</span>
                            `}
                            <span style="font-size:12.5px; color:var(--text); font-weight:500; white-space:nowrap;">
                                ${escapeHtml(ev.actor ? ev.actor.name : 'System')}
                            </span>
                            <span style="font-size:12px; color:var(--text3); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                                ${escapeHtml(ev.actor && ev.actor.role ? `· ${ev.actor.role}` : '')}
                            </span>
                            <span style="flex:1;"></span>
                            <span style="font-size:12px; color:var(--text3); font-variant-numeric:tabular-nums; white-space:nowrap;">
                                ${getEventTime(ev.edited_at)}
                            </span>
                        </div>
                    </div>
                </div>
            `;
        });
        html += '</div>';
    });

    html += '<div style="text-align:center; padding:22px 0 8px; font-size:11.5px; color:var(--text3); font-family:\'IBM Plex Mono\',monospace;">— end of log · invoice_audit_log —</div>';

    container.innerHTML = html;
}

// Dynamic Navigation Logic
async function navigateToFeed() {
    state.view = 'feed';
    state.invoiceId = null;
    state.invoiceDetail = null;
    history.pushState({ view: 'feed' }, '', '/');
    
    renderHeader();
    renderFeedTimeline();

    // Fetch invoices if they are empty
    await loadInvoices();
}

async function navigateToDetail(id) {
    state.view = 'detail';
    state.invoiceId = id;
    history.pushState({ view: 'detail', id }, '', `/?invoice=${encodeURIComponent(id)}`);
    
    renderHeader();
    renderDetailTimeline();

    // Fetch details
    await loadInvoiceDetail(id);
}

// HTTP API Data Fetching
async function loadInvoices() {
    state.loading = true;
    try {
        const r = await fetch('/api/invoices?pageSize=100');
        const b = await r.json();
        if (b.ok) {
            state.invoices = b.data.rows;
            renderFilterChips(); // refresh filter live counts
            renderFeedTimeline();
        }
    } catch (e) {
        console.error('Failed to load invoices:', e);
        const container = document.getElementById('view-content');
        if (container) {
            container.innerHTML = `
                <div style="text-align:center; padding:60px 24px; color:var(--text3);">
                    <div style="font-size:15px; font-weight:600; color:var(--text2);">Couldn't load invoices</div>
                    <div style="font-size:13px; margin-top:5px;">${escapeHtml(e.message)}</div>
                </div>
            `;
        }
    } finally {
        state.loading = false;
    }
}

async function loadInvoiceDetail(id) {
    state.loading = true;
    try {
        const r = await fetch(`/api/invoices/${encodeURIComponent(id)}/detail`);
        const b = await r.json();
        if (b.ok) {
            state.invoiceDetail = b.data;
            renderHeader(); // refresh with header meta
            renderDetailTimeline();
        } else {
            throw new Error(b.error || 'Failed to load details');
        }
    } catch (e) {
        console.error('Failed to load invoice detail:', e);
        const container = document.getElementById('view-content');
        if (container) {
            container.innerHTML = `
                <div style="text-align:center; padding:60px 24px; color:var(--text3);">
                    <div style="font-size:15px; font-weight:600; color:var(--text2);">Couldn't load invoice details</div>
                    <div style="font-size:13px; margin-top:5px;">${escapeHtml(e.message)}</div>
                </div>
            `;
        }
    } finally {
        state.loading = false;
    }
}

// Router dispatcher based on current URL state
function route() {
    const id = new URLSearchParams(location.search).get('invoice');
    if (id) {
        state.view = 'detail';
        state.invoiceId = id;
        renderHeader();
        renderDetailTimeline();
        loadInvoiceDetail(id);
    } else {
        state.view = 'feed';
        state.invoiceId = null;
        state.invoiceDetail = null;
        renderHeader();
        renderFeedTimeline();
        loadInvoices();
    }
}

// Initialise application on load
window.addEventListener('popstate', route);
document.addEventListener('DOMContentLoaded', () => {
    applyTheme();
    route();
});
