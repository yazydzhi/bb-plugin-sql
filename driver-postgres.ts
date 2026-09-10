// PostgreSQL driver: pool cache, introspection, read-only query execution.
// Passwords live in a 0600 secrets file (see lib/connection-secrets.ts), not in
// the query path itself.
import fs from "node:fs";
import pg from "pg";

const { Pool } = pg;

export type PostgresSslConfig =
  | boolean
  | {
      rejectUnauthorized?: boolean;
      ca?: string;
      cert?: string;
      key?: string;
    };

export type PostgresConfig = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: PostgresSslConfig;
};

/** Режим сессии пула: влияет на default_transaction_read_only. */
export type PoolAccessMode = "readonly" | "readwrite";

export type QueryResult = {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  durationMs: number;
  truncated: boolean;
};

const DEFAULT_LIMIT_ROWS = 500;
const DEFAULT_TIMEOUT_MS = 30_000;
/** Жёсткий потолок текста для agent tool, чтобы не раздувать контекст. */
export const AGENT_RESULT_MAX_CHARS = 24_000;
const AGENT_CELL_MAX_CHARS = 40;
const AGENT_MAX_COLUMNS = 32;

/** Один Pool на connection id; закрывается в bb.onDispose. */
const pools = new Map<string, { pool: pg.Pool; accessMode: PoolAccessMode }>();

/**
 * Собирает pg SSL-опции из флага и опциональных путей к PEM.
 */
export function buildSslConfig(options: {
  ssl: boolean;
  sslCaPath?: string | null;
  sslCertPath?: string | null;
  sslKeyPath?: string | null;
}): PostgresSslConfig | undefined {
  if (!options.ssl) {
    return undefined;
  }
  const caPath = options.sslCaPath?.trim() || "";
  const certPath = options.sslCertPath?.trim() || "";
  const keyPath = options.sslKeyPath?.trim() || "";
  if (!caPath && !certPath && !keyPath) {
    return true;
  }
  const ssl: {
    rejectUnauthorized: boolean;
    ca?: string;
    cert?: string;
    key?: string;
  } = { rejectUnauthorized: true };
  if (caPath) {
    ssl.ca = fs.readFileSync(caPath, "utf8");
  }
  if (certPath) {
    ssl.cert = fs.readFileSync(certPath, "utf8");
  }
  if (keyPath) {
    ssl.key = fs.readFileSync(keyPath, "utf8");
  }
  return ssl;
}

function poolConfig(
  config: PostgresConfig,
  accessMode: PoolAccessMode = "readwrite",
): pg.PoolConfig {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl === false ? undefined : config.ssl,
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    options:
      accessMode === "readonly"
        ? "-c default_transaction_read_only=on"
        : "-c default_transaction_read_only=off",
  };
}

/**
 * Возвращает (или создаёт) пул для connection id.
 */
export function getPool(
  connectionId: string,
  config: PostgresConfig,
  accessMode: PoolAccessMode = "readwrite",
): pg.Pool {
  const existing = pools.get(connectionId);
  if (existing) {
    return existing.pool;
  }
  const pool = new Pool(poolConfig(config, accessMode));
  pools.set(connectionId, { pool, accessMode });
  return pool;
}

/**
 * Пул есть только после Connect; иначе null.
 */
export function getConnectedPool(connectionId: string): pg.Pool | null {
  return pools.get(connectionId)?.pool ?? null;
}

export function isConnected(connectionId: string): boolean {
  return pools.has(connectionId);
}

/**
 * Открывает пул и проверяет SELECT 1. Уже открытый — переиспользует и пингует.
 */
export async function connectPool(
  connectionId: string,
  config: PostgresConfig,
  accessMode: PoolAccessMode = "readwrite",
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const existing = pools.get(connectionId);
    if (existing && existing.accessMode !== accessMode) {
      await dropPool(connectionId);
    }
    const pool = getPool(connectionId, config, accessMode);
    await pool.query("SELECT 1");
    return { ok: true };
  } catch (error) {
    await dropPool(connectionId);
    return { ok: false, error: formatError(error) };
  }
}

