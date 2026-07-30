# How to use `ai_activity_log` (shared AI agent activity log)

**Database:** `prod_main` (proxy `db_name=prod_main`, underlying Postgres db `railway`)
**Table:** `public.ai_activity_log` · **Created:** 2026-07-28

---

## 0. Read this first — who this is for, and the mistake everyone makes

**This is NOT asking whether your app's product code calls an LLM API.**
It has nothing to do with your app's runtime, its dependencies, or whether it
has an `anthropic`/`openai` package in `package.json`.

**It is asking about YOU** — whatever AI agent is *right now* reading this
file and doing coding work in a repo (Claude, Claude Code, a sub-agent, a
scheduled workflow, a cron-triggered agent). If you are an AI editing files,
calling tools, running commands, or answering a coding request in any project
connected to `prod_main`, **you are the "AI activity" this table is for.**
Log your own actions here. It doesn't matter if the app you're working on is
a read-only dashboard, a static site, or has zero AI features of its own —
you, the agent doing the work, still write a row every time you do something
meaningful (edit a file, run a tool, complete a task).

**Wrong conclusion (seen in practice):**
> "This app only queries DB tables and renders them. No LLM/AI calls
> anywhere — no Anthropic/OpenAI dependency, no outbound AI fetch calls. So
> there's nothing to log."

This is backwards. The absence of an AI SDK in the app's own code is
irrelevant. The question was never "does this app call an LLM" — it's "is an
AI agent (you) doing work here right now." If you're capable of reading this
sentence and reporting back on a codebase, the answer is yes, and you should
be inserting rows into `ai_activity_log` for the actions you take.

**Audience:** every app/repo where an AI agent (Claude, sub-agents,
workflows, cron-triggered agents) does work — not just apps that have AI
features built into their product.

This table records **detailed AI agent activity** — model calls, tool calls, token
usage, and cost. It is the AI-specific sibling of `activity_log` (see
`SOP-SCHEMA-Activity-log.md` in EE-Admin-v5), not a replacement for it.

---

## 1. When to use this vs `activity_log`

| Table | Use it for | Payload size | Retention |
|---|---|---|---|
| **`ai_activity_log`** | **Detailed AI trail: which model, which tool, tokens in/out, cost, prompt/response summaries** | Larger rows OK (has `input_summary`/`output_summary`/`metadata`) | TBD — not yet enforced |
| `activity_log` | One human-readable line per action, for the cross-app staff feed | ~250–350 bytes, no full payloads | 30 days, enforced |

**They're complementary.** When an AI agent does something that touches a shared
business entity (e.g. updates an invoice), write:
- the detailed record to `ai_activity_log` (tokens, cost, tool calls, model), and
- a one-line human-readable summary to `activity_log` (e.g. `"AI agent updated
  invoice INV-0312"`, `actor_kind='api'` or `'ai'`) so it shows up in the normal
  staff feed like any other actor.

Link the two with `ai_activity_log.activity_log_id` (soft reference — no FK,
same reasoning as `activity_log`: FKs lock rows and block deletes).

If the AI action doesn't touch a shared entity (e.g. internal reasoning, a
read-only lookup, a sub-agent planning step), just write to `ai_activity_log`
and skip `activity_log` — the staff feed shouldn't fill up with things no
human needs to see.

---

## 2. Schema

