# bb-plugin-sql

SQLTools-style Postgres panel for [bb](https://get-bb.dev): manage connections,
browse schemas/tables, and run SQL from a panel or agent tools.

> **Read-only until 0.5.** Versions **before `0.5`** only support **read**
> queries (`SELECT` and other statements that succeed under `BEGIN READ ONLY`).
> `INSERT` / `UPDATE` / `DELETE` / DDL are rejected on purpose.
> Controlled write is planned for **0.5** — see [ROADMAP.md](./ROADMAP.md).
>
> **До версии 0.5 — только чтение.** Запись (`INSERT` / `UPDATE` / `DELETE` / DDL)
> не выполняется. Контролируемая запись — в релизе **0.5**, детали в
> [ROADMAP.md](./ROADMAP.md).

## Install

From a local checkout:

```bash
bb plugin install ~/code/bb-plugin-sql --yes && bb plugin reload sql
```

For live reload while developing:

```bash
cd ~/code/bb-plugin-sql && bb plugin install . --yes && bb plugin dev
```

Once published to GitHub (semver tags):

```bash
bb plugin install git:https://github.com/yazydzhi/bb-plugin-sql.git@^0.1.0
```

## Usage

1. Open **SQL** in the left sidebar (connections + schema tree).
2. **+ Add** a Postgres connection (name, host, port, database, user, password, SSL).
3. Expand a schema; click a table to push `SELECT … LIMIT 100` into the **Query**
   tab (right panel on the SQL page), or use ⋮ → **Show records** / **Describe**.
4. In **Query** (sidebar fixed tab) or a thread’s **New tab → Actions → SQL**,
   edit SQL and press **Run** or ⌘/Ctrl+Enter. Use **History** to re-run past queries.
   **Open .sql…** loads a local file into the editor (honors `-- @conn Name` if present).
5. Open a `.sql` file via the **host** file flow (not the Files panel’s built-in
   preview) — pick a connection in the SQL file toolbar, or put
   `-- @conn ConnectionName` in the first lines as a default hint.

Every query currently runs inside `BEGIN READ ONLY` with `statement_timeout`.
Results are capped at 500 rows (configurable via the agent tool's `limit`).
Writes fail until **0.5** (see roadmap).

### Opening `.sql` files (File openers vs Files)

**Settings → File openers → `.sql` → SQL** applies to **host** opens:

- Markdown / chat file links → Open with / default opener
- Files panel → **Open in SQL** or **Open with preferred…** (reopens via the host)

Clicking a file inside **Actions → Files** still uses Files’ own text preview
(download / copy). That panel does **not** mount this plugin’s `fileOpener`
until you use one of the actions above (or open the file outside Files).

Setup checklist:

1. Install and enable this plugin (`sql`).
2. In **Settings → File openers**, set `.sql` to **SQL (sql)**.
3. From Files: open a `.sql` file → toolbar **Open in SQL** (or context menu).
4. Or from **SQL → Query**: **Open .sql…** to load a file into the editor.

### Agent tools

- `sql_list_connections` — discover configured connection names/ids.
- `sql_query` — `{ connection, sql, limit? }` → text table (**read-only** until 0.5).

## Security notes

- Passwords live in the plugin's private SQLite (`<dataDir>/plugins/sql/data.db`).
  Fine for local/dev; do not point this at production credentials without a
  stronger secret store (planned improvements in **0.3**).
- RPC responses never include the password field.

## Roadmap

See [ROADMAP.md](./ROADMAP.md): **0.2** classic workflow → marketplace → **0.3**
credentials → **0.4** convenience / run-from-chat → **0.5 controlled write**.

## License

MIT