/**
 * Закрывает пул (Disconnect). Конфиг в SQLite не трогает.
 */
export async function disconnectPool(connectionId: string): Promise<void> {
  await dropPool(connectionId);
}

/**
 * Закрывает пул и открывает заново (Reconnect).
 */
export async function reconnectPool(
  connectionId: string,
  config: PostgresConfig,
  accessMode: PoolAccessMode = "readwrite",
): Promise<{ ok: true } | { ok: false; error: string }> {
  await dropPool(connectionId);
  return connectPool(connectionId, config, accessMode);
}

/**
 * Закрывает и удаляет пул для connection id (после update/delete).
 */
export async function dropPool(connectionId: string): Promise<void> {
  const entry = pools.get(connectionId);
  if (!entry) {
    return;
  }
  pools.delete(connectionId);
  await entry.pool.end();
}

/**
 * Закрывает все пулы — вызывается из bb.onDispose.
 */
export async function closeAllPools(): Promise<void> {
  const pending = [...pools.entries()].map(async ([id, entry]) => {
    pools.delete(id);
    await entry.pool.end();
  });
  await Promise.all(pending);
}

/**
 * Проверяет доступность Postgres: SELECT 1 на одноразовом клиенте.
 */
export async function testConnection(
  config: PostgresConfig,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = new pg.Client(poolConfig(config, "readwrite"));
  try {
    await client.connect();
    await client.query("SELECT 1");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: formatError(error) };
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Список пользовательских схем (без системных).
 */
export async function listSchemas(pool: pg.Pool): Promise<string[]> {
  const result = await pool.query<{ schema_name: string }>(
    `SELECT schema_name
     FROM information_schema.schemata
     WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
       AND schema_name NOT LIKE 'pg\\_%' ESCAPE '\\'
     ORDER BY schema_name`,
  );
  return result.rows.map((row) => row.schema_name);
}

/**
 * Таблицы (и views) в схеме.
 */
export async function listTables(
  pool: pg.Pool,
  schema: string,
): Promise<{ name: string; type: string }[]> {
  const result = await pool.query<{ table_name: string; table_type: string }>(
    `SELECT table_name, table_type
     FROM information_schema.tables
     WHERE table_schema = $1
     ORDER BY table_name`,
    [schema],
  );
  return result.rows.map((row) => ({
    name: row.table_name,
    type: row.table_type,
  }));
}

export type ColumnDetail = {
  name: string;
  dataType: string;
  isNullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
  isUnique: boolean;
  foreignKey: {
    constraintName: string;
    schema: string;
    table: string;
    column: string;
  } | null;
};

export type ConstraintDetail = {
  name: string;
  type: "PRIMARY KEY" | "FOREIGN KEY" | "UNIQUE" | "CHECK" | "EXCLUDE";
  columns: string[];
  definition: string;
};

export type TableDescribe = {
  columns: ColumnDetail[];
  constraints: ConstraintDetail[];
};

const CONSTRAINT_TYPE_MAP: Record<string, ConstraintDetail["type"]> = {
  p: "PRIMARY KEY",
  f: "FOREIGN KEY",
  u: "UNIQUE",
  c: "CHECK",
  x: "EXCLUDE",
};

/** pg иногда отдаёт array_agg как строку `{a,b}` вместо JS-массива. */
function parsePgTextArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  if (typeof value !== "string") {
    return [];
  }
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "{}") {
    return [];
  }
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return [trimmed];
  }
  const inner = trimmed.slice(1, -1);
  if (!inner) {
    return [];
  }
  const items: string[] = [];
  let current = "";
  let inQuote = false;
  for (let index = 0; index < inner.length; index += 1) {
    const ch = inner[index]!;
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (ch === "," && !inQuote) {
      items.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) {
    items.push(current.trim());
  }
  return items;
}

function asBoolean(value: unknown): boolean {
  return value === true || value === "t" || value === "true" || value === 1;
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}