```sql
CREATE TABLE ai_activity_log (
  id                    bigserial   PRIMARY KEY,

  -- Which app/system triggered this AI action
  app                   text        NOT NULL,          -- REQUIRED. explicit slug, same rule as activity_log
  app_env               text,                           -- 'prod' | 'staging' | 'dev'

  -- Which AI ran it
  agent                 text        NOT NULL,          -- REQUIRED. e.g. 'claude-sonnet-5', 'legion-worker'
  agent_kind            text        NOT NULL DEFAULT 'main_loop',  -- 'main_loop' | 'subagent' | 'workflow' | 'cron'
  model                 text        NOT NULL,          -- REQUIRED. exact model id, e.g. 'claude-sonnet-5'
  api_url               text,                           -- endpoint actually called, e.g. 'https://api.anthropic.com/v1/messages'

  -- Correlation across a multi-step run
  session_id            text,                           -- one AI conversation/session
  task_id               text,                           -- one unit of work within it
  parent_task_id        text,                           -- links subagent -> parent (soft ref, no FK)

  -- Who asked for it (the human, if any)
  triggered_by_user_id  integer,                        -- "user".id — INTEGER only, same trap as activity_log §5
  triggered_by_ref      text,                            -- app's own id/email if not resolved to an integer
  triggered_by_name     text,                            -- snapshot, same denormalization reason as activity_log

  -- What happened
  action                text        NOT NULL,          -- REQUIRED. free text, no enum — e.g. 'tool_call', 'edit_file'
  tool_name             text,                            -- specific tool/function invoked, if any
  entity_type           text,
  entity_id             text,
  entity_label          text,
  description            text,                           -- pre-rendered human line, same convention as activity_log §6

  -- AI-specific detail
  input_summary         text,                            -- truncated prompt/instruction — NEVER secrets
  output_summary        text,                            -- truncated result/response
  input_tokens           integer,                        -- tokens in
  output_tokens          integer,                        -- tokens out
  cost_usd               numeric(10,4),                  -- token cost in USD
  duration_ms             integer,

  status                 text        NOT NULL DEFAULT 'success',  -- 'success' | 'failed' | 'partial'
  error_message           text,

  -- Cross-link to the shared human feed, when one was also written
  activity_log_id         bigint,                        -- soft ref to activity_log.id — no FK

  metadata                jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- escape hatch, same as activity_log §7

  occurred_at              timestamptz NOT NULL DEFAULT now(),
  retain_until             timestamptz                    -- NULL = no auto-purge yet (see §6 Retention)
);
```

Indexes: `(occurred_at DESC)`, `(app, occurred_at DESC)`, `(session_id, occurred_at)`,
`(agent, occurred_at DESC)`, `(task_id)`.

**Only four columns are required: `app`, `agent`, `model`, and `action`.**
Everything else is optional. A thin row is better than no row.

---

## 3. Minimum viable write

```sql
INSERT INTO ai_activity_log (app, agent, model, action, description)
VALUES ('invoice-history', 'claude-sonnet-5', 'claude-sonnet-5', 'tool_call',
        'Claude read invoice_audit_log to build the activity page');
```

Fuller, the way you should actually do it:

```sql
INSERT INTO ai_activity_log
  (app, app_env, agent, agent_kind, model, api_url, session_id, task_id,
   triggered_by_name, action, tool_name, entity_type, entity_id, description,
   input_tokens, output_tokens, cost_usd, duration_ms)
VALUES
  ('invoice-history', 'prod', 'claude-sonnet-5', 'main_loop', 'claude-sonnet-5',
   'https://api.anthropic.com/v1/messages', 'sess_8f21', 'task_003',
   'Nurul', 'edit_file', 'Edit', 'file', 'src/repo/activityLog.js',
   'Claude added the activity log repo/query layer',
   1450, 620, 0.0187, 3200);
```

Node / `pg`:

