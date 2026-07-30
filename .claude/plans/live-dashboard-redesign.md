# Live Wall Dashboard — Complete Redesign Plan

## Problem Statement

Current `/live-wall-dashboard` only shows:
- Latest log entries (undifferentiated feed)
- No grouping by log type
- Not systematic or descriptive
- No activity breakdown per category

User feedback: "not systematic, not descriptive, and not showing activity per 'log type'"

## Data Analysis (from prod_main catalog, 2026-07-24)

Analyzed 80,451 audit log events across 11 entity types and 28 action combinations.

**Six semantic business categories:**

| Category | Entity Types | All-time Events | Today (partial) | Key Actions |
|---|---|---|---|---|
| **Customer Views** | viewer_activity | 32,925 | 152 | invoice_viewed (12k), session_ended (11k), button_clicked (8k), proposal_viewed (634) |
| **Invoices** | invoice | 20,418 | 16 | update (12k), insert (8k) |
| **Line Items** | invoice_item | 14,594 | 24 | insert (10k), delete (1.7k), update (1.6k), create (830) |
| **Documents** | invoice_upload, seda_upload, drawing | 5,324 | 16 | invoice_upload:added (2.7k), seda_upload:added (1.9k), drawing:upload (288) |
| **Payments** | payment, submitted_payment, verified_payment* | 4,735 | 11 | payment:verify (353, new flow), submitted_payment:insert (1065), verified_payment:insert (2987, legacy, stopped 2026-05-05) |
| **SEDA** | seda, seda_registration | 2,455 | 12 | seda:update (1.5k), seda_registration:updated (853), seda_registration:insert (30, new, started 2026-07-21) |

*Note: `verified_payment` is legacy (last write 2026-05-05). Live payment flow = `payment:verify` + `submitted_payment:insert`.

## Proposed Design

### Layout Structure