function asString(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
}

/**
 * Колонки таблицы (краткий список).
 */
export async function listColumns(
  pool: pg.Pool,
  schema: string,
  table: string,
): Promise<{ name: string; dataType: string; isNullable: boolean }[]> {
  const { columns } = await describeTable(pool, schema, table);
  return columns.map((column) => ({
    name: column.name,
    dataType: column.dataType,
    isNullable: column.isNullable,
  }));
}

/**
 * Колонки + constraints одной таблицы (для дерева и Describe).
 */
export async function describeTable(
  pool: pg.Pool,
  schema: string,
  table: string,
): Promise<TableDescribe> {
  const columnsResult = await pool.query<{
    name: string;
    data_type: string;
    is_nullable: boolean;
    column_default: string | null;
    is_primary_key: boolean;
    is_unique: boolean;
  }>(
    `SELECT
       a.attname AS name,
       pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
       NOT a.attnotnull AS is_nullable,
       pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS column_default,
       EXISTS (
         SELECT 1
         FROM pg_catalog.pg_index i
         WHERE i.indrelid = c.oid
           AND i.indisprimary
           AND a.attnum = ANY (i.indkey)
       ) AS is_primary_key,
       EXISTS (
         SELECT 1
         FROM pg_catalog.pg_index i
         WHERE i.indrelid = c.oid
           AND i.indisunique
           AND NOT i.indisprimary
           AND i.indnkeyatts = 1
           AND a.attnum = i.indkey[0]
       ) AS is_unique
     FROM pg_catalog.pg_attribute a
     JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_catalog.pg_attrdef ad
       ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
     WHERE n.nspname = $1
       AND c.relname = $2
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND a.attnum > 0
       AND NOT a.attisdropped
     ORDER BY a.attnum`,
    [schema, table],
  );

  const fkResult = await pool.query<{
    column_name: string;
    constraint_name: string;
    foreign_schema: string;
    foreign_table: string;
    foreign_column: string;
  }>(
    `SELECT
       src.attname AS column_name,
       con.conname AS constraint_name,
       fn.nspname AS foreign_schema,
       ft.relname AS foreign_table,
       tgt.attname AS foreign_column
     FROM pg_catalog.pg_constraint con
     JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS src_cols(attnum, ord)
       ON true
     JOIN pg_catalog.pg_attribute src
       ON src.attrelid = con.conrelid AND src.attnum = src_cols.attnum
     JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS tgt_cols(attnum, ord)
       ON tgt_cols.ord = src_cols.ord
     JOIN pg_catalog.pg_class ft ON ft.oid = con.confrelid
     JOIN pg_catalog.pg_namespace fn ON fn.oid = ft.relnamespace
     JOIN pg_catalog.pg_attribute tgt
       ON tgt.attrelid = con.confrelid AND tgt.attnum = tgt_cols.attnum
     WHERE con.contype = 'f'
       AND n.nspname = $1
       AND c.relname = $2
     ORDER BY con.conname, src_cols.ord`,
    [schema, table],
  );

  const fkByColumn = new Map<string, ColumnDetail["foreignKey"]>();
  for (const row of fkResult.rows) {
    if (!fkByColumn.has(row.column_name)) {
      fkByColumn.set(row.column_name, {
        constraintName: row.constraint_name,
        schema: row.foreign_schema,
        table: row.foreign_table,
        column: row.foreign_column,
      });
    }
  }

  const constraintsResult = await pool.query<{
    name: string;
    contype: string;
    definition: string;
    columns: string[] | null;
  }>(
    `SELECT
       con.conname AS name,
       con.contype,
       pg_catalog.pg_get_constraintdef(con.oid, true) AS definition,
       (
         SELECT array_agg(a.attname ORDER BY cols.ord)
         FROM unnest(con.conkey) WITH ORDINALITY AS cols(attnum, ord)
         JOIN pg_catalog.pg_attribute a
           ON a.attrelid = con.conrelid AND a.attnum = cols.attnum
       ) AS columns
     FROM pg_catalog.pg_constraint con
     JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1
       AND c.relname = $2
       AND con.contype IN ('p', 'f', 'u', 'c', 'x')
     ORDER BY
       CASE con.contype
         WHEN 'p' THEN 0
         WHEN 'u' THEN 1
         WHEN 'f' THEN 2
         WHEN 'c' THEN 3
         ELSE 4
       END,
       con.conname`,
    [schema, table],
  );

  const columns: ColumnDetail[] = columnsResult.rows.map((row) => ({
    name: asString(row.name),
    dataType: asString(row.data_type),
    isNullable: asBoolean(row.is_nullable),
    defaultValue: asNullableString(row.column_default),
    isPrimaryKey: asBoolean(row.is_primary_key),
    isUnique: asBoolean(row.is_unique),
    foreignKey: fkByColumn.get(row.name) ?? null,
  }));

  const constraints: ConstraintDetail[] = constraintsResult.rows
    .map((row) => {
      const type = CONSTRAINT_TYPE_MAP[row.contype];
      if (!type) {
        return null;
      }
      return {
        name: asString(row.name),
        type,
        columns: parsePgTextArray(row.columns),
        definition: asString(row.definition),
      };
    })
    .filter((row): row is ConstraintDetail => row !== null);

  return { columns, constraints };
}

