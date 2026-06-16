# ee-invoice-history

A small, standalone, **read-only** web app that displays the per-invoice
audit history and viewer-activity stream from the `invoice_audit_log` table
owned by the [Solar Calculator v2](../Solar%20Calculator%20v2) project.

- **No auth** by design — anyone with the URL can read.
- **No mutations** — read-only DB user is recommended.
- **No Solar code** — the app lifts only the history normalization logic and
  the timeline rendering shape from the parent project.

## API

| Method | Path                                            | Returns                                                                                              |
| ------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| GET    | `/api/invoices/:bubbleId/history`               | `{ invoiceId, rows: HistoryRow[] }` — or 404 if the invoice bubble_id is unknown.                     |
| GET    | `/api/invoices/:bubbleId/viewer-activity`       | `HistoryRow[]` filtered to `entity_type = 'viewer_activity'`.                                        |
| GET    | `/healthz`                                      | `{ ok: true, db: 'up' \| 'down' }` — `SELECT 1` against the pool.                                     |
| GET    | `/`                                             | The single-page UI.                                                                                  |

`HistoryRow` shape:

```js
{
  action_type: 'ADDED' | 'UPDATED' | 'DELETED',
  entity_type: string,
  changes: [{ field, before, after }],
  edited_by_name, edited_by_phone, edited_by_role,
  edited_at, is_unknown_source,
  details: { description: string }
}
```

## Run locally

```bash
cd E:\invoice-history
npm install
cp .env.example .env
# edit .env and set DATABASE_URL to a read-only Postgres user that can see invoice_audit_log
npm start
# open http://localhost:3000
```

`npm run dev` runs with `nodemon` for hot-reload.

## Database dependency

This app reads the `invoice_audit_log` table created by the parent project's
migration:

```
Solar Calculator v2/database/migrations/2026-05-06-create-invoice-audit-log.sql
```

If the table does not exist, the history endpoint returns an empty array
(graceful). Run the parent project's migration first if you want real data.

A **read-only** Postgres role is strongly recommended:

```sql
CREATE ROLE invoice_history_readonly LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE your_db TO invoice_history_readonly;
GRANT USAGE ON SCHEMA public TO invoice_history_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO invoice_history_readonly;
```

## Deployment & security

- **This app has no authentication.** Do not expose it to the public internet
  without a layer in front: Cloudflare Access, basic-auth via reverse proxy,
  VPN, or similar.
- Use a read-only DB user.
- The frontend loads Tailwind via the public CDN. If you need a CSP that
  forbids third-party scripts, vendor the CSS or switch to a build step.

## File layout

```
.
├── server.js                  Express bootstrap
├── package.json
├── src/
│   ├── db.js                  pg.Pool singleton
│   ├── repo/
│   │   ├── history.js         loadInvoiceHistory (lifted from Solar app)
│   │   └── viewerActivity.js  loadViewerActivity
│   └── routes/
│       └── api.js             JSON endpoints
└── public/
    ├── index.html             Single-page UI (lifted chrome from my_invoice.html)
    └── js/app.js              Fetch + render (lifted timeline from my_invoice.html)
```

The frontend uses **Tailwind via CDN**, Inter font, and FontAwesome — the same
stack as the parent app's `public/templates/my_invoice.html`. The timeline
rendering code is lifted **verbatim** from that file (the `openHistoryModal`
function, lines 523-607), with only the API URL swapped.

## Origin

Lifted from `E:\Solar Calculator v2\src\modules\Invoicing\services\invoiceHistoryRepo.js`
and `E:\Solar Calculator v2\public\templates\my_invoice.html`. The app is
intentionally minimal so it can be re-pointed at a snapshot DB or a read
replica without dragging in the rest of the Solar codebase.
