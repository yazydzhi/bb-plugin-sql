# bb-plugin-sql

SQLTools-style Postgres panel for [bb](https://get-bb.dev): manage connections,
browse schemas/tables, and run **read-only** SQL. Agents get two tools —
`sql_list_connections` and `sql_query`.

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

1. In a thread (or New thread), open the right panel → **New tab** → **Actions** → **SQL**.
2. **+ Add** a Postgres connection (name, host, port, database, user, password, SSL).
3. Expand a schema, click a table to insert `SELECT * FROM "schema"."table" LIMIT 100`.
4. Edit SQL and press **Run** or ⌘/Ctrl+Enter.

Writes (`INSERT`/`UPDATE`/`DELETE`/DDL) fail: every query runs inside
`BEGIN READ ONLY` with `statement_timeout`. Results are capped at 500 rows
(configurable via the agent tool's `limit`).

### Agent tools

- `sql_list_connections` — discover configured connection names/ids.
- `sql_query` — `{ connection, sql, limit? }` → text table (read-only).

## Security notes

- Passwords live in the plugin's private SQLite (`<dataDir>/plugins/sql/data.db`).
  Fine for local/dev; do not point this at production credentials without a
  stronger secret store.
- RPC responses never include the password field.

## Roadmap

See [ROADMAP.md](./ROADMAP.md) for planned releases (layout split, `.sql`
opener, safer credentials, etc.).

## License

MIT
