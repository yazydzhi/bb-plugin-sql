# Roadmap

Public plan for **bb-plugin-sql**. Day-to-day AJTBD notes and checklists live
locally (not in this repo). This file is the durable, shareable outlook.

**Product promise (0.5+):** Postgres from bb — human panel + agent tools.
**UI connections default to read/write**; DDL and agent write stay opt-in
(per-connection flags, default off). **Shipped through `v0.5.4`** on
marketplace. Next: deepen Postgres UX (completion → editable results), then
hosted presets / SQLite — not a warehouse zoo.

## Shipped (0.1)

- Thread / New-thread **Actions → SQL** panel
- Connection CRUD (plugin SQLite), test-before-save, online/offline indicator
- Schema → table browse, insert `SELECT … LIMIT 100`
- Read-only execution (`BEGIN READ ONLY`, statement timeout, row cap)
- Result tabs + CSV/JSON copy & download
- Agent tools: `sql_list_connections`, `sql_query`
- Public GitHub + semver tag `v0.1.0`
  (`git:https://github.com/yazydzhi/bb-plugin-sql.git@^0.1.0`)

## 0.2 — Classic SQL query workflow

Match the day-to-day SQLTools-style flow without leaving bb.

- [x] **Layout split:** left **nav panel** = connections + schema tree;
  right **Actions panel** / fixed **Query** tab = editor + result tabs
  (shared *active connection*)
- [x] Show table records (preview) + Describe columns
- [x] Query history (persist + re-run)
- [x] **`.sql` file opener:** run selection / whole file (still read-only);
  optional `-- @conn Name` header
- [x] Free-form read-only SQL in the editor (from 0.1) kept through the split
- [x] Public release tags `v0.2.0`–`v0.2.3`
- [x] bb-community marketplace listing (merged)

## 0.3 — Editor UX, marketplace harden, credential trust

Still **read-only**. Combines query-pane polish that landed after 0.2 with the
credential/trust work that remains before 0.4.

### Done (on `main` / shipped as 0.2.3+)

- [x] **SQL syntax highlighting** in the Query editor and `.sql` file raw view
  (lightweight overlay highlighter — not Monaco)
- [x] **Taller editor** by default (~45% of the panel)
- [x] **Full-width resizable split** between editor and results (drag the
  horizontal separator)
- [x] Marketplace review hardenings (`v0.2.3`):
  - `pg-cloudflare` as a direct dependency (`npm install --omit=optional`)
  - `sql_query` uses extended protocol + `default_transaction_read_only=on`
  - honest tool instructions (one statement / read-only semantics)
  - valid branding icon (`Layers`)

### Remaining for 0.3 release

- [x] Prefer not storing plaintext passwords in SQLite
  (`secrets/passwords.json` 0600 + prompt on Connect when missing)
- [x] Connection URI (`postgresql://…` paste in the form)
- [x] Finer SSL (CA / client cert / key paths on the host)
- [x] Bound memory for large result sets (cursor `FETCH` + row cap; fallback slice)
- [x] Bound / frame agent `sql_query` output size (~24k chars, untrusted framing)
- [x] README: recommend a SELECT-only Postgres role for connections
- [x] Tag **`v0.3.0`** when this lands on `main`

## 0.4 — Power-user convenience

Still **read-only** execution. Copy-paste write aids only.

- [x] Bookmarks (save / load / delete from Query toolbar)
- [x] Query parameters (`:name` / prompts) — see **0.4.2**
- [x] Generate INSERT template (copy-paste aid; execution stays read-only)
- [x] Views in the tree (separate **Tables** / **Views** groups); light SQL format
- [x] Query toolbar layout: Open → connection → connect icons → History/Bookmarks block → Run;
  Format as editor corner link
- [x] **Run from chat:** message / selection **Run SQL** → pick connection →
  open/focus SQL Actions panel → auto-run → new result tab (read-only)

### 0.4.1

- [x] **Multi-statement editor:** split on `;` (strings / comments / dollar-quotes);
  highlight the statement under the caret (or the current selection) when the
  buffer has more than one query; **Run** / ⌘Enter executes selection, else the
  highlighted statement, else the whole buffer. A selection with several
  statements runs them **one by one** (new result tab each; stop on first error)

### 0.4.2

- [x] **Query parameters:** `:name` placeholders (not Postgres `::cast`); prompt
  before Run / auto-run; numbers / booleans / `null` unquoted; other values as
  SQL strings; last values remembered for the session

## 0.5 — Controlled write

First release that can mutate data from the UI (and optionally from the agent).

### Locked policy

| Setting | Default | Notes |
|---------|---------|--------|
| Connection **access mode** | **read/write** | Can switch to read-only per connection |
| **Agent write** | **off** | Per connection; enable explicitly |
| **Allow DDL** | **off** | Per connection; CREATE/ALTER/DROP/TRUNCATE/… |
| Admin / unknown | **blocked** | SET/VACUUM/COPY/… always |
| UI DML | Allowed in R/W | Confirm; DELETE / unsafe UPDATE = type table name |
| UI DDL | If Allow DDL | Confirm; DROP/TRUNCATE = type table name |
| Agent DML | Only if agent write on | Refuses UPDATE/DELETE without selective WHERE |
| Agent DDL | Agent write **and** Allow DDL | Same flags as above |
| Read path | `BEGIN READ ONLY` | Always for SELECT-like; agent reads too |

