// bb-plugin-sql — backend: connection CRUD, browse, controlled SQL, agent tools.
import path from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  buildSslConfig,
  closeAllPools,
  connectPool,
  disconnectPool,
  dropPool,
  formatError,
  formatQueryAsText,
  getConnectedPool,
  isConnected,
  describeTable as driverDescribeTable,
  listColumns as driverListColumns,
  listSchemas as driverListSchemas,
  listTables as driverListTables,
  reconnectPool,
  runQuery as driverRunQuery,
  testConnection as driverTestConnection,
  type PostgresConfig,
} from "./driver-postgres.js";
import {
  deleteConnectionPassword,
  getConnectionPassword,
  hasConnectionPassword,
  setConnectionPassword,
} from "./lib/connection-secrets.js";
import {
  assessSqlStatement,
  sqlNeedsWriteTransaction,
  type AccessMode,
} from "./lib/sql-safety.js";
import { parseConnHint } from "./lib/parse-conn-hint.js";

const accessModeSchema = z.enum(["readonly", "readwrite"]);

const connectionPublicSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    host: z.string(),
    port: z.number().int(),
    database: z.string(),
    user: z.string(),
    ssl: z.boolean(),
    sslCaPath: z.string().nullable(),
    sslCertPath: z.string().nullable(),
    sslKeyPath: z.string().nullable(),
    /** UI default: readwrite. */
    accessMode: accessModeSchema,
    /** Agent DML/DDL; default off. */
    agentWrite: z.boolean(),
    /** CREATE/ALTER/DROP/…; default off. */
    allowDdl: z.boolean(),
    hasPassword: z.boolean(),
    createdAt: z.string(),
  })
  .strict();

const connectionListItemSchema = connectionPublicSchema.extend({
  connected: z.boolean(),
});

const sslPathsSchema = {
  sslCaPath: z.string().optional().nullable(),
  sslCertPath: z.string().optional().nullable(),
  sslKeyPath: z.string().optional().nullable(),
};

const connectionInputSchema = z
  .object({
    name: z.string().min(1),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(5432),
    database: z.string().min(1),
    user: z.string().min(1),
    password: z.string(),
    ssl: z.boolean().default(false),
    accessMode: accessModeSchema.default("readwrite"),
    agentWrite: z.boolean().default(false),
    allowDdl: z.boolean().default(false),
    ...sslPathsSchema,
  })
  .strict();

const updateConnectionInputSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    database: z.string().min(1),
    user: z.string().min(1),
    // Пустой/отсутствующий пароль = оставить прежний в secrets.
    password: z.string().optional(),
    ssl: z.boolean(),
    accessMode: accessModeSchema,
    agentWrite: z.boolean(),
    allowDdl: z.boolean(),
    ...sslPathsSchema,
  })
  .strict();

const sqlAssessmentSchema = z
  .object({
    kind: z.enum([
      "read",
      "insert",
      "update",
      "delete",
      "merge",
      "ddl",
      "admin",
      "unknown",
    ]),
    allowed: z.boolean(),
    blockReason: z.string().nullable(),
    confirmLevel: z.enum(["none", "confirm", "type_table"]),
    requiresConfirm: z.boolean(),
    missingOrTautologyWhere: z.boolean(),
    targetTable: z.string().nullable(),
    summary: z.string(),
  })
  .strict();

const queryResultSchema = z
  .object({
    columns: z.array(z.string()),
    rows: z.array(z.record(z.string(), z.unknown())),
    rowCount: z.number().int(),
    durationMs: z.number(),
    truncated: z.boolean(),
  })
  .strict();

