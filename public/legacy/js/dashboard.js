'use strict';

/**
 * 公司动态 — Company Pulse dashboard.
 * Read-only, cross-invoice "what is happening right now" view. Polls
 * /api/dashboard every 15s and merges in new activity without disturbing
 * scroll position, so it can sit on a screen during a live walkthrough.
 */

const REFRESH_MS = 15000;

const state = {
    theme: localStorage.getItem('theme') || 'light',
    data: null,
    loading: true,
    error: null,
    lastFetchedAt: null,
    knownFeedIds: new Set()
};

const CATEGORIES = {
    created: { label: 'Created', color: '#2563EB' },
    updated: { label: 'Updated', color: '#D97706' },
    deleted: { label: 'Deleted', color: '#DC2626' },
    viewed: { label: 'Viewed', color: '#0EA5E9' },
    session: { label: 'Session', color: '#0891B2' },
    click: { label: 'Interaction', color: '#7C3AED' },
    payment: { label: 'Payment', color: '#059669' },
    other: { label: 'Activity', color: '#64748B' }
};

// ---------- helpers ----------

function escapeHtml(v) {
    return String(v ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtMoney(n) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    const num = Number(n);
    return 'RM ' + num.toLocaleString('en-MY', { minimumFractionDigits: num % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

function fmtCompactMoney(n) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    const num = Number(n);
    const abs = Math.abs(num);
    if (abs >= 1e6) return 'RM ' + (num / 1e6).toFixed(2) + 'M';
    if (abs >= 1e3) return 'RM ' + (num / 1e3).toFixed(1) + 'k';
    return fmtMoney(num);
}

function timeAgo(iso) {
    if (!iso) return '';
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}

function getEventTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
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

function getInitials(name) {
    if (!name) return '??';
    return name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
}

function deltaColor(direction) {
    if (direction === 'up') return '#059669';
    if (direction === 'down') return '#DC2626';
    return 'var(--text3)';
}

function deltaArrow(direction) {
    if (direction === 'up') return '▲';
    if (direction === 'down') return '▼';
    return '–';
}

function goToInvoice(id) {
    location.href = `/?invoice=${encodeURIComponent(id)}`;
}

function applyTheme() {
    document.body.className = state.theme === 'dark' ? 'theme-dark' : 'theme-light';
    localStorage.setItem('theme', state.theme);
}

function toggleTheme() {
    state.theme = state.theme === 'light' ? 'dark' : 'light';
    applyTheme();
    renderHeader();
}

// ---------- header ----------

function renderHeader() {
    const el = document.getElementById('view-header');
    if (!el) return;
    const isDark = state.theme === 'dark';

    el.innerHTML = `
        <div style="position:sticky; top:0; z-index:30; background:color-mix(in srgb, var(--surface) 84%, transparent); backdrop-filter:blur(16px); -webkit-backdrop-filter:blur(16px); border-bottom:1px solid var(--border); padding:14px 16px 12px;">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
                <div style="display:flex; align-items:center; gap:11px; min-width:0;">
                    <div style="width:36px; height:36px; flex:0 0 36px; border-radius:11px; background:var(--accent); display:flex; align-items:center; justify-content:center; box-shadow:0 2px 8px color-mix(in srgb, var(--accent) 40%, transparent);">
                        <span class="live-ring" style="width:9px; height:9px; border-radius:50%; background:#fff;"></span>
                    </div>
                    <div style="min-width:0;">
                        <div style="font-size:16.5px; font-weight:700; color:var(--text); letter-spacing:-.01em; line-height:1.1;">公司动态 <span style="font-weight:500; color:var(--text2); font-size:12.5px;">Company Pulse</span></div>
                        <div style="display:flex; align-items:center; gap:6px; margin-top:3px;">
                            <span style="width:6px; height:6px; border-radius:50%; background:#22C55E; animation:ihpulse 2.4s ease-in-out infinite;"></span>
                            <span id="pulse-updated" style="font-size:11.5px; color:var(--text2); font-weight:500;">Live · updated just now</span>
                        </div>
                    </div>
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                    <button id="btn-invoices" style="height:38px; border-radius:11px; border:1px solid var(--border); background:var(--surface); display:flex; align-items:center; gap:5px; padding:0 11px; cursor:pointer; color:var(--text2); font-size:12px; font-weight:600; font-family:inherit; outline:none; white-space:nowrap;">
                        Invoices
                    </button>
                    <button id="btn-theme-toggle" aria-label="Toggle theme" style="width:38px; height:38px; flex:0 0 38px; border-radius:11px; border:1px solid var(--border); background:var(--surface); display:flex; align-items:center; justify-content:center; cursor:pointer; color:var(--text2); outline:none;">
                        ${isDark
                            ? `<span style="width:14px; height:14px; border-radius:50%; background:var(--accent); box-shadow:0 0 0 2px color-mix(in srgb, var(--accent) 32%, transparent);"></span>`
                            : `<span style="position:relative; width:16px; height:16px; display:block;"><span style="position:absolute; inset:0; border-radius:50%; background:var(--text2);"></span><span style="position:absolute; top:-3px; right:-3px; width:13px; height:13px; border-radius:50%; background:var(--surface);"></span></span>`}
                    </button>
                </div>
            </div>
        </div>
    `;

    document.getElementById('btn-theme-toggle').onclick = toggleTheme;
    document.getElementById('btn-invoices').onclick = () => { location.href = '/'; };
}

// ---------- section: recent log strip (last 3, any type) ----------

function renderRecentLogs(data) {
    if (!data || !data.feed || data.feed.length === 0) return '';
    const recent = data.feed.slice(0, 3);

    const rows = recent.map((ev, i) => {
        const meta = CATEGORIES[ev.category] || CATEGORIES.other;
        const actorName = ev.actor ? ev.actor.name : 'System';
        return `
            <div style="display:flex; align-items:flex-start; gap:9px; padding:8px 2px; ${i > 0 ? 'border-top:1px solid var(--border);' : ''}">
                <span style="width:6px; height:6px; border-radius:50%; background:${meta.color}; flex:0 0 auto; margin-top:6px;"></span>
                <div style="flex:1; min-width:0;">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span style="flex:1; min-width:0; font-size:12.5px; color:var(--text); font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(ev.summary)}</span>
                        <span style="font-size:11px; color:var(--text3); flex:0 0 auto; white-space:nowrap;" title="${escapeHtml(getEventTime(ev.edited_at))}">${escapeHtml(timeAgo(ev.edited_at))}</span>
                    </div>
                    <div style="font-size:11px; color:var(--text3); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">by <span style="color:var(--text2); font-weight:500;">${escapeHtml(actorName)}</span>${ev.invoice_number ? ` · ${escapeHtml(ev.invoice_number)}` : ''}</div>
                </div>
            </div>
        `;
    }).join('');

    return `
        <div style="margin-top:12px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
                <span style="font-size:10.5px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--text3);">Latest</span>
                <span style="flex:1; height:1px; background:var(--border);"></span>
            </div>
            <div style="background:var(--surface); border:1px solid var(--border); border-radius:14px; box-shadow:var(--shadow); padding:0 12px;">${rows}</div>
        </div>
    `;
}

// ---------- section: KPI grid ----------

function renderKpis(data) {
    if (!data) return '';
    const isDark = state.theme === 'dark';
    const mix = isDark ? 22 : 13;

    const cards = data.kpis.map((k) => `
        <div style="background:var(--surface); border:1px solid var(--border); border-radius:15px; box-shadow:var(--shadow); padding:13px 14px;">
            <div style="font-size:10.5px; font-weight:600; text-transform:uppercase; letter-spacing:.05em; color:var(--text3); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(k.label)}</div>
            <div style="display:flex; align-items:baseline; gap:7px; margin-top:6px;">
                <span style="font-family:'IBM Plex Mono',monospace; font-size:23px; font-weight:700; color:var(--text); font-variant-numeric:tabular-nums;">${k.today}</span>
                <span style="font-size:11px; font-weight:700; color:${deltaColor(k.delta.direction)};">${deltaArrow(k.delta.direction)} ${escapeHtml(k.delta.label)}</span>
            </div>
            <div style="font-size:10.5px; color:var(--text3); margin-top:3px;">vs ${k.yesterday} yesterday</div>
        </div>
    `).join('');

    return `
        <div style="margin-top:14px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
                <span style="font-size:11.5px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--text3);">Today's Activity</span>
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:9px;">${cards}</div>
        </div>
    `;
}

// ---------- section: revenue strip ----------

function renderRevenue(data) {
    if (!data) return '';
    const r = data.revenue;
    return `
        <div style="margin-top:18px;">
            <div style="font-size:11.5px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--text3); margin-bottom:8px;">Revenue</div>
            <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:9px;">
                <div style="background:var(--surface); border:1px solid var(--border); border-radius:15px; box-shadow:var(--shadow); padding:11px 10px;">
                    <div style="font-size:9.5px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; color:var(--text3);">Collected Today</div>
                    <div title="${fmtMoney(r.collected_today)}" style="font-family:'IBM Plex Mono',monospace; font-size:14.5px; font-weight:700; color:#059669; margin-top:5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${fmtCompactMoney(r.collected_today)}</div>
                    <div style="font-size:10px; color:${deltaColor(r.collected_delta.direction)}; font-weight:600; margin-top:3px;">${deltaArrow(r.collected_delta.direction)} ${escapeHtml(r.collected_delta.label)} · ${r.collected_today_count} pmt</div>
                </div>
                <div style="background:var(--surface); border:1px solid var(--border); border-radius:15px; box-shadow:var(--shadow); padding:11px 10px;">
                    <div style="font-size:9.5px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; color:var(--text3);">Pending Verify</div>
                    <div title="${fmtMoney(r.pending_today)}" style="font-family:'IBM Plex Mono',monospace; font-size:14.5px; font-weight:700; color:#D97706; margin-top:5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${fmtCompactMoney(r.pending_today)}</div>
                    <div style="font-size:10px; color:var(--text3); font-weight:600; margin-top:3px;">${r.pending_today_count} submitted</div>
                </div>
                <div style="background:var(--surface); border:1px solid var(--border); border-radius:15px; box-shadow:var(--shadow); padding:11px 10px;">
                    <div style="font-size:9.5px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; color:var(--text3);">Outstanding</div>
                    <div title="${fmtMoney(r.outstanding_total)}" style="font-family:'IBM Plex Mono',monospace; font-size:14.5px; font-weight:700; color:var(--text); margin-top:5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${fmtCompactMoney(r.outstanding_total)}</div>
                    <div style="font-size:10px; color:var(--text3); font-weight:600; margin-top:3px;">${r.outstanding_invoices} invoices</div>
                </div>
            </div>
        </div>
    `;
}

// ---------- section: active viewers ----------

function renderActiveViewers(data) {
    if (!data) return '';
    const isDark = state.theme === 'dark';
    const mix = isDark ? 22 : 13;
    const viewers = data.activeViewers || [];

    const rows = viewers.length === 0
        ? `<div style="padding:16px; text-align:center; color:var(--text3); font-size:12.5px;">No one is viewing an invoice right now.</div>`
        : viewers.slice(0, 8).map((v) => `
            <div class="tap-card" onclick="goToInvoice(${v.invoice_id})" style="display:flex; align-items:center; gap:10px; padding:9px 12px; border-top:1px solid var(--border);">
                <span style="position:relative; width:30px; height:30px; flex:0 0 30px; border-radius:50%; background:var(--surface2); border:1px solid var(--border); display:flex; align-items:center; justify-content:center; color:var(--text2); font-size:10.5px; font-weight:600;">
                    ${escapeHtml(getInitials(v.customer_name))}
                    ${v.is_active_now ? `<span style="position:absolute; bottom:-1px; right:-1px; width:9px; height:9px; border-radius:50%; background:#22C55E; border:2px solid var(--surface); animation:ihpulse 2s ease-in-out infinite;"></span>` : ''}
                </span>
                <div style="min-width:0; flex:1;">
                    <div style="font-size:13px; font-weight:600; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(v.customer_name)}</div>
                    <div style="font-size:11px; color:var(--text3); font-family:'IBM Plex Mono',monospace;">${escapeHtml(v.invoice_number)}</div>
                </div>
                <div style="text-align:right; flex:0 0 auto;">
                    <div style="font-size:11px; font-weight:600; color:${v.is_active_now ? '#059669' : 'var(--text3)'};">${v.is_active_now ? 'Viewing now' : 'Just left'}</div>
                    <div style="font-size:10px; color:var(--text3); margin-top:1px;">${timeAgo(v.edited_at)}</div>
                </div>
            </div>
        `).join('');

    return `
        <div style="margin-top:18px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
                <span style="font-size:11.5px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--text3);">Live Visitor</span>
                <span style="flex:1; height:1px; background:var(--border);"></span>
                <span style="font-size:11.5px; color:var(--text3); font-variant-numeric:tabular-nums;">${viewers.length}</span>
            </div>
            <div style="background:var(--surface); border:1px solid var(--border); border-radius:15px; box-shadow:var(--shadow); overflow:hidden;">${rows}</div>
        </div>
    `;
}

// ---------- section: top movers ----------

function renderTopMovers(data) {
    if (!data) return '';
    const isDark = state.theme === 'dark';
    const mix = isDark ? 22 : 13;
    const movers = data.topMovers || [];

    if (movers.length === 0) {
        return `
            <div style="margin-top:18px;">
                <div style="font-size:11.5px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--text3); margin-bottom:8px;">Top Movers · 24h</div>
                <div style="background:var(--surface); border:1px solid var(--border); border-radius:15px; padding:16px; text-align:center; color:var(--text3); font-size:12.5px;">No activity in the last 24 hours.</div>
            </div>
        `;
    }

    const cards = movers.map((m, i) => {
        const meta = CATEGORIES[m.last_category] || CATEGORIES.other;
        return `
            <div class="tap-card" onclick="goToInvoice(${m.invoice_id})" style="flex:0 0 168px; background:var(--surface); border:1px solid var(--border); border-radius:15px; box-shadow:var(--shadow); padding:12px 13px;">
                <div style="display:flex; align-items:center; justify-content:space-between;">
                    <span style="font-family:'IBM Plex Mono',monospace; font-size:10.5px; color:var(--text3); font-weight:600;">#${i + 1}</span>
                    <span style="display:inline-flex; align-items:center; gap:4px; height:19px; padding:0 7px; border-radius:7px; background:color-mix(in srgb, ${meta.color} ${mix}%, transparent); color:${meta.color}; font-size:9.5px; font-weight:700;">
                        <span style="width:5px; height:5px; border-radius:50%; background:${meta.color};"></span>${escapeHtml(meta.label)}
                    </span>
                </div>
                <div style="font-size:12.5px; font-weight:600; color:var(--text); margin-top:8px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(m.customer_name || 'No customer')}</div>
                <div style="font-size:10.5px; color:var(--accent); font-family:'IBM Plex Mono',monospace; margin-top:2px;">${escapeHtml(m.invoice_number)}</div>
                <div style="display:flex; align-items:center; justify-content:space-between; margin-top:9px; padding-top:9px; border-top:1px solid var(--border);">
                    <span style="font-size:15px; font-weight:700; color:var(--text); font-family:'IBM Plex Mono',monospace;">${m.event_count}</span>
                    <span style="font-size:9.5px; color:var(--text3); font-weight:600;">events</span>
                </div>
            </div>
        `;
    }).join('');

    return `
        <div style="margin-top:18px;">
            <div style="font-size:11.5px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--text3); margin-bottom:8px;">Top Movers · 24h</div>
            <div style="display:flex; gap:9px; overflow-x:auto; margin:0 -14px; padding:1px 14px 4px;">${cards}</div>
        </div>
    `;
}

// ---------- section: SEDA activity ----------

const SEDA_STAGE_COLORS = { pending: '#D97706', submitted: '#2563EB', approved: '#059669', other: '#64748B' };

function renderSeda(data) {
    if (!data || !data.seda) return '';
    const seda = data.seda;
    const isDark = state.theme === 'dark';
    const mix = isDark ? 22 : 13;

    const kpiCards = seda.kpis.map((k) => `
        <div style="background:var(--surface); border:1px solid var(--border); border-radius:15px; box-shadow:var(--shadow); padding:11px 10px;">
            <div style="font-size:9.5px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; color:var(--text3); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(k.label)}</div>
            <div style="font-family:'IBM Plex Mono',monospace; font-size:18px; font-weight:700; color:var(--text); margin-top:5px;">${k.today}</div>
            <div style="font-size:10px; font-weight:600; color:${deltaColor(k.delta.direction)}; margin-top:3px;">${deltaArrow(k.delta.direction)} ${escapeHtml(k.delta.label)}</div>
        </div>
    `).join('');

    const p = seda.pipeline;
    const pipelineStages = [
        { id: 'pending', label: 'Pending' },
        { id: 'submitted', label: 'Submitted' },
        { id: 'approved', label: 'Approved' }
    ];
    const pipelineHtml = pipelineStages.map((stage, i) => `
        ${i > 0 ? `<span style="color:var(--text3); font-size:13px;">→</span>` : ''}
        <div style="flex:1; text-align:center;">
            <div style="font-family:'IBM Plex Mono',monospace; font-size:19px; font-weight:700; color:${SEDA_STAGE_COLORS[stage.id]};">${p[stage.id] || 0}</div>
            <div style="font-size:9.5px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; color:var(--text3); margin-top:2px;">${stage.label}</div>
        </div>
    `).join('');

    const transitions = seda.transitions || [];
    const transitionRows = transitions.length === 0
        ? `<div style="padding:16px; text-align:center; color:var(--text3); font-size:12.5px;">No SEDA status changes recorded yet.</div>`
        : transitions.slice(0, 6).map((t) => `
            <div class="tap-card" onclick="goToInvoice(${t.invoice_id})" style="display:flex; align-items:center; gap:10px; padding:9px 12px; border-top:1px solid var(--border);">
                <div style="min-width:0; flex:1;">
                    <div style="font-size:13px; font-weight:600; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(t.customer_name || 'No customer')}</div>
                    <div style="font-size:11px; color:var(--text3); font-family:'IBM Plex Mono',monospace;">${escapeHtml(t.invoice_number)}</div>
                </div>
                <div style="text-align:right; flex:0 0 auto;">
                    <div style="font-size:11px; font-weight:600; white-space:nowrap;">
                        <span style="color:${SEDA_STAGE_COLORS[String(t.before || '').toLowerCase()] || 'var(--text3)'};">${escapeHtml(t.before || '—')}</span>
                        <span style="color:var(--text3);"> → </span>
                        <span style="color:${SEDA_STAGE_COLORS[String(t.after || '').toLowerCase()] || 'var(--text3)'};">${escapeHtml(t.after || '—')}</span>
                    </div>
                    <div style="font-size:10px; color:var(--text3); margin-top:1px;">${timeAgo(t.edited_at)}</div>
                </div>
            </div>
        `).join('');

    return `
        <div style="margin-top:18px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
                <span style="font-size:11.5px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--text3);">SEDA Activity</span>
                <span style="flex:1; height:1px; background:var(--border);"></span>
                <span style="font-size:10px; color:var(--text3);">solar rebate pipeline</span>
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:9px;">${kpiCards}</div>
            <div style="display:flex; align-items:center; gap:6px; background:var(--surface); border:1px solid var(--border); border-radius:15px; box-shadow:var(--shadow); padding:13px 10px; margin-top:9px;">${pipelineHtml}</div>
            <div style="background:var(--surface); border:1px solid var(--border); border-radius:15px; box-shadow:var(--shadow); overflow:hidden; margin-top:9px;">${transitionRows}</div>
        </div>
    `;
}

// ---------- shared: single-KPI card row ----------

function kpiCardsHtml(kpis) {
    return (kpis || []).map((k) => `
        <div style="background:var(--surface); border:1px solid var(--border); border-radius:15px; box-shadow:var(--shadow); padding:13px 14px;">
            <div style="font-size:10.5px; font-weight:600; text-transform:uppercase; letter-spacing:.05em; color:var(--text3); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(k.label)}</div>
            <div style="display:flex; align-items:baseline; gap:7px; margin-top:6px;">
                <span style="font-family:'IBM Plex Mono',monospace; font-size:23px; font-weight:700; color:var(--text); font-variant-numeric:tabular-nums;">${k.today}</span>
                <span style="font-size:11px; font-weight:700; color:${deltaColor(k.delta.direction)};">${deltaArrow(k.delta.direction)} ${escapeHtml(k.delta.label)}</span>
            </div>
            <div style="font-size:10.5px; color:var(--text3); margin-top:3px;">vs ${k.yesterday} yesterday</div>
        </div>
    `).join('');
}

// ---------- section: receipts sent ----------

function renderReceipts(data) {
    if (!data || !data.receipts) return '';
    const rc = data.receipts;
    const list = rc.list || [];

    const rows = list.length === 0
        ? `<div style="padding:16px; text-align:center; color:var(--text3); font-size:12.5px;">No receipts sent yet.</div>`
        : list.map((r) => `
            <div class="tap-card" onclick="${r.invoice_id ? `goToInvoice(${r.invoice_id})` : ''}" style="display:flex; align-items:center; gap:10px; padding:9px 12px; border-top:1px solid var(--border);">
                <span style="width:6px; height:6px; border-radius:50%; background:#059669; flex:0 0 auto;"></span>
                <div style="min-width:0; flex:1;">
                    <div style="font-size:13px; font-weight:600; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(r.customer_name || 'No customer')}</div>
                    <div style="font-size:11px; color:var(--text3);"><span style="font-family:'IBM Plex Mono',monospace; color:var(--accent);">${escapeHtml(r.invoice_number || '—')}</span>${r.agent_phone ? ` · WhatsApp ${escapeHtml(r.agent_phone)}` : ''}</div>
                </div>
                <div style="font-size:10.5px; color:var(--text3); flex:0 0 auto; white-space:nowrap;">${timeAgo(r.edited_at)}</div>
            </div>
        `).join('');

    return `
        <div style="margin-top:18px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
                <span style="font-size:11.5px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--text3);">Receipts Sent</span>
                <span style="flex:1; height:1px; background:var(--border);"></span>
                <span style="font-size:10px; color:var(--text3);">payment confirmations</span>
            </div>
            <div style="display:grid; grid-template-columns:1fr; gap:9px;">${kpiCardsHtml(rc.kpis)}</div>
            <div style="background:var(--surface); border:1px solid var(--border); border-radius:15px; box-shadow:var(--shadow); overflow:hidden; margin-top:9px;">${rows}</div>
        </div>
    `;
}

// ---------- section: new SEDA registrations ----------

const SEDA_REG_STATUS_COLORS = { draft: '#64748B', pending: '#D97706', submitted: '#2563EB', approved: '#059669' };

function renderNewSedaRegistrations(data) {
    if (!data || !data.newSedaRegistrations) return '';
    const nr = data.newSedaRegistrations;
    const list = nr.list || [];

    const rows = list.length === 0
        ? `<div style="padding:16px; text-align:center; color:var(--text3); font-size:12.5px;">No new registrations yet.</div>`
        : list.map((r) => {
            const status = r.registration_status || r.admin_status || '';
            const color = SEDA_REG_STATUS_COLORS[String(status).toLowerCase()] || 'var(--text3)';
            return `
                <div class="tap-card" onclick="${r.invoice_id ? `goToInvoice(${r.invoice_id})` : ''}" style="display:flex; align-items:center; gap:10px; padding:9px 12px; border-top:1px solid var(--border);">
                    <div style="min-width:0; flex:1;">
                        <div style="font-size:13px; font-weight:600; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(r.customer_name || 'No customer')}</div>
                        <div style="font-size:11px; color:var(--text3); font-family:'IBM Plex Mono',monospace;">${escapeHtml(r.invoice_number || '—')}</div>
                    </div>
                    <div style="text-align:right; flex:0 0 auto;">
                        ${status ? `<div style="font-size:11px; font-weight:700; color:${color}; white-space:nowrap;">${escapeHtml(status)}</div>` : ''}
                        <div style="font-size:10px; color:var(--text3); margin-top:1px;">${timeAgo(r.edited_at)}</div>
                    </div>
                </div>
            `;
        }).join('');

    return `
        <div style="margin-top:18px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
                <span style="font-size:11.5px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--text3);">New SEDA Registrations</span>
                <span style="flex:1; height:1px; background:var(--border);"></span>
                <span style="font-size:10px; color:var(--text3);">newly created</span>
            </div>
            <div style="display:grid; grid-template-columns:1fr; gap:9px;">${kpiCardsHtml(nr.kpis)}</div>
            <div style="background:var(--surface); border:1px solid var(--border); border-radius:15px; box-shadow:var(--shadow); overflow:hidden; margin-top:9px;">${rows}</div>
        </div>
    `;
}

// ---------- section: referral web chat activity ----------

function renderReferralWebchat(data) {
    if (!data || !data.referralWebchat) return '';
    const wc = data.referralWebchat;
    const isDark = state.theme === 'dark';
    const mix = isDark ? 22 : 13;

    const kpiCards = (wc.kpis || []).map((k) => `
        <div style="background:var(--surface); border:1px solid var(--border); border-radius:15px; box-shadow:var(--shadow); padding:13px 14px;">
            <div style="font-size:10.5px; font-weight:600; text-transform:uppercase; letter-spacing:.05em; color:var(--text3); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(k.label)}</div>
            <div style="display:flex; align-items:baseline; gap:7px; margin-top:6px;">
                <span style="font-family:'IBM Plex Mono',monospace; font-size:23px; font-weight:700; color:var(--text); font-variant-numeric:tabular-nums;">${k.today}</span>
                <span style="font-size:11px; font-weight:700; color:${deltaColor(k.delta.direction)};">${deltaArrow(k.delta.direction)} ${escapeHtml(k.delta.label)}</span>
            </div>
            <div style="font-size:10.5px; color:var(--text3); margin-top:3px;">vs ${k.yesterday} yesterday</div>
        </div>
    `).join('');

    const threads = wc.threads || [];
    const threadRows = threads.length === 0
        ? `<div style="padding:16px; text-align:center; color:var(--text3); font-size:12.5px;">No webchat activity yet.</div>`
        : threads.map((t) => {
            const isInbound = t.last_direction === 'inbound';
            const color = isInbound ? '#0891B2' : '#7C3AED';
            return `
                <div style="display:flex; align-items:center; gap:10px; padding:9px 12px; border-top:1px solid var(--border);">
                    <span style="width:6px; height:6px; border-radius:50%; background:${color}; flex:0 0 auto;"></span>
                    <div style="min-width:0; flex:1;">
                        <div style="font-size:13px; font-weight:600; color:var(--text); font-family:'IBM Plex Mono',monospace;">${escapeHtml(t.phone_masked)}</div>
                        <div style="font-size:11px; color:var(--text3); margin-top:1px;">${t.message_count} message${t.message_count === 1 ? '' : 's'} · ${isInbound ? 'awaiting reply' : 'replied'}</div>
                    </div>
                    <div style="font-size:10.5px; color:var(--text3); flex:0 0 auto; white-space:nowrap;">${timeAgo(t.last_activity)}</div>
                </div>
            `;
        }).join('');

    return `
        <div style="margin-top:18px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
                <span style="font-size:11.5px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--text3);">Referral Web Chat</span>
                <span style="flex:1; height:1px; background:var(--border);"></span>
                <span style="font-size:10px; color:var(--text3);">AI Assistant</span>
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:9px;">${kpiCards}</div>
            <div style="background:var(--surface); border:1px solid var(--border); border-radius:15px; box-shadow:var(--shadow); overflow:hidden; margin-top:9px;">${threadRows}</div>
        </div>
    `;
}

// ---------- section: live feed ----------

function feedCardHtml(ev) {
    const meta = CATEGORIES[ev.category] || CATEGORIES.other;
    const isDark = state.theme === 'dark';
    const mix = isDark ? 22 : 13;
    const isSystem = ev.actor && ev.actor.role === 'system';

    return `
        <div class="tap-card animated-fadein" data-feed-id="${ev.id}" onclick="${ev.invoice_id ? `goToInvoice(${ev.invoice_id})` : ''}" style="background:var(--surface); border:1px solid var(--border); border-radius:15px; box-shadow:var(--shadow); padding:12px 13px; margin-bottom:9px;">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
                <span style="display:inline-flex; align-items:center; gap:6px; height:22px; padding:0 9px; border-radius:8px; background:color-mix(in srgb, ${meta.color} ${mix}%, transparent); color:${meta.color}; font-size:11px; font-weight:600;">
                    <span style="width:6px; height:6px; border-radius:50%; background:${meta.color};"></span>${escapeHtml(meta.label)}
                </span>
                <span style="font-size:11px; color:var(--text3); font-variant-numeric:tabular-nums; white-space:nowrap;">${getEventTime(ev.edited_at)}</span>
            </div>
            <div style="margin-top:8px; font-size:13.5px; font-weight:600; color:var(--text); line-height:1.35;">${escapeHtml(ev.summary)}</div>
            <div style="display:flex; align-items:center; gap:6px; margin-top:4px; font-size:12px; color:var(--text2); min-width:0;">
                <span style="font-family:'IBM Plex Mono',monospace; color:var(--accent); font-weight:500; white-space:nowrap;">${escapeHtml(ev.invoice_number || '—')}</span>
                <span style="color:var(--text3);">·</span>
                <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(ev.customer_name || 'No customer linked')}</span>
            </div>
            <div style="display:flex; align-items:center; gap:7px; margin-top:9px; padding-top:9px; border-top:1px solid var(--border);">
                <span style="display:inline-flex; align-items:center; justify-content:center; width:21px; height:21px; flex:0 0 21px; border-radius:${isSystem ? '7px' : '50%'}; background:${isSystem ? `color-mix(in srgb, var(--accent) 14%, transparent)` : 'var(--surface2)'}; border:${isSystem ? 'none' : '1px solid var(--border)'}; color:${isSystem ? 'var(--accent)' : 'var(--text2)'}; font-size:${isSystem ? '7.5px' : '9px'}; font-weight:700; font-family:'IBM Plex Mono',monospace;">${isSystem ? 'SYS' : escapeHtml(getInitials(ev.actor ? ev.actor.name : ''))}</span>
                <span style="font-size:11.5px; color:var(--text); font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(ev.actor ? ev.actor.name : 'System')}</span>
            </div>
        </div>
    `;
}

function renderFeedInitial(data) {
    const groups = [];
    (data.feed || []).forEach((ev) => {
        const label = getDayLabel(ev.edited_at);
        let g = groups.find((x) => x.label === label);
        if (!g) { g = { label, events: [] }; groups.push(g); }
        g.events.push(ev);
    });

    document.getElementById('feed-list').innerHTML = groups.map((g) => `
        <div class="feed-day-group" data-day-label="${escapeHtml(g.label)}" style="margin-top:4px;">
            <div style="display:flex; align-items:center; gap:10px; margin:12px 2px 8px;">
                <span style="font-size:11.5px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--text3);">${escapeHtml(g.label)}</span>
                <span style="flex:1; height:1px; background:var(--border);"></span>
            </div>
            <div class="feed-day-items">${g.events.map(feedCardHtml).join('')}</div>
        </div>
    `).join('') || `<div style="text-align:center; padding:40px 24px; color:var(--text3); font-size:13px;">No activity recorded yet.</div>`;

    state.knownFeedIds = new Set((data.feed || []).map((ev) => ev.id));
}

// ---------- toast notifications ----------

let toastContainer = null;

function ensureToastContainer() {
    if (toastContainer) return toastContainer;
    toastContainer = document.createElement('div');
    toastContainer.id = 'toast-container';
    toastContainer.style.cssText = 'position:fixed; bottom:16px; right:16px; z-index:9999; display:flex; flex-direction:column-reverse; gap:8px; align-items:flex-end; max-width:min(300px, calc(100vw - 32px));';
    document.body.appendChild(toastContainer);
    return toastContainer;
}

function showToast(freshItems) {
    const container = ensureToastContainer();
    const first = freshItems[0];
    const meta = CATEGORIES[first.category] || CATEGORIES.other;
    const extra = freshItems.length > 1 ? ` +${freshItems.length - 1} more` : '';

    const toast = document.createElement('div');
    toast.className = 'toast-pop';
    toast.style.cssText = `cursor:pointer; width:280px; background:var(--surface); border:1px solid var(--border); border-left:3px solid ${meta.color}; border-radius:12px; box-shadow:0 10px 28px rgba(0,0,0,.22), var(--shadow); padding:11px 13px;`;
    toast.innerHTML = `
        <div style="display:flex; align-items:center; gap:6px;">
            <span style="width:6px; height:6px; border-radius:50%; background:${meta.color}; flex:0 0 auto;"></span>
            <span style="font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; color:${meta.color}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(meta.label)}${escapeHtml(extra)}</span>
        </div>
        <div style="font-size:13px; font-weight:600; color:var(--text); margin-top:5px; line-height:1.3;">${escapeHtml(first.summary)}</div>
        <div style="font-size:11px; color:var(--text3); margin-top:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(first.invoice_number || '')}${first.customer_name ? ' · ' + escapeHtml(first.customer_name) : ''}</div>
    `;
    toast.onclick = () => { if (first.invoice_id) goToInvoice(first.invoice_id); };

    container.appendChild(toast);
    while (container.children.length > 3) container.removeChild(container.firstChild);

    setTimeout(() => {
        toast.classList.add('toast-out');
        toast.addEventListener('animationend', () => toast.remove(), { once: true });
    }, 6000);
}

function mergeNewFeedItems(newFeed) {
    const freshItems = newFeed.filter((ev) => !state.knownFeedIds.has(ev.id));
    if (freshItems.length === 0) return;

    freshItems.forEach((ev) => state.knownFeedIds.add(ev.id));
    showToast(freshItems);

    // Newest-first order from the API — insert in that order at the top of "Today".
    let todayGroup = document.querySelector('.feed-day-group[data-day-label="Today"]');
    const feedList = document.getElementById('feed-list');
    if (!todayGroup && feedList) {
        feedList.insertAdjacentHTML('afterbegin', `
            <div class="feed-day-group" data-day-label="Today" style="margin-top:4px;">
                <div style="display:flex; align-items:center; gap:10px; margin:12px 2px 8px;">
                    <span style="font-size:11.5px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--text3);">Today</span>
                    <span style="flex:1; height:1px; background:var(--border);"></span>
                </div>
                <div class="feed-day-items"></div>
            </div>
        `);
        todayGroup = document.querySelector('.feed-day-group[data-day-label="Today"]');
    }
    const itemsEl = todayGroup.querySelector('.feed-day-items');
    // Reverse so the oldest of the fresh batch is inserted first, keeping overall newest-first order.
    [...freshItems].reverse().forEach((ev) => {
        itemsEl.insertAdjacentHTML('afterbegin', feedCardHtml(ev));
    });
}

// ---------- orchestration ----------

function renderStaticSections(data) {
    document.getElementById('sec-recent').innerHTML = renderRecentLogs(data);
    document.getElementById('sec-kpis').innerHTML = renderKpis(data);
    document.getElementById('sec-revenue').innerHTML = renderRevenue(data);
    document.getElementById('sec-viewers').innerHTML = renderActiveViewers(data);
    document.getElementById('sec-movers').innerHTML = renderTopMovers(data);
    document.getElementById('sec-seda').innerHTML = renderSeda(data);
    document.getElementById('sec-newseda').innerHTML = renderNewSedaRegistrations(data);
    document.getElementById('sec-receipts').innerHTML = renderReceipts(data);
    document.getElementById('sec-webchat').innerHTML = renderReferralWebchat(data);
}

function renderShell() {
    const container = document.getElementById('view-content');
    container.innerHTML = `
        <div id="sec-recent"></div>
        <div id="sec-kpis"></div>
        <div id="sec-revenue"></div>
        <div id="sec-viewers"></div>
        <div id="sec-movers"></div>
        <div id="sec-seda"></div>
        <div id="sec-newseda"></div>
        <div id="sec-receipts"></div>
        <div id="sec-webchat"></div>
        <div style="display:flex; align-items:center; gap:8px; margin:18px 0 8px;">
            <span style="font-size:11.5px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--text3);">Live Activity</span>
            <span style="flex:1; height:1px; background:var(--border);"></span>
        </div>
        <div id="feed-list"></div>
        <div style="text-align:center; padding:16px 0 8px; font-size:11px; color:var(--text3); font-family:'IBM Plex Mono',monospace;">— live · invoice_audit_log · auto-refresh 15s —</div>
    `;
}

function updatePulseLabel() {
    const el = document.getElementById('pulse-updated');
    if (!el || !state.lastFetchedAt) return;
    el.textContent = `Live · updated ${timeAgo(state.lastFetchedAt.toISOString())}`;
}

async function fetchDashboard(isInitial) {
    try {
        const r = await fetch('/api/dashboard');
        const body = await r.json();
        if (!body.ok) throw new Error(body.error || 'Failed to load dashboard');

        state.data = body.data;
        state.lastFetchedAt = new Date();
        state.error = null;

        if (isInitial) {
            renderShell();
            renderStaticSections(body.data);
            renderFeedInitial(body.data);
        } else {
            renderStaticSections(body.data);
            mergeNewFeedItems(body.data.feed || []);
        }
        updatePulseLabel();
    } catch (e) {
        console.error('[dashboard] fetch failed:', e);
        state.error = e.message;
        if (isInitial) {
            document.getElementById('view-content').innerHTML = `
                <div style="text-align:center; padding:60px 24px; color:var(--text3);">
                    <div style="font-size:15px; font-weight:600; color:var(--text2);">Couldn't load the dashboard</div>
                    <div style="font-size:13px; margin-top:5px;">${escapeHtml(e.message)}</div>
                </div>
            `;
        }
    } finally {
        state.loading = false;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    applyTheme();
    renderHeader();
    fetchDashboard(true);
    setInterval(() => fetchDashboard(false), REFRESH_MS);
    setInterval(updatePulseLabel, 1000);
});