/**
 * Выполняет SQL в транзакции с statement_timeout и лимитом строк.
 * Read: BEGIN READ ONLY + cursor FETCH. Write: BEGIN + прямой query.
 */
export async function runQuery(
  pool: pg.Pool,
  sql: string,
  options?: {
    limitRows?: number;
    timeoutMs?: number;
    transactionMode?: "readonly" | "readwrite";
  },
): Promise<QueryResult> {
  const limitRows = options?.limitRows ?? DEFAULT_LIMIT_ROWS;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const transactionMode = options?.transactionMode ?? "readonly";
  const beginSql =
    transactionMode === "readwrite" ? "BEGIN" : "BEGIN READ ONLY";
  const client = await pool.connect();
  const started = Date.now();

  try {
    await client.query(beginSql);
    await client.query(
      `SET LOCAL statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`,
    );

    let columns: string[];
    let rowsRaw: Record<string, unknown>[];
    let truncated: boolean;

    const cursorOk =
      transactionMode === "readonly"
        ? await tryFetchViaCursor(client, sql, limitRows)
        : null;
    if (cursorOk) {
      columns = cursorOk.columns;
      rowsRaw = cursorOk.rows;
      truncated = cursorOk.truncated;
    } else {
      if (transactionMode === "readonly") {
        await client.query("ROLLBACK").catch(() => undefined);
        await client.query(beginSql);
        await client.query(
          `SET LOCAL statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`,
        );
      }
      const rawResult = await client.query({ text: sql, values: [] });
      if (Array.isArray(rawResult)) {
        throw new Error("Multiple SQL statements per call are not allowed.");
      }
      columns = (rawResult.fields ?? []).map((field) => field.name);
      const affected =
        typeof rawResult.rowCount === "number" ? rawResult.rowCount : rawResult.rows.length;
      truncated = rawResult.rows.length > limitRows;
      rowsRaw = truncated ? rawResult.rows.slice(0, limitRows) : rawResult.rows;
      // Для DML без RETURNING rows пустые — отдаём rowCount через синтетику ниже.
      if (columns.length === 0 && transactionMode === "readwrite") {
        columns = ["rowCount"];
        rowsRaw = [{ rowCount: affected }];
        truncated = false;
      }
    }

    await client.query("COMMIT");
    const rows = rowsRaw.map((row) => serializeRow(columns, row));

    return {
      columns,
      rows,
      rowCount: rows.length,
      durationMs: Date.now() - started,
      truncated,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw new Error(formatError(error));
  } finally {
    client.release();
  }
}

/**
 * DECLARE CURSOR + FETCH limit+1 — не тянет весь result set в Node.
 * Возвращает null, если запрос нельзя обернуть в cursor.
 */
async function tryFetchViaCursor(
  client: pg.PoolClient,
  sql: string,
  limitRows: number,
): Promise<{ columns: string[]; rows: Record<string, unknown>[]; truncated: boolean } | null> {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (!trimmed || /;/.test(trimmed)) {
    return null;
  }

  try {
    await client.query({
      text: `DECLARE __bb_sql_cur NO SCROLL CURSOR FOR\n${trimmed}`,
      values: [],
    });
  } catch {
    return null;
  }

  try {
    const fetchCount = Math.max(1, Math.floor(limitRows)) + 1;
    const fetched = await client.query({
      text: `FETCH ${fetchCount} FROM __bb_sql_cur`,
      values: [],
    });
    await client.query({ text: "CLOSE __bb_sql_cur", values: [] });

    if (Array.isArray(fetched)) {
      throw new Error("Unexpected multi-result FETCH");
    }
    const columns = (fetched.fields ?? []).map((field) => field.name);
    const truncated = fetched.rows.length > limitRows;
    const rows = truncated ? fetched.rows.slice(0, limitRows) : fetched.rows;
    return { columns, rows, truncated };
  } catch (error) {
    await client.query({ text: "CLOSE __bb_sql_cur", values: [] }).catch(() => undefined);
    throw error;
  }
}

function serializeRow(
  columns: string[],
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const column of columns) {
    out[column] = serializeValue(row[column]);
  }
  return out;
}

