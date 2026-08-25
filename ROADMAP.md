# Roadmap

Public plan for **bb-plugin-sql**. Day-to-day AJTBD notes and checklists live
locally (not in this repo). This file is the durable, shareable outlook.

**Product promise (through 0.4):** **read-only** Postgres from bb — human panel +
agent tools. `INSERT` / `UPDATE` / `DELETE` / DDL are rejected until **0.5**.

**Marketplace gate:** bb-community submission happens **only after** the classic
SQL query workflow below works end-to-end (release **0.2**), not after the
0.1 git tag alone.

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

Match the day-to-day SQLTools-style flow without leaving bb. This slice is
what we mean by “classic SQL queries” for product planning.

- [x] **Layout split:** left **nav panel** = connections + schema tree;
  right **Actions panel** / fixed **Query** tab = editor + result tabs
  (shared *active connection*)
- [x] Show table records (preview) + Describe columns
- [x] Query history (persist + re-run)
- [x] **`.sql` file opener:** run selection / whole file (still read-only);
  optional `-- @conn Name` header
- [x] Free-form read-only SQL in the editor (from 0.1) kept through the split

### After 0.2 — Marketplace

- [ ] bb-community marketplace PR (`submit-a-plugin`) — **blocked on 0.2 DoD**
  (tag a 0.2 release first when ready)

## 0.3 — Credential trust

- [ ] Prefer not storing plaintext passwords (`askForPassword` and/or OS keychain via bb.host)
- [ ] Connection URI (`postgresql://…`)
- [ ] Finer SSL (CA / client cert paths)

## 0.4 — Power-user convenience

Still **read-only** execution. Copy-paste write aids only.

- [ ] Bookmarks
- [ ] Query parameters (`:name` / prompts)
- [ ] Generate INSERT template (copy-paste aid; execution stays read-only)
- [ ] Views in the tree; light SQL format
- [ ] **Run from chat:** execute button on fenced `sql` (and selection) → pick
  connection → open/focus SQL Actions panel → new result tab (read-only)

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
| Monaco / rich IntelliSense | High cost vs history + describe |
| AWS IAM, Excel export | Niche until someone asks |

## Feedback

Issues and PRs on the GitHub repo are welcome. Marketplace listing comes after
the classic query workflow (0.2) is done. Writes ship in **0.5** — see above.