```
┌─────────────────────────────────────────────────────────────────────────┐
│  🔴 Live Wall Dashboard              14:26:39 KL    🟢 Connected  152/hr│
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Activity Pulse (Last 60 Minutes)                    Peak: 8  Trend: ↑ │
│  ▂▁▃▂▄▃▅▄▃▂▁▂▃▅▆▄▃▂▁▃▄▅▆▇▅▄▃▂▁▂▃▄▅▆▇▆▅▄▃▂▁▃▄▅▆▅▄▃▂▁▂▃▄▅▄▃▂▁▂       │
│  Last min: 3    Last hour: 152                                          │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐    │
│  │ 👁 Customer Views│  │ 📄 Invoices      │  │ 📝 Line Items    │    │
│  │                  │  │                  │  │                  │    │
│  │      152         │  │       16         │  │       24         │    │
│  │   ▲ +12%        │  │   ▼ -20%        │  │   ▲ +9%         │    │
│  │                  │  │                  │  │                  │    │
│  │  Viewed      112 │  │  Updated      14 │  │  Added       27 │    │
│  │  Ended        94 │  │  Created      11 │  │  Updated      8 │    │
│  │  Clicked      76 │  │                  │  │  Deleted      2 │    │
│  │                  │  │                  │  │                  │    │
│  │  ▁▂▃▅▇▆▅▄▃▂▁▂▃▄ │  │  ▁▁▂▂▃▃▄▅▆▃▂▁▁▂ │  │  ▁▂▃▄▅▆▅▄▃▂▁▂▃▄ │    │
│  │  2m ago          │  │  8m ago          │  │  1m ago          │    │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘    │
│                                                                         │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐    │
│  │ 💰 Payments      │  │ 📎 Documents     │  │ 🏛 SEDA          │    │
│  │                  │  │                  │  │                  │    │
│  │       11         │  │       16         │  │       12         │    │
│  │   ▲ +22%        │  │   ▼ -5%         │  │   ▲ +33%        │    │
│  │                  │  │                  │  │                  │    │
│  │  Verified      2 │  │  Uploaded     23 │  │  Reg Created  11 │    │
│  │  Submitted     7 │  │  SEDA Docs    19 │  │  Updated      14 │    │
│  │  Updated       3 │  │  Drawings      0 │  │  Status Chg    1 │    │
│  │                  │  │                  │  │                  │    │
│  │  ▁▂▃▄▅▆▅▄▃▂▁▂▃▄ │  │  ▁▁▂▃▄▅▆▅▄▃▂▁▁▂ │  │  ▁▂▃▅▆▇▅▄▃▂▁▂▃▄ │    │
│  │  5m ago          │  │  3m ago          │  │  12m ago         │    │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘    │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Live Event Feed                                        [All] [👁] [📄]│
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │ 👁  Invoice Viewed  ·  just now  ·  #8234  ·  Aminah Rahman    │  │
│  │ 📝  Line Item Added  ·  2m ago  ·  #8233  ·  Agent: Aiman      │  │
│  │ 💰  Payment Verified  ·  5m ago  ·  #8201  ·  RM 12,400        │  │
│  │ 📎  Document Uploaded  ·  8m ago  ·  #8199  ·  invoice.pdf     │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  Active Viewers (Last 15 Min)                                          │
│  🟢  Aminah Rahman  ·  #8234  ·  just now                              │
│  🟢  Tan Wei Ming  ·  #8201  ·  3m ago                                 │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Key Features

**1. Category Cards (6 semantic groups)**
Each card shows:
- **Icon + Name** — visual identity per category
- **Today's count** — live updating number
- **Delta badge** — today vs yesterday, color-coded (▲ green, ▼ red, – gray)
- **Action breakdown** — top 3-4 action types with their today counts
- **14-day sparkline** — trend visualization (inline SVG or CSS bars)
- **Last activity** — relative timestamp ("2m ago")

**2. Activity Pulse (improved)**
- 60-minute bar chart (existing)
- Add: **peak value** and **trend arrow** (recent 5min vs prior 5min)
- Add: **color gradient** by intensity (low = blue, high = bright blue/cyan)

**3. Live Feed (enhanced)**
- Keep chronological stream (newest first)
- Add: **Category filter chips** — click to filter by [All] [👁 Views] [📄 Invoices] [📝 Items] [💰 Payments] [📎 Docs] [🏛 SEDA]
- Add: **Descriptive summaries** — "Payment verified · RM 12,400" not "payment:verify"
- Add: **Invoice number + customer** when available

**4. Active Viewers (keep existing)**
- Show who's viewing in last 15 min
- Format: name, invoice number, time ago

## Backend Changes

### Extend `/api/live` response

Current structure:
```json
{
  "generatedAt": "...",
  "kpis": [...],           // flat general metrics
  "seda": [...],
  "receipts": [...],
  "newRegistrations": [...],
  "feed": [...],
  "activeViewers": [...],
  "pulse": {...}
}
```

**New structure:**
```json
{
  "generatedAt": "...",
  "categories": [
    {
      "id": "customer_views",
      "label": "Customer Views",
      "icon": "👁",
      "today": 152,
      "yesterday": 136,
      "delta": { "direction": "up", "pct": 12, "label": "+12%" },
      "actions": [
        { "label": "Viewed", "count": 112 },
        { "label": "Session Ended", "count": 94 },
        { "label": "Clicked", "count": 76 }
      ],
      "sparkline": [3,5,8,12,10,9,11,13,15,12,10,8,6,4],  // 14-day daily counts
      "lastActivity": "2026-07-24T14:24:39.079Z"
    },
    // ... 5 more categories
  ],
  "feed": [...],           // enhanced with category_id
  "activeViewers": [...],
  "pulse": {...}           // keep existing
}
```

### Implementation in `src/repo/dashboard.js`

**New function: `loadCategories(client)`**

```sql
-- Today + yesterday counts per category (entity_type groups)
SELECT 
  (edited_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS day,
  entity_type, action_type, count(*) AS c
FROM invoice_audit_log
WHERE edited_at > now() - interval '3 days'
GROUP BY 1, 2, 3

-- 14-day daily series per category
SELECT 
  (edited_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS day,
  entity_type, count(*) AS c
FROM invoice_audit_log
WHERE edited_at > now() - interval '14 days'
GROUP BY 1, 2
ORDER BY 1

-- Last activity timestamp per category
SELECT entity_type, max(edited_at) AS last_activity
FROM invoice_audit_log
WHERE edited_at > now() - interval '24 hours'
GROUP BY 1
```

Map entity types to categories:
- `customer_views`: `viewer_activity`
- `invoices`: `invoice`
- `line_items`: `invoice_item`
- `payments`: `payment`, `submitted_payment`, `verified_payment`
- `documents`: `invoice_upload`, `seda_upload`, `drawing`
- `seda`: `seda`, `seda_registration`

For each category:
1. Sum today/yesterday counts across its entity types
2. Compute delta (existing `pctDelta` helper)
3. Break down top actions (group by action_type, take top 3-4)
4. Build 14-day sparkline array
5. Find max(edited_at) for last activity

**Enhanced feed:**
Add `category_id` field to each feed item based on its `entity_type`.

### Frontend Changes (`public/live-wall-dashboard.html`)

**New components:**
1. **Category card renderer** — 6 cards in 2×3 grid, each with count/delta/actions/sparkline/timestamp
2. **Sparkline SVG generator** — inline `<svg>` with polyline from 14-day array
3. **Feed filter state** — click chip → filter feed by `category_id`
4. **Enhanced feed row** — show descriptive summary + invoice + customer

**Polling:**
Keep 3-second poll interval (unchanged).

**Interactivity:**
- Hover category card → highlight effect
- Click category icon → filter feed to that category
- Click [All] chip → reset filter

## Files to Modify

1. **`src/repo/dashboard.js`**
   - Add `loadCategories(client)` function
   - Extend `loadLive(client)` to include `categories` in response
   - Enhance feed items with `category_id` field

2. **`public/live-wall-dashboard.html`**
   - Complete rewrite of UI structure and styling
   - Add category card grid
   - Add feed filter chips
   - Enhance pulse display with peak/trend
   - Keep existing poll loop, replace render functions

## Migration Notes

- **No breaking changes** — `/api/live` adds fields, doesn't remove
- **Backward compatible** — old dashboard (if any client cached) won't break
- **Data source unchanged** — all queries read `invoice_audit_log`, no schema changes

## Validation

After deployment:
1. Open `/live-wall-dashboard` in browser
2. Verify 6 category cards render with real counts
3. Verify today-vs-yesterday deltas match reality
4. Verify action breakdowns sum correctly
5. Verify sparklines show 14-day trend
6. Verify feed filter chips work
7. Verify active viewers still appear
8. Poll for 30 seconds, confirm live updates

## Estimated Effort

- Backend (`dashboard.js`): 1-2 hours (new queries + category mapping logic)
- Frontend (HTML rewrite): 2-3 hours (card grid + sparkline rendering + filter state)
- Testing: 30 min
- Total: ~4 hours

## Open Questions

1. **Sparkline format:** Inline SVG (lightweight, fast) vs. CSS bar heights (simpler)? → Recommend CSS bars for simplicity.
2. **Feed filter persistence:** Should selected filter persist across page reloads? → No, start with [All] each time.
3. **Category order:** Fixed order (Views, Invoices, Items, Payments, Docs, SEDA) or dynamic by today's volume? → Fixed order for consistency.
