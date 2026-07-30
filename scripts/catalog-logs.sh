#!/usr/bin/env bash
# One-off: catalog invoice_audit_log types/volumes from prod_main (read-only).
set -euo pipefail

TOKEN="${PG_PROXY_TOKEN:?Set PG_PROXY_TOKEN (see .env / .env.example) before running this script}"
URL="https://pg-proxy-production.up.railway.app/api/sql"

runsql() {
  local label="$1"; local sql="$2"
  echo "===== $label ====="
  curl -s -X POST "$URL" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$(jq -cn --arg sql "$sql" '{db_name:"prod_main", sql:$sql, params:[]}')"
  echo ""
}

# 1. All entity_type x action_type combos: total, last 7d, last 24h, first/last seen
runsql "CATALOG" "SELECT entity_type, action_type, count(*) AS total, count(*) FILTER (WHERE edited_at > now() - interval '7 days') AS last_7d, count(*) FILTER (WHERE edited_at > now() - interval '24 hours') AS last_24h, min(edited_at) AS first_seen, max(edited_at) AS last_seen FROM invoice_audit_log GROUP BY 1,2 ORDER BY total DESC"

# 2. Volume by entity_type only
runsql "BY_ENTITY" "SELECT entity_type, count(*) AS total, count(DISTINCT invoice_id) AS invoices FROM invoice_audit_log GROUP BY 1 ORDER BY total DESC"

# 3. Daily volume last 14 days by entity_type (KL tz)
runsql "DAILY_14D" "SELECT (edited_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS day, entity_type, count(*) AS c FROM invoice_audit_log WHERE edited_at > now() - interval '14 days' GROUP BY 1,2 ORDER BY 1 DESC, 3 DESC"

runsql "NOW" "SELECT now() AS now, (now() AT TIME ZONE 'Asia/Kuala_Lumpur') AS kl_now"
