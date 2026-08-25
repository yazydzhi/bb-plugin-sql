// bb-plugin-sql — backend: connection CRUD, browse, read-only SQL, agent tools.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  closeAllPools,
  dropPool,
  formatError,
  formatQueryAsText,
  getPool,
  listColumns as driverListColumns,
  listSchemas as driverListSchemas,
  listTables as driverListTables,
  runQuery as driverRunQuery,
  testConnection as driverTestConnection,
  type PostgresConfig,
} from "./driver-postgres.js";

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
    output: z.object({ connections: z.array(connectionPublicSchema) }).strict(),
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
  ]);

  function listRows(): ConnectionRow[] {
    return db
      .prepare(
        `SELECT id, name, host, port, database, "user", password, ssl, created_at
         FROM connections
         ORDER BY created_at ASC`,
      )
      .all() as ConnectionRow[];
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
    return getPool(row.id, toConfig(row));
  }

  bb.rpc.register(rpcContract, {
    listConnections: () => ({
      connections: listRows().map(toPublic),
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
      await dropPool(id);
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

    runQuery: async ({ connectionId, sql, limit }) => {
      const row = requireRow(connectionId);
      return driverRunQuery(poolFor(row), sql, { limitRows: limit });
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
        const result = await driverRunQuery(poolFor(row), sql, {
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