export const rpcContract = defineRpcContract({
  listConnections: {
    input: z.null(),
    output: z
      .object({ connections: z.array(connectionListItemSchema) })
      .strict(),
  },
  createConnection: {
    input: connectionInputSchema,
    output: z.object({ connection: connectionPublicSchema }).strict(),
  },
  updateConnection: {
    input: updateConnectionInputSchema,
    output: z.object({ connection: connectionPublicSchema }).strict(),
  },
  deleteConnection: {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  testConnection: {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z
      .object({
        ok: z.boolean(),
        error: z.string().optional(),
      })
      .strict(),
  },
  /** Статус пула: connected только после Connect / успешного query-path. */
  getConnectionStatus: {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z
      .object({
        connected: z.boolean(),
      })
      .strict(),
  },
  connectConnection: {
    input: z
      .object({
        id: z.string().min(1),
        /** Если пароль не сохранён — передать сюда для сессии. */
        password: z.string().optional(),
      })
      .strict(),
    output: z
      .object({
        ok: z.boolean(),
        error: z.string().optional(),
        needsPassword: z.boolean().optional(),
      })
      .strict(),
  },
  disconnectConnection: {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  reconnectConnection: {
    input: z
      .object({
        id: z.string().min(1),
        password: z.string().optional(),
      })
      .strict(),
    output: z
      .object({
        ok: z.boolean(),
        error: z.string().optional(),
        needsPassword: z.boolean().optional(),
      })
      .strict(),
  },
  /** Проверка параметров до сохранения (или с id — подставить пароль из secrets). */
  probeConnection: {
    input: z
      .object({
        id: z.string().optional(),
        host: z.string().min(1),
        port: z.number().int().min(1).max(65535),
        database: z.string().min(1),
        user: z.string().min(1),
        password: z.string().optional(),
        ssl: z.boolean().default(false),
        sslCaPath: z.string().optional().nullable(),
        sslCertPath: z.string().optional().nullable(),
        sslKeyPath: z.string().optional().nullable(),
      })
      .strict(),
    output: z
      .object({
        ok: z.boolean(),
        error: z.string().optional(),
      })
      .strict(),
  },
  listSchemas: {
    input: z.object({ connectionId: z.string().min(1) }).strict(),
    output: z.object({ schemas: z.array(z.string()) }).strict(),
  },
  listTables: {
    input: z
      .object({
        connectionId: z.string().min(1),
        schema: z.string().min(1),
      })
      .strict(),
    output: z
      .object({
        tables: z.array(
          z.object({ name: z.string(), type: z.string() }).strict(),
        ),
      })
      .strict(),
  },
  listColumns: {
    input: z
      .object({
        connectionId: z.string().min(1),
        schema: z.string().min(1),
        table: z.string().min(1),
      })
      .strict(),
    output: z
      .object({
        columns: z.array(
          z
            .object({
              name: z.string(),
              dataType: z.string(),
              isNullable: z.boolean(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  describeTable: {
    input: z
      .object({
        connectionId: z.string().min(1),
        schema: z.string().min(1),
        table: z.string().min(1),
      })
      .strict(),
    output: z
      .object({
        columns: z.array(
          z
            .object({
              name: z.string(),
              dataType: z.string(),
              isNullable: z.boolean(),
              defaultValue: z.string().nullable(),
              isPrimaryKey: z.boolean(),
              isUnique: z.boolean(),
              foreignKey: z
                .object({
                  constraintName: z.string(),
                  schema: z.string(),
                  table: z.string(),
                  column: z.string(),
                })
                .strict()
                .nullable(),
            })
            .strict(),
        ),
        constraints: z.array(
          z
            .object({
              name: z.string(),
              type: z.enum([
                "PRIMARY KEY",
                "FOREIGN KEY",
                "UNIQUE",
                "CHECK",
                "EXCLUDE",
              ]),
              columns: z.array(z.string()),
              definition: z.string(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  runQuery: {
    input: z
      .object({
        connectionId: z.string().min(1),
        sql: z.string().min(1),
        limit: z.number().int().positive().max(5000).optional(),
        /** UI подтвердил опасный DML. */
        confirmed: z.boolean().optional(),
        /** Для type_table: имя таблицы как в assessment.targetTable. */
        confirmedTable: z.string().optional(),
      })
      .strict(),
    output: queryResultSchema,
  },
  /** Предпросмотр безопасности statement до Run. */
  assessQuery: {
    input: z
      .object({
        connectionId: z.string().min(1),
        sql: z.string().min(1),
      })
      .strict(),
    output: sqlAssessmentSchema,
  },
  /** Shared active connection + pending draft SQL (explorer → query panel). */
  getUiState: {
    input: z.null(),
    output: z
      .object({
        activeConnectionId: z.string().nullable(),
        draftSql: z.string().nullable(),
        draftAutoRun: z.boolean(),
        connectionSortMode: z.enum(["asc", "desc", "free"]),
      })
      .strict(),
  },
  setActiveConnection: {
    input: z.object({ id: z.string().nullable() }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  setConnectionSortMode: {
    input: z
      .object({
        mode: z.enum(["asc", "desc", "free"]),
      })
      .strict(),
    output: z
      .object({
        ok: z.literal(true),
        mode: z.enum(["asc", "desc", "free"]),
      })
      .strict(),
  },
  reorderConnections: {
    input: z
      .object({
        ids: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  setDraftSql: {
    input: z
      .object({
        sql: z.string(),
        autoRun: z.boolean().default(false),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  consumeDraftSql: {
    input: z.null(),
    output: z
      .object({
        sql: z.string().nullable(),
        autoRun: z.boolean(),
      })
      .strict(),
  },
  listHistory: {
    input: z
      .object({ limit: z.number().int().positive().max(200).optional() })
      .strict(),
    output: z
      .object({
        items: z.array(
          z
            .object({
              id: z.string(),
              connectionId: z.string(),
              connectionName: z.string(),
              sql: z.string(),
              createdAt: z.string(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  recordHistory: {
    input: z
      .object({
        connectionId: z.string().min(1),
        sql: z.string().min(1),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  clearHistory: {
    input: z.null(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  listBookmarks: {
    input: z.null(),
    output: z
      .object({
        items: z.array(
          z
            .object({
              id: z.string(),
              title: z.string(),
              sql: z.string(),
              connectionId: z.string().nullable(),
              createdAt: z.string(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  addBookmark: {
    input: z
      .object({
        title: z.string().min(1).max(200),
        sql: z.string().min(1),
        connectionId: z.string().nullable().optional(),
      })
      .strict(),
    output: z
      .object({
        item: z
          .object({
            id: z.string(),
            title: z.string(),
            sql: z.string(),
            connectionId: z.string().nullable(),
            createdAt: z.string(),
          })
          .strict(),
      })
      .strict(),
  },
  deleteBookmark: {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  readSqlFile: {
    input: z
      .object({
        path: z.string().min(1),
        kind: z.enum(["host", "workspace", "thread-storage"]),
        threadId: z.string().nullable(),
        environmentId: z.string().nullable(),
        projectId: z.string().nullable(),
      })
      .strict(),
    output: z
      .object({
        content: z.string(),
        connectionHint: z.string().nullable(),
      })
      .strict(),
  },
});

type ConnectionRow = {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  /** Устарело: пароль в SQLite; после миграции всегда "". */
  password: string;
  ssl: number;
  ssl_ca_path: string | null;
  ssl_cert_path: string | null;
  ssl_key_path: string | null;
  /** "readonly" | "readwrite"; default readwrite. */
  access_mode: string;
  /** 0/1; default 0. */
  agent_write: number;
  /** 0/1; default 0. */
  allow_ddl: number;
  created_at: string;
};

type PublicConnection = {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  ssl: boolean;
  sslCaPath: string | null;
  sslCertPath: string | null;
  sslKeyPath: string | null;
  accessMode: AccessMode;
  agentWrite: boolean;
  allowDdl: boolean;
  hasPassword: boolean;
  createdAt: string;
};

const CONNECTION_SELECT = `id, name, host, port, database, "user", password, ssl,
  ssl_ca_path, ssl_cert_path, ssl_key_path,
  COALESCE(access_mode, 'readwrite') AS access_mode,
  COALESCE(agent_write, 0) AS agent_write,
  COALESCE(allow_ddl, 0) AS allow_ddl,
  created_at`;

function normalizePath(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function rowAccessMode(row: ConnectionRow): AccessMode {
  return row.access_mode === "readonly" ? "readonly" : "readwrite";
}

function rowAgentWrite(row: ConnectionRow): boolean {
  return row.agent_write === 1;
}

function rowAllowDdl(row: ConnectionRow): boolean {
  return row.allow_ddl === 1;
}

/** Сравнивает имена таблиц без кавычек и регистра схемы. */
function tablesMatch(expected: string | null, typed: string | undefined): boolean {
  if (!expected || !typed) {
    return false;
  }
  const norm = (value: string) =>
    value.replaceAll('"', "").replace(/\s+/g, "").toLowerCase();
  return norm(expected) === norm(typed);
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 5432,
      database TEXT NOT NULL,
      "user" TEXT NOT NULL,
      password TEXT NOT NULL,
      ssl INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ui_prefs (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS query_history (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      connection_name TEXT NOT NULL,
      sql TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `ALTER TABLE connections ADD COLUMN ssl_ca_path TEXT`,
    `ALTER TABLE connections ADD COLUMN ssl_cert_path TEXT`,
    `ALTER TABLE connections ADD COLUMN ssl_key_path TEXT`,
    `CREATE TABLE IF NOT EXISTS bookmarks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      sql TEXT NOT NULL,
      connection_id TEXT,
      created_at TEXT NOT NULL
    )`,
    // 0.5: режим доступа и agent write (default R/W UI, agent off).
    `ALTER TABLE connections ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'readwrite'`,
    `ALTER TABLE connections ADD COLUMN agent_write INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE connections ADD COLUMN allow_ddl INTEGER NOT NULL DEFAULT 0`,
  ]);

  const pluginDataDir = path.dirname(String((db as { name?: string }).name ?? ""));
  if (!pluginDataDir || pluginDataDir === "." || pluginDataDir === "") {
    throw new Error("Could not resolve plugin data directory from SQLite path");
  }

  // Одноразовая миграция: пароли из SQLite → secrets/passwords.json (0600).
  {
    const legacy = db
      .prepare(
        `SELECT id, password FROM connections WHERE password IS NOT NULL AND password != ''`,
      )
      .all() as { id: string; password: string }[];
    for (const row of legacy) {
      if (!hasConnectionPassword(pluginDataDir, row.id)) {
        setConnectionPassword(pluginDataDir, row.id, row.password);
      }
    }
    if (legacy.length > 0) {
      db.prepare(`UPDATE connections SET password = ''`).run();
      bb.log.info(`migrated ${legacy.length} connection password(s) to secrets file`);
    }
  }

  function toPublic(row: ConnectionRow): PublicConnection {
    return {
      id: row.id,
      name: row.name,
      host: row.host,
      port: row.port,
      database: row.database,
      user: row.user,
      ssl: row.ssl === 1,
      sslCaPath: row.ssl_ca_path,
      sslCertPath: row.ssl_cert_path,
      sslKeyPath: row.ssl_key_path,
      accessMode: rowAccessMode(row),
      agentWrite: rowAgentWrite(row),
      allowDdl: rowAllowDdl(row),
      hasPassword: hasConnectionPassword(pluginDataDir, row.id),
      createdAt: row.created_at,
    };
  }

  function toConfig(row: ConnectionRow, password: string): PostgresConfig {
    return {
      host: row.host,
      port: row.port,
      database: row.database,
      user: row.user,
      password,
      ssl:
        buildSslConfig({
          ssl: row.ssl === 1,
          sslCaPath: row.ssl_ca_path,
          sslCertPath: row.ssl_cert_path,
          sslKeyPath: row.ssl_key_path,
        }) ?? false,
    };
  }

  /**
   * Пароль: явный session → secrets → (legacy SQLite, если ещё не мигрировали).
   */
  function resolvePassword(
    row: ConnectionRow,
    sessionPassword?: string,
  ): { password: string } | { needsPassword: true } {
    if (sessionPassword !== undefined) {
      return { password: sessionPassword };
    }
    const stored = getConnectionPassword(pluginDataDir, row.id);
    if (stored !== undefined) {
      return { password: stored };
    }
    if (row.password.length > 0) {
      return { password: row.password };
    }
    return { needsPassword: true };
  }

  function getPref(key: string): string | null {
    const row = db
      .prepare(`SELECT value FROM ui_prefs WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  function setPref(key: string, value: string | null) {
    if (value === null) {
      db.prepare(`DELETE FROM ui_prefs WHERE key = ?`).run(key);
      return;
    }
    db.prepare(
      `INSERT INTO ui_prefs (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
  }

  type ConnectionSortMode = "asc" | "desc" | "free";

  function getSortMode(): ConnectionSortMode {
    const value = getPref("connectionSortMode");
    if (value === "desc" || value === "free" || value === "asc") {
      return value;
    }
    return "asc";
  }

  function getConnectionOrder(): string[] {
    const raw = getPref("connectionOrder");
    if (!raw) {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter((item): item is string => typeof item === "string");
    } catch {
      return [];
    }
  }

  function setConnectionOrder(ids: string[]) {
    setPref("connectionOrder", JSON.stringify(ids));
  }

  function compareNames(a: string, b: string): number {
    return a.localeCompare(b, undefined, { sensitivity: "base" });
  }

  function sortConnectionRows(rows: ConnectionRow[]): ConnectionRow[] {
    const mode = getSortMode();
    if (mode === "asc") {
      return [...rows].sort((left, right) => compareNames(left.name, right.name));
    }
    if (mode === "desc") {
      return [...rows].sort((left, right) => compareNames(right.name, left.name));
    }
    const order = getConnectionOrder();
    const indexById = new Map(order.map((id, index) => [id, index]));
    return [...rows].sort((left, right) => {
      const leftIndex = indexById.has(left.id)
        ? indexById.get(left.id)!
        : Number.MAX_SAFE_INTEGER;
      const rightIndex = indexById.has(right.id)
        ? indexById.get(right.id)!
        : Number.MAX_SAFE_INTEGER;
      if (leftIndex !== rightIndex) {
        return leftIndex - rightIndex;
      }
      return compareNames(left.name, right.name);
    });
  }

  function ensureFreeOrderSeed(rows: ConnectionRow[]) {
    const existing = getConnectionOrder();
    const known = new Set(rows.map((row) => row.id));
    const kept = existing.filter((id) => known.has(id));
    const missing = rows
      .map((row) => row.id)
      .filter((id) => !kept.includes(id));
    const next = [...kept, ...missing];
    if (
      next.length !== existing.length ||
      next.some((id, index) => id !== existing[index])
    ) {
      setConnectionOrder(next);
    }
  }

  function publishUi() {
    bb.realtime.publish("sql:ui", { type: "changed", at: Date.now() });
  }

  function listRows(): ConnectionRow[] {
    const rows = db
      .prepare(
        `SELECT ${CONNECTION_SELECT}
         FROM connections
         ORDER BY created_at ASC`,
      )
      .all() as ConnectionRow[];
    return sortConnectionRows(rows);
  }

  function getRow(id: string): ConnectionRow | undefined {
    return db
      .prepare(
        `SELECT ${CONNECTION_SELECT}
         FROM connections
         WHERE id = ?`,
      )
      .get(id) as ConnectionRow | undefined;
  }

  function findRowByNameOrId(connection: string): ConnectionRow | undefined {
    const byId = getRow(connection);
    if (byId) {
      return byId;
    }
    return db
      .prepare(
        `SELECT ${CONNECTION_SELECT}
         FROM connections
         WHERE name = ?
         LIMIT 1`,
      )
      .get(connection) as ConnectionRow | undefined;
  }

  function requireRow(id: string): ConnectionRow {
    const row = getRow(id);
    if (!row) {
      throw new Error(`Connection not found: ${id}`);
    }
    return row;
  }

  function poolFor(row: ConnectionRow) {
    const pool = getConnectedPool(row.id);
    if (!pool) {
      throw new Error(
        `Connection "${row.name}" is disconnected. Use Connect or Reconnect.`,
      );
    }
    return pool;
  }

  /** Для agent tools: поднять пул, если ещё не connected. */
  async function ensurePool(row: ConnectionRow) {
    const existing = getConnectedPool(row.id);
    if (existing) {
      return existing;
    }
    const resolved = resolvePassword(row);
    if ("needsPassword" in resolved) {
      throw new Error(
        `Connection "${row.name}" has no stored password. Connect from the SQL panel first.`,
      );
    }
    const result = await connectPool(
      row.id,
      toConfig(row, resolved.password),
      rowAccessMode(row),
    );
    if (!result.ok) {
      throw new Error(result.error);
    }
    const pool = getConnectedPool(row.id);
    if (!pool) {
      throw new Error(`Failed to connect "${row.name}"`);
    }
    publishUi();
    return pool;
  }

  bb.rpc.register(rpcContract, {
    listConnections: () => ({
      connections: listRows().map((row) => ({
        ...toPublic(row),
        connected: isConnected(row.id),
      })),
    }),

    createConnection: (input) => {
      const id = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const sslCaPath = normalizePath(input.sslCaPath);
      const sslCertPath = normalizePath(input.sslCertPath);
      const sslKeyPath = normalizePath(input.sslKeyPath);
      const accessMode = input.accessMode ?? "readwrite";
      const agentWrite = input.agentWrite ?? false;
      const allowDdl = input.allowDdl ?? false;
      db.prepare(
        `INSERT INTO connections
         (id, name, host, port, database, "user", password, ssl,
          ssl_ca_path, ssl_cert_path, ssl_key_path, access_mode, agent_write, allow_ddl, created_at)
         VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.name,
        input.host,
        input.port,
        input.database,
        input.user,
        input.ssl ? 1 : 0,
        sslCaPath,
        sslCertPath,
        sslKeyPath,
        accessMode,
        agentWrite ? 1 : 0,
        allowDdl ? 1 : 0,
        createdAt,
      );
      setConnectionPassword(pluginDataDir, id, input.password);
      const order = getConnectionOrder();
      if (!order.includes(id)) {
        setConnectionOrder([...order, id]);
      }
      publishUi();
      return { connection: toPublic(requireRow(id)) };
    },

    updateConnection: async (input) => {
      requireRow(input.id);
      const sslCaPath = normalizePath(input.sslCaPath);
      const sslCertPath = normalizePath(input.sslCertPath);
      const sslKeyPath = normalizePath(input.sslKeyPath);
      db.prepare(
        `UPDATE connections
         SET name = ?, host = ?, port = ?, database = ?, "user" = ?, password = '',
             ssl = ?, ssl_ca_path = ?, ssl_cert_path = ?, ssl_key_path = ?,
             access_mode = ?, agent_write = ?, allow_ddl = ?
         WHERE id = ?`,
      ).run(
        input.name,
        input.host,
        input.port,
        input.database,
        input.user,
        input.ssl ? 1 : 0,
        sslCaPath,
        sslCertPath,
        sslKeyPath,
        input.accessMode,
        input.agentWrite ? 1 : 0,
        input.allowDdl ? 1 : 0,
        input.id,
      );
      if (input.password !== undefined) {
        setConnectionPassword(pluginDataDir, input.id, input.password);
      }
      await dropPool(input.id);
      publishUi();
      return { connection: toPublic(requireRow(input.id)) };
    },

    deleteConnection: async ({ id }) => {
      requireRow(id);
      db.prepare(`DELETE FROM connections WHERE id = ?`).run(id);
      deleteConnectionPassword(pluginDataDir, id);
      setConnectionOrder(getConnectionOrder().filter((item) => item !== id));
      await dropPool(id);
      publishUi();
      return { ok: true as const };
    },

    testConnection: async ({ id }) => {
      const row = requireRow(id);
      const resolved = resolvePassword(row);
      if ("needsPassword" in resolved) {
        return {
          ok: false,
          error: "No stored password — edit the connection or Connect with a password",
        };
      }
      const result = await driverTestConnection(toConfig(row, resolved.password));
      if (result.ok) {
        return { ok: true };
      }
      return { ok: false, error: result.error };
    },

    getConnectionStatus: ({ id }) => {
      requireRow(id);
      return { connected: isConnected(id) };
    },

    connectConnection: async ({ id, password }) => {
      const row = requireRow(id);
      const resolved = resolvePassword(row, password);
      if ("needsPassword" in resolved) {
        return { ok: false, needsPassword: true, error: "Password required" };
      }
      const result = await connectPool(
        id,
        toConfig(row, resolved.password),
        rowAccessMode(row),
      );
      publishUi();
      if (result.ok) {
        return { ok: true };
      }
      return { ok: false, error: result.error };
    },

    disconnectConnection: async ({ id }) => {
      requireRow(id);
      await disconnectPool(id);
      publishUi();
      return { ok: true as const };
    },

    reconnectConnection: async ({ id, password }) => {
      const row = requireRow(id);
      const resolved = resolvePassword(row, password);
      if ("needsPassword" in resolved) {
        return { ok: false, needsPassword: true, error: "Password required" };
      }
      const result = await reconnectPool(
        id,
        toConfig(row, resolved.password),
        rowAccessMode(row),
      );
      publishUi();
      if (result.ok) {
        return { ok: true };
      }
      return { ok: false, error: result.error };
    },

    probeConnection: async (input) => {
      let password = input.password;
      if (password === undefined) {
        if (!input.id) {
          return { ok: false, error: "Password is required to probe a new connection" };
        }
        const resolved = resolvePassword(requireRow(input.id));
        if ("needsPassword" in resolved) {
          return { ok: false, error: "No stored password for this connection" };
        }
        password = resolved.password;
      }
      const result = await driverTestConnection({
        host: input.host,
        port: input.port,
        database: input.database,
        user: input.user,
        password,
        ssl:
          buildSslConfig({
            ssl: input.ssl,
            sslCaPath: input.sslCaPath,
            sslCertPath: input.sslCertPath,
            sslKeyPath: input.sslKeyPath,
          }) ?? false,
      });
      if (result.ok) {
        return { ok: true };
      }
      return { ok: false, error: result.error };
    },

    listSchemas: async ({ connectionId }) => {
      const row = requireRow(connectionId);
      const schemas = await driverListSchemas(poolFor(row));
      return { schemas };
    },

    listTables: async ({ connectionId, schema }) => {
      const row = requireRow(connectionId);
      const tables = await driverListTables(poolFor(row), schema);
      return { tables };
    },

    listColumns: async ({ connectionId, schema, table }) => {
      const row = requireRow(connectionId);
      const columns = await driverListColumns(poolFor(row), schema, table);
      return { columns };
    },

    describeTable: async ({ connectionId, schema, table }) => {
      const row = requireRow(connectionId);
      return driverDescribeTable(poolFor(row), schema, table);
    },

    assessQuery: ({ connectionId, sql }) => {
      const row = requireRow(connectionId);
      return assessSqlStatement(sql, {
        accessMode: rowAccessMode(row),
        fromAgent: false,
        agentWriteEnabled: rowAgentWrite(row),
        allowDdl: rowAllowDdl(row),
      });
    },

    runQuery: async ({ connectionId, sql, limit, confirmed, confirmedTable }) => {
      const row = requireRow(connectionId);
      const accessMode = rowAccessMode(row);
      const assessment = assessSqlStatement(sql, {
        accessMode,
        fromAgent: false,
        agentWriteEnabled: rowAgentWrite(row),
        allowDdl: rowAllowDdl(row),
      });
      if (!assessment.allowed) {
        throw new Error(assessment.blockReason ?? "Statement is not allowed");
      }
      if (assessment.requiresConfirm) {
        if (!confirmed) {
          throw new Error(
            assessment.summary + " — confirm in the UI before running.",
          );
        }
        if (
          assessment.confirmLevel === "type_table" &&
          !tablesMatch(assessment.targetTable, confirmedTable)
        ) {
          throw new Error(
            `Type the table name (${assessment.targetTable ?? "?"}) to confirm.`,
          );
        }
      }
      const transactionMode =
        accessMode === "readonly" || !sqlNeedsWriteTransaction(sql, assessment.kind)
          ? "readonly"
          : "readwrite";
      return driverRunQuery(poolFor(row), sql, {
        limitRows: limit,
        transactionMode,
      });
    },

    getUiState: () => ({
      activeConnectionId: getPref("activeConnectionId"),
      draftSql: getPref("draftSql"),
      draftAutoRun: getPref("draftAutoRun") === "1",
      connectionSortMode: getSortMode(),
    }),

    setActiveConnection: ({ id }) => {
      setPref("activeConnectionId", id);
      publishUi();
      return { ok: true as const };
    },

    setConnectionSortMode: ({ mode }) => {
      if (mode === "free") {
        const rows = db
          .prepare(
            `SELECT ${CONNECTION_SELECT}
             FROM connections
             ORDER BY created_at ASC`,
          )
          .all() as ConnectionRow[];
        const sorted = [...rows].sort((left, right) =>
          compareNames(left.name, right.name),
        );
        ensureFreeOrderSeed(sorted);
      }
      setPref("connectionSortMode", mode);
      publishUi();
      return { ok: true as const, mode };
    },

    reorderConnections: ({ ids }) => {
      const known = new Set(
        (
          db.prepare(`SELECT id FROM connections`).all() as { id: string }[]
        ).map((row) => row.id),
      );
      const unique: string[] = [];
      for (const id of ids) {
        if (!known.has(id) || unique.includes(id)) {
          continue;
        }
        unique.push(id);
      }
      for (const id of known) {
        if (!unique.includes(id)) {
          unique.push(id);
        }
      }
      setConnectionOrder(unique);
      setPref("connectionSortMode", "free");
      publishUi();
      return { ok: true as const };
    },

    setDraftSql: ({ sql, autoRun }) => {
      setPref("draftSql", sql.length > 0 ? sql : null);
      setPref("draftAutoRun", autoRun ? "1" : null);
      publishUi();
      return { ok: true as const };
    },

    consumeDraftSql: () => {
      const sql = getPref("draftSql");
      const autoRun = getPref("draftAutoRun") === "1";
      setPref("draftSql", null);
      setPref("draftAutoRun", null);
      if (sql !== null) {
        publishUi();
      }
      return { sql, autoRun };
    },

    listHistory: (input) => {
      const limit = input.limit ?? 50;
      const items = db
        .prepare(
          `SELECT id, connection_id AS connectionId, connection_name AS connectionName,
                  sql, created_at AS createdAt
           FROM query_history
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(limit) as Array<{
        id: string;
        connectionId: string;
        connectionName: string;
        sql: string;
        createdAt: string;
      }>;
      return { items };
    },

    recordHistory: ({ connectionId, sql }) => {
      const row = requireRow(connectionId);
      const id = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      db.prepare(
        `INSERT INTO query_history (id, connection_id, connection_name, sql, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(id, connectionId, row.name, sql, createdAt);
      const overflow = db
        .prepare(
          `SELECT id FROM query_history ORDER BY created_at DESC LIMIT -1 OFFSET 200`,
        )
        .all() as Array<{ id: string }>;
      if (overflow.length > 0) {
        const del = db.prepare(`DELETE FROM query_history WHERE id = ?`);
        for (const item of overflow) {
          del.run(item.id);
        }
      }
      publishUi();
      return { ok: true as const };
    },

    clearHistory: () => {
      db.prepare(`DELETE FROM query_history`).run();
      publishUi();
      return { ok: true as const };
    },

    listBookmarks: () => {
      const rows = db
        .prepare(
          `SELECT id, title, sql, connection_id, created_at
           FROM bookmarks
           ORDER BY created_at DESC`,
        )
        .all() as {
        id: string;
        title: string;
        sql: string;
        connection_id: string | null;
        created_at: string;
      }[];
      return {
        items: rows.map((row) => ({
          id: row.id,
          title: row.title,
          sql: row.sql,
          connectionId: row.connection_id,
          createdAt: row.created_at,
        })),
      };
    },

    addBookmark: (input) => {
      const id = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const connectionId = input.connectionId ?? null;
      db.prepare(
        `INSERT INTO bookmarks (id, title, sql, connection_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(id, input.title, input.sql, connectionId, createdAt);
      publishUi();
      return {
        item: {
          id,
          title: input.title,
          sql: input.sql,
          connectionId,
          createdAt,
        },
      };
    },

    deleteBookmark: ({ id }) => {
      db.prepare(`DELETE FROM bookmarks WHERE id = ?`).run(id);
      publishUi();
      return { ok: true as const };
    },

    readSqlFile: async ({ path, kind, threadId }) => {
      let content: string;
      if (kind === "host") {
        const file = await bb.sdk.files.read({ path });
        if (file.contentEncoding !== "utf8") {
          throw new Error("SQL file is not UTF-8 text");
        }
        content = file.content;
      } else if (kind === "workspace") {
        if (!threadId) {
          throw new Error("Workspace .sql files need an open thread context");
        }
        const thread = await bb.sdk.threads.get({
          threadId,
          include: "environment",
        });
        if (!("environment" in thread) || !thread.environment) {
          throw new Error("Thread has no live environment for workspace files");
        }
        const environment = thread.environment;
        const rootPath = environment.path;
        const hostId = environment.hostId;
        if (!rootPath || !hostId) {
          throw new Error("Thread environment is missing path or host");
        }
        const absolutePath = path.startsWith("/")
          ? path
          : `${rootPath.replace(/\/$/, "")}/${path.replace(/^\.\//, "")}`;
        const file = await bb.sdk.files.read({
          hostId,
          rootPath,
          path: absolutePath,
        });
        if (file.contentEncoding !== "utf8") {
          throw new Error("SQL file is not UTF-8 text");
        }
        content = file.content;
      } else {
        throw new Error("thread-storage .sql opener is not supported yet");
      }
      return {
        content,
        connectionHint: parseConnHint(content),
      };
    },
  });

  bb.agents.registerTool({
    name: "sql_list_connections",
    description: "List configured Postgres connection names for sql_query.",
    instructions:
      "Call sql_list_connections before sql_query if you do not know which connection to use.",
    presentation: {
      label: {
        pending: "Listing SQL connections",
        completed: "Listed SQL connections",
      },
    },
    parameters: z.object({}).strict(),
    async execute() {
      const connections = listRows();
      if (connections.length === 0) {
        return "No Postgres connections configured. Add one in the SQL panel.";
      }
      return connections
        .map((row) => {
          const mode = rowAccessMode(row);
          const agent = rowAgentWrite(row) ? "agent-write=on" : "agent-write=off";
          const ddl = rowAllowDdl(row) ? "allow-ddl=on" : "allow-ddl=off";
          return `- ${row.name} (id=${row.id}, ${row.user}@${row.host}:${row.port}/${row.database}, mode=${mode}, ${agent}, ${ddl})`;
        })
        .join("\n");
    },
  });

  bb.agents.registerTool({
    name: "sql_query",
    description:
      "Run a SQL query against a configured Postgres connection (one statement per call). " +
      "DML needs Agent write; DDL also needs Allow DDL. Admin/session statements are never allowed.",
    instructions:
      "Use sql_query against configured Postgres connections. One statement per call. " +
      "Reads always run in BEGIN READ ONLY. DML requires Agent write (default off). " +
      "DDL (CREATE/ALTER/DROP/TRUNCATE/…) requires both Agent write and Allow DDL (both default off). " +
      "UPDATE/DELETE without a selective WHERE are refused. SET/VACUUM/COPY/… are blocked. " +
      "Ask the user to enable the connection flags if they need tool-driven mutations or schema changes.",
    presentation: {
      label: {
        pending: "Running SQL query",
        completed: "Ran SQL query",
      },
    },
    parameters: z
      .object({
        connection: z
          .string()
          .min(1)
          .describe("Connection name or id from sql_list_connections"),
        sql: z.string().min(1).describe("SQL to execute (one statement)"),
        limit: z.number().int().positive().max(5000).optional(),
      })
      .strict(),
    async execute({ connection, sql, limit }) {
      try {
        const row = findRowByNameOrId(connection);
        if (!row) {
          return {
            content: [
              {
                type: "text",
                text: `Unknown connection "${connection}". Call sql_list_connections.`,
              },
            ],
            isError: true,
          };
        }
        const accessMode = rowAccessMode(row);
        const assessment = assessSqlStatement(sql, {
          accessMode,
          fromAgent: true,
          agentWriteEnabled: rowAgentWrite(row),
          allowDdl: rowAllowDdl(row),
        });
        if (!assessment.allowed) {
          return {
            content: [
              {
                type: "text",
                text: assessment.blockReason ?? "Statement is not allowed",
              },
            ],
            isError: true,
          };
        }
        const transactionMode =
          accessMode === "readonly" ||
          !sqlNeedsWriteTransaction(sql, assessment.kind)
            ? "readonly"
            : "readwrite";
        const result = await driverRunQuery(await ensurePool(row), sql, {
          limitRows: limit,
          transactionMode,
        });
        return formatQueryAsText(result);
      } catch (error) {
        return {
          content: [{ type: "text", text: formatError(error) }],
          isError: true,
        };
      }
    },
  });

  bb.onDispose(() => {
    void closeAllPools();
    bb.log.info("disposed");
  });
}
