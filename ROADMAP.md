# Roadmap

Public plan for **bb-plugin-sql**. Day-to-day AJTBD notes and checklists live
locally (not in this repo). This file is the durable, shareable outlook.

**Product promise (through 0.4):** **read-only** Postgres from bb — human panel +
agent tools. `INSERT` / `UPDATE` / `DELETE` / DDL are rejected until **0.5**.

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

First release that can mutate data. Default stays safe; write is opt-in.

- [ ] Per-connection mode: **Read-only** (default) / **Read-write**
- [ ] UI: run `INSERT` / `UPDATE` (then `DELETE`) when connection is read-write,
  with an explicit confirm before execute
- [ ] Agent: write path **off by default** (separate tool or flag + confirm policy)
- [ ] Keep `BEGIN READ ONLY` for read-only connections and for `sql_query` unless
  write is explicitly enabled
- [ ] Clear UI/README labeling so publish pages do not imply full DML before 0.5

**Out of 0.5 (for later):** unrestricted DDL from UI, edit-cell grid → UPDATE,
agent auto-write without user intent.

## Explicitly not planned (for now)

| Idea | Why parked |
|------|------------|
| Unrestricted DDL / edit-cell grid | After 0.5 proves controlled DML |
| Extra DB drivers | Add a registry only when a second driver is real |
| Monaco / rich IntelliSense | Light syntax highlight is in 0.3; full IDE cost not justified yet |
| AWS IAM, Excel export | Niche until someone asks |

## Feedback

Issues and PRs on the GitHub repo are welcome. The plugin is listed in
bb-community. Writes ship in **0.5** — see above.