```js
await pool.query(
  `INSERT INTO ai_activity_log
     (app, agent, model, api_url, action, tool_name, description,
      input_tokens, output_tokens, cost_usd)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
  [APP_SLUG, 'claude-sonnet-5', model, apiUrl, 'tool_call', toolName,
   description, inputTokens, outputTokens, costUsd]
);
```

Python / `psycopg`:

```python
cur.execute(
    """INSERT INTO ai_activity_log
         (app, agent, model, action, description, input_tokens, output_tokens, cost_usd)
       VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
    (APP_SLUG, "claude-sonnet-5", model, "tool_call", description,
     input_tokens, output_tokens, cost_usd),
)
```

---

## 4. Rules (carried over from `activity_log`)

**Rule 1 — Logging must never break the AI's actual task.**
Wrap the insert in try/catch, swallow the error, log it to console. A missing
log row is a minor gap; a failed agent turn because logging threw is not.

**Rule 2 — Write it *after* the real work commits, outside that transaction.**

**Rule 3 — `app` is an explicit slug from your config. Never guess it.**

**Rule 4 — `action` and `tool_name` are free text. There is no enum, and
there must never be one.** Readers must handle unknown values with a catch-all.

**Rule 5 — Never put secrets, passwords, tokens, API keys, or full raw
request/response payloads in `input_summary`/`output_summary`/`metadata`.**
Summarize/truncate. If you need the full transcript, store a reference (e.g.
a session id you can look up elsewhere), not the raw text here.

---

## 5. The actor-identity trap (same as `activity_log`)

`triggered_by_user_id` is **integer** and must receive `"user".id`, never a
`bubble_id`. If your app identifies the human by bubble_id, email, or its own
id, put that in `triggered_by_ref` (text) and leave `triggered_by_user_id`
NULL — or resolve it first:

```sql
SELECT id FROM "user" WHERE bubble_id = $1;
```

Non-human triggers (cron, another AI, a webhook) are fine — leave
`triggered_by_*` NULL and let `agent_kind` describe what ran it.

---

## 6. Reading it

Global feed, most recent first:

```sql
SELECT occurred_at, app, agent, model, action, description, input_tokens, output_tokens, cost_usd
FROM ai_activity_log
ORDER BY occurred_at DESC
LIMIT 50;
```

One session, in order:

```sql
SELECT * FROM ai_activity_log
WHERE session_id = 'sess_8f21'
ORDER BY occurred_at ASC;
```

Cost rollup by app, last 24h:

```sql
SELECT app, agent, count(*) AS calls,
       sum(input_tokens) AS tokens_in, sum(output_tokens) AS tokens_out,
       sum(cost_usd) AS total_cost_usd
FROM ai_activity_log
WHERE occurred_at >= now() - interval '24 hours'
GROUP BY app, agent
ORDER BY total_cost_usd DESC;
```

A subagent tree (children of one task):

```sql
SELECT * FROM ai_activity_log
WHERE parent_task_id = 'task_003'
ORDER BY occurred_at ASC;
```

**Paginate with a cursor on `(occurred_at, id)`, not `OFFSET`.** Render
unknown `action`/`tool_name` values with a fallback rather than filtering to
values you recognize (Rule 4).

---

## 7. Retention

**Not yet enforced.** Unlike `activity_log` (hard 30-day purge), no automatic
deletion job exists for `ai_activity_log` yet — rows accumulate indefinitely
until a policy is decided. This table's rows are typically larger than
`activity_log`'s (prompt/response summaries), so pick a retention window
before volume becomes a problem. `retain_until` is already in the schema for
a future purge job.

---

## 8. Registered app slugs

Keep this list current. Add a row when your app starts writing.

| `app` | System | Owner |
|---|---|---|
| _(add yours)_ | | |

---

## 9. Anti-patterns

- ❌ A `CHECK` constraint or TS enum on `action`/`tool_name` → Rule 4.
- ❌ A foreign key to `"user"` or `activity_log` → same reasoning as `activity_log` §11.
- ❌ Storing full prompts/responses or secrets in `input_summary`/`output_summary`/`metadata` → Rule 5.
- ❌ Logging every internal reasoning token — log meaningful steps (tool calls,
  file edits, API calls), not a row per token or per thought.
- ❌ Skipping the `activity_log` write when the AI action affects a shared
  entity a human would want to see in the normal feed (§1).

---

## 10. Changelog

| Date | Change |
|---|---|
| 2026-07-28 | Table created in `prod_main` with 5 indexes. Verified with an insert/read/delete round-trip (id=1). |