/** Приводит значения ячеек к JSON-safe виду для bb.rpc. */
function serializeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    return `\\x${value.toString("hex")}`;
  }
  if (typeof value === "object") {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
    }
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return String(value);
  }
  return value;
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Форматирует результат запроса в текстовую таблицу для agent tool.
 * Данные обёрнуты как untrusted; длина жёстко ограничена.
 */
export function formatQueryAsText(result: QueryResult): string {
  const meta =
    `${result.rowCount} row(s) in ${result.durationMs}ms` +
    (result.truncated ? " (truncated at row limit)" : "");

  if (result.columns.length === 0) {
    return frameAgentResult(`OK — ${meta}`);
  }

  const columns = result.columns.slice(0, AGENT_MAX_COLUMNS);
  const omittedColumns = result.columns.length - columns.length;

  const stringRows = result.rows.map((row) =>
    columns.map((column) => cellToString(row[column])),
  );
  const widths = columns.map((column, index) => {
    let width = column.length;
    for (const row of stringRows) {
      width = Math.max(width, Math.min(row[index]!.length, AGENT_CELL_MAX_CHARS));
    }
    return width;
  });

  const pad = (text: string, width: number) => {
    const clipped =
      text.length > AGENT_CELL_MAX_CHARS
        ? `${text.slice(0, AGENT_CELL_MAX_CHARS - 3)}...`
        : text;
    return clipped.padEnd(width);
  };

  const header = columns
    .map((column, index) => pad(column, widths[index]!))
    .join(" | ");
  const separator = widths.map((width) => "-".repeat(width)).join("-+-");
  const body = stringRows
    .map((row) => row.map((cell, index) => pad(cell, widths[index]!)).join(" | "))
    .join("\n");

  let table = `${header}\n${separator}\n${body}\n\n${meta}`;
  if (omittedColumns > 0) {
    table += `\n(${omittedColumns} more column(s) omitted)`;
  }

  if (table.length > AGENT_RESULT_MAX_CHARS) {
    table =
      `${table.slice(0, AGENT_RESULT_MAX_CHARS - 80)}\n\n` +
      `… truncated for agent context (${AGENT_RESULT_MAX_CHARS} char cap)`;
  }

  return frameAgentResult(table);
}

function frameAgentResult(body: string): string {
  return (
    "----- BEGIN sql_query result (untrusted data) -----\n" +
    `${body}\n` +
    "----- END sql_query result -----"
  );
}

function cellToString(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}
