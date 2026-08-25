// PostgreSQL driver: pool cache, introspection, read-only query execution.
// # ponytail: plaintext-in-sqlite password storage, upgrade to OS keychain via bb.host
//   if this plugin is ever used with prod credentials
import pg from "pg";

const { Pool } = pg;

export type PostgresConfig = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
};

export type QueryResult = {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  durationMs: number;
  truncated: boolean;
};

const DEFAULT_LIMIT_ROWS = 500;
const DEFAULT_TIMEOUT_MS = 30_000;

/** Один Pool на connection id; закрывается в bb.onDispose. */
const pools = new Map<string, pg.Pool>();

function poolConfig(config: PostgresConfig): pg.PoolConfig {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl ? true : undefined,
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  };
}

/**
 * Возвращает (или создаёт) пул для connection id.
 */
export function getPool(connectionId: string, config: PostgresConfig): pg.Pool {
  const existing = pools.get(connectionId);
  if (existing) {
    return existing;
  }
  const pool = new Pool(poolConfig(config));
  pools.set(connectionId, pool);
  return pool;
}

/**
 * Закрывает и удаляет пул для connection id (после update/delete).
 */
export async function dropPool(connectionId: string): Promise<void> {
  const pool = pools.get(connectionId);
  if (!pool) {
    return;
  }
  pools.delete(connectionId);
  await pool.end();
}

/**
 * Закрывает все пулы — вызывается из bb.onDispose.
 */
export async function closeAllPools(): Promise<void> {
  const pending = [...pools.entries()].map(async ([id, pool]) => {
    pools.delete(id);
    await pool.end();
  });
  await Promise.all(pending);
}

/**
 * Проверяет доступность Postgres: SELECT 1 на одноразовом клиенте.
 */
export async function testConnection(
  config: PostgresConfig,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = new pg.Client(poolConfig(config));
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

/**
 * Колонки таблицы.
 */
export async function listColumns(
  pool: pg.Pool,
  schema: string,
  table: string,
): Promise<{ name: string; dataType: string; isNullable: boolean }[]> {
  const result = await pool.query<{
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>(
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    [schema, table],
  );
  return result.rows.map((row) => ({
    name: row.column_name,
    dataType: row.data_type,
    isNullable: row.is_nullable === "YES",
  }));
}

/**
 * Выполняет SQL в READ ONLY транзакции с statement_timeout и лимитом строк.
 * Одна реализация для UI и agent tool.
 */
export async function runQuery(
  pool: pg.Pool,
  sql: string,
  options?: { limitRows?: number; timeoutMs?: number },
): Promise<QueryResult> {
  const limitRows = options?.limitRows ?? DEFAULT_LIMIT_ROWS;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const client = await pool.connect();
  const started = Date.now();

  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);
    const result = await client.query(sql);
    await client.query("COMMIT");

    const columns = result.fields.map((field) => field.name);
    const truncated = result.rows.length > limitRows;
    const sliced = truncated ? result.rows.slice(0, limitRows) : result.rows;
    const rows = sliced.map((row) => serializeRow(columns, row));

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
 */
export function formatQueryAsText(result: QueryResult): string {
  if (result.columns.length === 0) {
    return `OK — ${result.rowCount} row(s) in ${result.durationMs}ms` +
      (result.truncated ? " (truncated)" : "");
  }

  const stringRows = result.rows.map((row) =>
    result.columns.map((column) => cellToString(row[column])),
  );
  const widths = result.columns.map((column, index) => {
    let width = column.length;
    for (const row of stringRows) {
      width = Math.max(width, Math.min(row[index]!.length, 40));
    }
    return width;
  });

  const pad = (text: string, width: number) => {
    const clipped = text.length > 40 ? `${text.slice(0, 37)}...` : text;
    return clipped.padEnd(width);
  };

  const header = result.columns
    .map((column, index) => pad(column, widths[index]!))
    .join(" | ");
  const separator = widths.map((width) => "-".repeat(width)).join("-+-");
  const body = stringRows
    .map((row) => row.map((cell, index) => pad(cell, widths[index]!)).join(" | "))
    .join("\n");

  const footer =
    `\n\n${result.rowCount} row(s) in ${result.durationMs}ms` +
    (result.truncated ? " (truncated at limit)" : "");

  return `${header}\n${separator}\n${body}${footer}`;
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
