# Roadmap

Public plan for **bb-plugin-sql**. Day-to-day AJTBD notes and checklists live
locally (not in this repo). This file is the durable, shareable outlook.

**Product promise:** read-only Postgres from bb — human panel + agent tools.
Writes/DDL stay out of scope until explicitly revisited.

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

- [ ] **Layout split:** left **nav panel** = connections + schema tree;
  right **Actions panel** = editor + result tabs (shared *active connection*)
- [ ] Show table records (preview) + Describe columns
- [ ] Query history (persist + re-run)
- [ ] **`.sql` file opener:** run selection / whole file (still read-only);
  optional `-- @conn Name` header
- [ ] Free-form read-only SQL in the editor already ships in 0.1; keep it
      solid through the split (Run / ⌘Enter, result tabs, export)

### After 0.2 — Marketplace

- [ ] bb-community marketplace PR (`submit-a-plugin`) — **blocked on 0.2 DoD**

## 0.3 — Credential trust

- [ ] Prefer not storing plaintext passwords (`askForPassword` and/or OS keychain via bb.host)
- [ ] Connection URI (`postgresql://…`)
- [ ] Finer SSL (CA / client cert paths)

## 0.4 — Power-user convenience

- [ ] Bookmarks
- [ ] Query parameters (`:name` / prompts)
- [ ] Generate INSERT template (copy-paste aid; execution stays read-only)
- [ ] Views in the tree; light SQL format

## Explicitly not planned (for now)

| Idea | Why parked |
|------|------------|
| INSERT/UPDATE/DELETE/DDL from UI | Breaks the read-only promise |
| Extra DB drivers | Add a registry only when a second driver is real |
| Monaco / rich IntelliSense | High cost vs history + describe |
| AWS IAM, Excel export | Niche until someone asks |

## Feedback

Issues and PRs on the GitHub repo are welcome. Marketplace listing comes after
the classic query workflow (0.2) is done.
