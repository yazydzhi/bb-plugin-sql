# Plan 0.6 — Schema-aware completion

Goal: schema + keyword completion in the lightweight editor, with personal
ranking and light context/alias awareness. No Monaco/LSP/LLM.

## Self-check vs ROADMAP

| ROADMAP item | In this plan | Deferred |
|--------------|--------------|----------|
| Schema cache + refresh | Stage 1 | — |
| Popup: keywords + prefix/fuzzy tables/columns | Stages 2–3 | — |
| Personal ranking (per connection) | Stage 4 | — |
| Context slots FROM/JOIN/SELECT/WHERE / qualification | Stage 2 + 5 | — |
| Alias resolution | Stage 5 | — |
| Hover type/nullable | Stage 3 (detail in popup) | rich hover tip later |
| JOIN-FK hints / LSP / LLM | — | 0.9+ |

## Stages and verification

### Stage 0 — Tails
- Mark 0.5 done in TODO; commit ROADMAP + TODO + this plan.
- **Check:** `git show` includes ROADMAP 0.6+; TODO 0.5 boxes `[x]`.

### Stage 1 — Schema catalog (A2)
- Driver: bulk catalog query (schemas/tables/columns, skip system schemas).
- RPC: `getSchemaCatalog({ connectionId })`.
- **Check:** against live Postgres (`local` or docker): catalog has `public`
  + known table/columns; empty/offline connection returns clear error.

### Stage 2 — Pure completion engine (A1/A3/B1 foundation)
- `lib/sql-completion/`: context detect, candidate gather, fuzzy filter, rank.
- Keywords list + catalog objects; no React.
- **Check:** `node --test` (strip-types) fixtures:
  - after `FROM ` → tables; after `SELECT ` → columns/tables;
  - `u.` with `FROM users u` → user columns; prefix `aut` → `authors`.

### Stage 3 — Editor popup (UI)
- Wire catalog load on active connection connect/change.
- Overlay list under caret; Tab/Enter accept; Esc/arrows navigate.
- **Check:** `bb plugin build` + install/reload; type in Query editor and
  accept a table name (manual or scripted if possible).

### Stage 4 — Personal ranking (A5/A6)
- SQLite `completion_stats` (connection_id, kind, name, uses, last_used_at).
- Record on accept (+ optional on successful Run identifiers later).
- Rank = match quality + `log(1+uses)` + recency boost.
- **Check:** accept `authors` twice → it ranks above unused peer with same prefix.

### Stage 5 — Context + alias polish (B1–B3)
- Harden slot detection; `schema.table` / `alias.`; multi-table FROM columns.
- **Check:** unit fixtures for JOIN, qualified names, ambiguous alias.

### Stage 6 — Ship hygiene
- Bump `package.json` → `0.6.0`, README/ROADMAP checkboxes, reload.
- **Check:** version string; ROADMAP 0.6 items `[x]` for landed scope.
