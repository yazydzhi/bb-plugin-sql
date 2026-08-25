// bb-plugin-sql — backend: connection CRUD, browse, read-only SQL, agent tools.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
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
import { parseConnHint } from "./lib/parse-conn-hint.js";

const connectionPublicSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    host: z.string(),
    port: z.number().int(),
    database: z.string(),
    user: z.string(),
    ssl: z.boolean(),
    createdAt: z.string(),
  })
  .strict();

const connectionListItemSchema = connectionPublicSchema.extend({
  connected: z.boolean(),
});

const connectionInputSchema = z
  .object({
    name: z.string().min(1),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(5432),
    database: z.string().min(1),
    user: z.string().min(1),
    password: z.string(),
    ssl: z.boolean().default(false),
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
    // Пустой/отсутствующий пароль = оставить прежний.
    password: z.string().optional(),
    ssl: z.boolean(),
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
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z
      .object({
        ok: z.boolean(),
        error: z.string().optional(),
      })
      .strict(),
  },
  disconnectConnection: {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  reconnectConnection: {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z
      .object({
        ok: z.boolean(),
        error: z.string().optional(),
      })
      .strict(),
  },
  /** Проверка параметров до сохранения (или с id — подставить пароль из хранилища). */
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
      })
      .strict(),
    output: queryResultSchema,
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
  password: string;
  ssl: number;
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
  createdAt: string;
};

function toPublic(row: ConnectionRow): PublicConnection {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    database: row.database,
    user: row.user,
    ssl: row.ssl === 1,
    createdAt: row.created_at,
  };
}

function toConfig(row: ConnectionRow): PostgresConfig {
  return {
    host: row.host,
    port: row.port,
    database: row.database,
    user: row.user,
    password: row.password,
    ssl: row.ssl === 1,
  };
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
  ]);

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
        `SELECT id, name, host, port, database, "user", password, ssl, created_at
         FROM connections
         ORDER BY created_at ASC`,
      )
      .all() as ConnectionRow[];
    return sortConnectionRows(rows);
  }

  function getRow(id: string): ConnectionRow | undefined {
    return db
      .prepare(
        `SELECT id, name, host, port, database, "user", password, ssl, created_at
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
        `SELECT id, name, host, port, database, "user", password, ssl, created_at
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
    const result = await connectPool(row.id, toConfig(row));
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
      db.prepare(
        `INSERT INTO connections
         (id, name, host, port, database, "user", password, ssl, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.name,
        input.host,
        input.port,
        input.database,
        input.user,
        input.password,
        input.ssl ? 1 : 0,
        createdAt,
      );
      const order = getConnectionOrder();
      if (!order.includes(id)) {
        setConnectionOrder([...order, id]);
      }
      publishUi();
      return { connection: toPublic(requireRow(id)) };
    },

    updateConnection: async (input) => {
      const existing = requireRow(input.id);
      const password =
        input.password !== undefined && input.password.length > 0
          ? input.password
          : existing.password;
      db.prepare(
        `UPDATE connections
         SET name = ?, host = ?, port = ?, database = ?, "user" = ?, password = ?, ssl = ?
         WHERE id = ?`,
      ).run(
        input.name,
        input.host,
        input.port,
        input.database,
        input.user,
        password,
        input.ssl ? 1 : 0,
        input.id,
      );
      await dropPool(input.id);
      return { connection: toPublic(requireRow(input.id)) };
    },

    deleteConnection: async ({ id }) => {
      requireRow(id);
      db.prepare(`DELETE FROM connections WHERE id = ?`).run(id);
      setConnectionOrder(getConnectionOrder().filter((item) => item !== id));
      await dropPool(id);
      publishUi();
      return { ok: true as const };
    },

    testConnection: async ({ id }) => {
      const row = requireRow(id);
      const result = await driverTestConnection(toConfig(row));
      if (result.ok) {
        return { ok: true };
      }
      return { ok: false, error: result.error };
    },

    getConnectionStatus: ({ id }) => {
      requireRow(id);
      return { connected: isConnected(id) };
    },

    connectConnection: async ({ id }) => {
      const row = requireRow(id);
      const result = await connectPool(id, toConfig(row));
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

    reconnectConnection: async ({ id }) => {
      const row = requireRow(id);
      const result = await reconnectPool(id, toConfig(row));
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
        password = requireRow(input.id).password;
      }
      const result = await driverTestConnection({
        host: input.host,
        port: input.port,
        database: input.database,
        user: input.user,
        password,
        ssl: input.ssl,
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

    runQuery: async ({ connectionId, sql, limit }) => {
      const row = requireRow(connectionId);
      return driverRunQuery(poolFor(row), sql, { limitRows: limit });
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
            `SELECT id, name, host, port, database, "user", password, ssl, created_at
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
    experimental_statusLabels: {
      pending: "Listing SQL connections",
      completed: "Listed SQL connections",
    },
    parameters: z.object({}).strict(),
    async execute() {
      const connections = listRows();
      if (connections.length === 0) {
        return "No Postgres connections configured. Add one in the SQL panel.";
      }
      return connections
        .map(
          (row) =>
            `- ${row.name} (id=${row.id}, ${row.user}@${row.host}:${row.port}/${row.database})`,
        )
        .join("\n");
    },
  });

  bb.agents.registerTool({
    name: "sql_query",
    description:
      "Run a read-only SQL query against a configured Postgres connection.",
    instructions:
      "Use sql_query for read-only lookups against configured Postgres connections; " +
      "it is SELECT-only, writes are rejected by the database.",
    experimental_statusLabels: {
      pending: "Running SQL query",
      completed: "Ran SQL query",
    },
    parameters: z
      .object({
        connection: z
          .string()
          .min(1)
          .describe("Connection name or id from sql_list_connections"),
        sql: z.string().min(1).describe("Read-only SQL to execute"),
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
        const result = await driverRunQuery(await ensurePool(row), sql, {
          limitRows: limit,
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