- [x] Per-connection mode: **Read-write** (default) / **Read-only**
- [x] Per-connection **Agent write** flag (default off)
- [x] Per-connection **Allow DDL** flag (default off)
- [x] Classifier + server gate (`assessSqlStatement` / `assessQuery` / `runQuery`)
- [x] UI confirm + type-table for DELETE / UPDATE without selective WHERE / DROP
- [x] Driver: RO pool option vs RW; matching transaction mode on execute
- [x] Agent `sql_query`: write/DDL only when flags enabled; docs/README updated
- [x] Tag **`v0.5.4`**; marketplace range `^0.5.4` (merged)

## 0.6 — Schema-aware completion (Postgres depth)

Highest ROI next for both humans and agents on the existing PG path.
Stay on the lightweight editor (no Monaco/LSP yet).

- [x] **Schema cache** from browse / catalog (schemas, tables, columns, types);
  refresh on Connect and on demand (`getSchemaCatalog`)
- [x] **Completion popup** at caret: keywords/snippets + prefix/fuzzy on
  tables/columns (overlay list; no editor swap); Ctrl/Cmd+Space
- [x] **Personal ranking** (local, per connection): boost objects accepted
  from the popup (`completion_stats`)
- [x] **Context slots (light parse):** after `FROM`/`JOIN` → tables;
  after `SELECT`/`WHERE` / `alias.` → columns; `schema.table` qualification
- [x] **Alias resolution** for the current statement (`FROM users u` → `u.`)
- [x] Detail line in popup: column type / nullable (hover-like)

**Out of 0.6:** JOIN-FK hints, full LSP, LLM ghost-text.

### 0.6.1 — Query session persistence

- [x] Keep editor SQL + result tabs across bb tab switches (panel remount);
  server-side query session + `editorSql` pref; draft handoff still works

### 0.6.2 — All databases + safer new-connection defaults

- [x] **Show all databases** (DBeaver-style): browse every DB on the server;
  secondary pools; active DB for Query / Show records
- [x] New connection defaults: Read-only **off**, Agent write **on**, Allow DDL **on**,
  Show all databases **on** (existing connections keep stored flags)

### 0.6.3 — Duplicate connection

- [x] ⋮ → **Duplicate**: copy host/flags/SSL/password; name `Name (copy)`

## 0.7 — Editable results + safer writes

Human write UX on top of 0.5 gates. Agents keep writing SQL via tools.

- [ ] **Edit-cell in result grid → staged UPDATE** (map columns back to base
  table when the SELECT is unambiguous)
- [ ] **Confirm before apply** (always); type table name for multi-row /
  unsafe patterns — same spirit as 0.5 UI confirms
- [ ] **Estimated affected rows** for UPDATE/DELETE (e.g. `EXPLAIN` /
  count preview) before confirm
- [ ] Apply / Discard staging; respect connection read-only and Allow DDL
  (grid edits are DML only)
- [ ] Optional: soft row-count caps / clearer warnings on huge result edits

**Out of 0.7:** manual multi-statement transaction UI, admin (SET/VACUUM).

## 0.8 — Hosted Postgres presets + second engine

Widen *reach* without abandoning PG-first depth.

### 0.8.a — Presets (still `pg` driver)

- [ ] Connection form presets: **Supabase** / **Neon** (paste Database URL,
  SSL on, short notes on direct vs pooler)
- [ ] Pooler quirks where needed (e.g. transaction mode / prepared statements)
- [ ] Docs: what SQL covers vs Auth/Storage/Realtime (out of scope)

### 0.8.b — Driver registry (first non-PG)

- [ ] Thin **driver interface** (connect, schema browse, runQuery, safety hooks)
- [ ] **SQLite** driver (local file / workspace DB — strong agent/repo fit)
- [ ] Reuse classifier/confirm policy where dialects allow; document gaps

**Out of 0.8:** MySQL/MSSQL, warehouse drivers, Supabase Auth/Storage APIs
(those belong in a different plugin/MCP if ever).

## 0.9 — Smarter assist (optional LLM) + completion polish

- [ ] JOIN hints from FKs / same-named columns (deterministic, no LLM)
- [ ] History/bookmark-backed phrase suggestions
- [ ] Explicit **Suggest SQL** action (selection or natural-language prompt)
  with schema RAG (DDL snapshot + top history) — not keystroke ghost-text
- [ ] Agent-side: richer schema summary for `sql_query` callers (tool/resource),
  still one statement per call

**Out of 0.9:** always-on LLM autocomplete, collaborative cross-device ranking.

## 1.0 — Hardening / parity (when 0.6–0.9 prove out)

Candidate themes (pick by feedback, not a commitment):

- MySQL/MariaDB driver (second mass dialect after SQLite)
- CodeMirror or Postgres LSP *only if* textarea completion hits a wall
- Manual commit mode / explicit transaction controls
- Admin statements behind a separate dangerous flag (still default off)
- Excel / richer export niches

## Explicitly not planned (for now)

| Idea | Why parked |
|------|------------|
| Unrestricted admin (SET/VACUUM) by default | Safety product promise |
| Firebase / Firestore as “SQL” | Not a relational wire protocol |
| PlanetScale / Snowflake / BigQuery first | Wrong order vs SQLite/MySQL; heavy auth |
| Monaco “because IDE” | Cost; revisit only after 0.6 completion limits |
| AWS IAM / Excel as core | Niche until someone asks |

## Feedback

Issues and PRs on the GitHub repo are welcome. The plugin is listed in
bb-community. Ship tag **`v0.6.3`** (completion aliases, query session,
show-all-databases, duplicate connection); marketplace range **`^0.6.3`**.
