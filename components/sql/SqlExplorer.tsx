import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../../server";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useOfflineStatusFade } from "@/hooks/use-offline-status-fade";
import { ConnectionFormDialog } from "./ConnectionFormDialog";
import { connectOrReconnectWithPasswordPrompt } from "./connect-helpers";
import { StatusDot } from "./Status";
import { buildInsertTemplate } from "@/lib/insert-template";
import {
  emptyForm,
  quoteIdent,
  mergeConnectionStatuses,
  connectionStatusFromMap,
  connectionErrorFromMap,
  makeStatusEntry,
  type ConnectionForm,
  type ConnectionListItem,
  type ConnectionSortMode,
  type ConnectionStatusEntry,
  type ConnStatus,
  type PublicConnection,
} from "./types";

type ColumnDetail = {
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

type ConstraintDetail = {
  name: string;
  type: "PRIMARY KEY" | "FOREIGN KEY" | "UNIQUE" | "CHECK" | "EXCLUDE";
  columns: string[];
  definition: string;
};

type TableDetail = {
  columns: ColumnDetail[];
  constraints: ConstraintDetail[];
};

function tableKey(database: string, schema: string, table: string): string {
  return `${database}.${schema}.${table}`;
}

function schemaExpandKey(database: string, schema: string): string {
  return `${database}\0${schema}`;
}

function detailKey(
  connectionId: string,
  database: string,
  schema: string,
  table: string,
): string {
  return `${connectionId}:${database}.${schema}.${table}`;
}

function connectionStatus(
  statusById: Record<string, ConnectionStatusEntry>,
  connectionId: string,
): ConnStatus {
  return connectionStatusFromMap(statusById, connectionId);
}

function connectionError(
  statusById: Record<string, ConnectionStatusEntry>,
  connectionId: string,
): string | null {
  return connectionErrorFromMap(statusById, connectionId);
}

/** Constraints, которые не сводятся к одной колонке с бейджем. */
function extraConstraints(constraints: ConstraintDetail[]): ConstraintDetail[] {
  return constraints.filter((constraint) => {
    if (constraint.type === "CHECK" || constraint.type === "EXCLUDE") {
      return true;
    }
    return constraint.columns.length > 1;
  });
}

/**
 * Левая панель: connections + schema tree.
 * Shared active connection пишется в ui_prefs и уходит в query panel через realtime.
 */
export function SqlExplorer() {
  const rpc = useRpc<typeof rpcContract>();
  const [connections, setConnections] = useState<ConnectionListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statusById, setStatusById] = useState<
    Record<string, ConnectionStatusEntry>
  >({});
  const [databasesById, setDatabasesById] = useState<Record<string, string[]>>(
    {},
  );
  /** schemas: connectionId → database → schema[] */
  const [schemasByDb, setSchemasByDb] = useState<
    Record<string, Record<string, string[]>>
  >({});
  /** tables: connectionId → "db\0schema" → tables */
  const [tablesBySchema, setTablesBySchema] = useState<
    Record<string, Record<string, { name: string; type: string }[]>>
  >({});
  const [expandedDatabasesById, setExpandedDatabasesById] = useState<
    Record<string, string[]>
  >({});
  const [expandedSchemasById, setExpandedSchemasById] = useState<
    Record<string, string[]>
  >({});
  const [expandedTablesById, setExpandedTablesById] = useState<
    Record<string, string[]>
  >({});
  const [tableDetailsById, setTableDetailsById] = useState<
    Record<string, TableDetail>
  >({});
  const [loadingTreeById, setLoadingTreeById] = useState<
    Record<string, boolean>
  >({});
  const [loadingTables, setLoadingTables] = useState<Set<string>>(new Set());
  const [activeDatabase, setActiveDatabase] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PublicConnection | null>(null);
  const [form, setForm] = useState<ConnectionForm>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [describeOpen, setDescribeOpen] = useState(false);
  const [describeTitle, setDescribeTitle] = useState("");
  const [describeDetail, setDescribeDetail] = useState<TableDetail | null>(null);
  const [describeLoading, setDescribeLoading] = useState(false);
  const [sortMode, setSortMode] = useState<ConnectionSortMode>("asc");
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dragIdRef = useRef<string | null>(null);

  const selectedStatus = selectedId
    ? connectionStatus(statusById, selectedId)
    : "idle";
  const selectedError = selectedId
    ? connectionError(statusById, selectedId)
    : null;
  const selectedConnection =
    selectedId != null
      ? (connections.find((item) => item.id === selectedId) ?? null)
      : null;
  const showAllDatabases = selectedConnection?.showAllDatabases ?? true;
  const selectedDatabases = selectedId ? (databasesById[selectedId] ?? []) : [];
  const selectedSchemasByDb = selectedId ? (schemasByDb[selectedId] ?? {}) : {};
  const selectedTablesBySchema = selectedId
    ? (tablesBySchema[selectedId] ?? {})
    : {};
  const selectedExpandedDatabases = new Set(
    selectedId ? (expandedDatabasesById[selectedId] ?? []) : [],
  );
  const selectedExpandedSchemas = new Set(
    selectedId ? (expandedSchemasById[selectedId] ?? []) : [],
  );
  const selectedExpandedTables = new Set(
    selectedId ? (expandedTablesById[selectedId] ?? []) : [],
  );
  const loadingSelectedTree = selectedId
    ? (loadingTreeById[selectedId] ?? false)
    : false;

  const patchConnectionStatus = useCallback(
    (connectionId: string, status: ConnStatus, error: string | null = null) => {
      setStatusById((current) => ({
        ...current,
        [connectionId]: makeStatusEntry(status, error),
      }));
    },
    [],
  );

  useOfflineStatusFade(statusById, setStatusById);

  const clearTreeCache = useCallback((connectionId: string) => {
    setDatabasesById((current) => {
      const next = { ...current };
      delete next[connectionId];
      return next;
    });
    setSchemasByDb((current) => {
      const next = { ...current };
      delete next[connectionId];
      return next;
    });
    setTablesBySchema((current) => {
      const next = { ...current };
      delete next[connectionId];
      return next;
    });
    setExpandedDatabasesById((current) => {
      const next = { ...current };
      delete next[connectionId];
      return next;
    });
    setExpandedSchemasById((current) => {
      const next = { ...current };
      delete next[connectionId];
      return next;
    });
    setExpandedTablesById((current) => {
      const next = { ...current };
      delete next[connectionId];
      return next;
    });
    setTableDetailsById((current) => {
      const prefix = `${connectionId}:`;
      const next: Record<string, TableDetail> = {};
      for (const [key, value] of Object.entries(current)) {
        if (!key.startsWith(prefix)) {
          next[key] = value;
        }
      }
      return next;
    });
    setLoadingTables((current) => {
      const prefix = `${connectionId}:`;
      const next = new Set<string>();
      for (const key of current) {
        if (!key.startsWith(prefix)) {
          next.add(key);
        }
      }
      return next;
    });
  }, []);

  const refreshConnections = useCallback(async () => {
    const { connections: next } = await rpc.call("listConnections");
    setConnections(next);
    setStatusById((current) => mergeConnectionStatuses(current, next));
    const ui = await rpc.call("getUiState");
    setSortMode(ui.connectionSortMode);
    setActiveDatabase(ui.activeDatabase);
    setSelectedId((current) => {
      const preferred = ui.activeConnectionId;
      if (preferred && next.some((item) => item.id === preferred)) {
        return preferred;
      }
      if (current && next.some((item) => item.id === current)) {
        return current;
      }
      return next[0]?.id ?? null;
    });
  }, [rpc]);

  useEffect(() => {
    void refreshConnections().catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : String(error));
    });
  }, [refreshConnections]);

  useRealtime("sql:ui", () => {
    void refreshConnections().catch(() => {
      // ignore transient sync errors
    });
  });

  const selectConnection = useCallback(
    async (id: string) => {
      setSelectedId(id);
      try {
        await rpc.call("setActiveConnection", { id });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    },
    [rpc],
  );

  async function changeSortMode(mode: ConnectionSortMode) {
    try {
      const result = await rpc.call("setConnectionSortMode", { mode });
      setSortMode(result.mode);
      await refreshConnections();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  function moveConnection(fromId: string, toId: string) {
    if (fromId === toId) {
      return;
    }
    const fromIndex = connections.findIndex((item) => item.id === fromId);
    const toIndex = connections.findIndex((item) => item.id === toId);
    if (fromIndex < 0 || toIndex < 0) {
      return;
    }
    const next = [...connections];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    setConnections(next);
    setSortMode("free");
    void rpc
      .call("reorderConnections", { ids: next.map((item) => item.id) })
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : String(error));
        void refreshConnections();
      });
  }

  useEffect(() => {
    if (!selectedId) {
      return;
    }
    let cancelled = false;
    patchConnectionStatus(selectedId, "checking");
    void (async () => {
      try {
        const { connected } = await rpc.call("getConnectionStatus", {
          id: selectedId,
        });
        if (cancelled) {
          return;
        }
        if (connected) {
          patchConnectionStatus(selectedId, "online");
          return;
        }
        const outcome = await rpc.call("connectConnection", { id: selectedId });
        if (cancelled) {
          return;
        }
        if (outcome.ok) {
          patchConnectionStatus(selectedId, "online");
        } else {
          patchConnectionStatus(
            selectedId,
            "offline",
            outcome.error ?? "Connect failed",
          );
        }
      } catch (error) {
        if (!cancelled) {
          patchConnectionStatus(
            selectedId,
            "offline",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [patchConnectionStatus, rpc, selectedId]);

  useEffect(() => {
    if (!selectedId || selectedStatus !== "online" || !selectedConnection) {
      return;
    }
    if (showAllDatabases) {
      if (databasesById[selectedId]) {
        return;
      }
    } else if (schemasByDb[selectedId]?.[selectedConnection.database]) {
      return;
    }
    let cancelled = false;
    setLoadingTreeById((current) => ({ ...current, [selectedId]: true }));
    void (async () => {
      try {
        if (showAllDatabases) {
          const { databases } = await rpc.call("listDatabases", {
            connectionId: selectedId,
          });
          if (cancelled) {
            return;
          }
          setDatabasesById((current) => ({
            ...current,
            [selectedId]: databases,
          }));
        } else {
          const database = selectedConnection.database;
          const { schemas } = await rpc.call("listSchemas", {
            connectionId: selectedId,
            database,
          });
          if (cancelled) {
            return;
          }
          setSchemasByDb((current) => ({
            ...current,
            [selectedId]: {
              ...(current[selectedId] ?? {}),
              [database]: schemas,
            },
          }));
        }
      } catch (error: unknown) {
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) {
          setLoadingTreeById((current) => ({
            ...current,
            [selectedId]: false,
          }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    rpc,
    databasesById,
    schemasByDb,
    selectedConnection,
    selectedId,
    selectedStatus,
    showAllDatabases,
  ]);

  async function chooseActiveDatabase(database: string) {
    if (!selectedId) {
      return;
    }
    try {
      await rpc.call("setActiveDatabase", {
        connectionId: selectedId,
        database,
      });
      setActiveDatabase(database);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function toggleDatabase(database: string) {
    if (!selectedId) {
      return;
    }
    const expanded = expandedDatabasesById[selectedId] ?? [];
    if (expanded.includes(database)) {
      setExpandedDatabasesById((current) => ({
        ...current,
        [selectedId]: expanded.filter((item) => item !== database),
      }));
      return;
    }
    setExpandedDatabasesById((current) => ({
      ...current,
      [selectedId]: [...expanded, database],
    }));
    void chooseActiveDatabase(database);
    if (selectedSchemasByDb[database]) {
      return;
    }
    try {
      const { schemas } = await rpc.call("listSchemas", {
        connectionId: selectedId,
        database,
      });
      setSchemasByDb((current) => ({
        ...current,
        [selectedId]: {
          ...(current[selectedId] ?? {}),
          [database]: schemas,
        },
      }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function toggleSchema(database: string, schema: string) {
    if (!selectedId) {
      return;
    }
    const key = schemaExpandKey(database, schema);
    const expanded = expandedSchemasById[selectedId] ?? [];
    if (expanded.includes(key)) {
      setExpandedSchemasById((current) => ({
        ...current,
        [selectedId]: expanded.filter((item) => item !== key),
      }));
      return;
    }
    setExpandedSchemasById((current) => ({
      ...current,
      [selectedId]: [...expanded, key],
    }));
    void chooseActiveDatabase(database);
    if (selectedTablesBySchema[key]) {
      return;
    }
    try {
      const { tables } = await rpc.call("listTables", {
        connectionId: selectedId,
        schema,
        database,
      });
      setTablesBySchema((current) => ({
        ...current,
        [selectedId]: {
          ...(current[selectedId] ?? {}),
          [key]: tables,
        },
      }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function pushDraft(sql: string, autoRun: boolean) {
    try {
      await rpc.call("setDraftSql", { sql, autoRun });
      toast.success(autoRun ? "Opening in Query…" : "SQL ready in Query tab");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function loadTableDetail(
    database: string,
    schema: string,
    table: string,
  ): Promise<TableDetail | null> {
    if (!selectedId) {
      return null;
    }
    const key = detailKey(selectedId, database, schema, table);
    const cached = tableDetailsById[key];
    if (cached) {
      return cached;
    }
    setLoadingTables((current) => new Set(current).add(key));
    try {
      const detail = await rpc.call("describeTable", {
        connectionId: selectedId,
        schema,
        table,
        database,
      });
      setTableDetailsById((current) => ({ ...current, [key]: detail }));
      return detail;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setLoadingTables((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }

  async function toggleTable(database: string, schema: string, table: string) {
    if (!selectedId) {
      return;
    }
    const key = tableKey(database, schema, table);
    const expanded = expandedTablesById[selectedId] ?? [];
    if (expanded.includes(key)) {
      setExpandedTablesById((current) => ({
        ...current,
        [selectedId]: expanded.filter((item) => item !== key),
      }));
      return;
    }
    setExpandedTablesById((current) => ({
      ...current,
      [selectedId]: [...expanded, key],
    }));
    void chooseActiveDatabase(database);
    await loadTableDetail(database, schema, table);
  }

  function insertSelect(database: string, schema: string, table: string) {
    void chooseActiveDatabase(database);
    void pushDraft(
      `SELECT * FROM ${quoteIdent(schema)}.${quoteIdent(table)} LIMIT 100`,
      false,
    );
  }

  function showRecords(database: string, schema: string, table: string) {
    void (async () => {
      await chooseActiveDatabase(database);
      await pushDraft(
        `SELECT * FROM ${quoteIdent(schema)}.${quoteIdent(table)} LIMIT 100`,
        true,
      );
    })();
  }

  async function insertInsertTemplate(
    database: string,
    schema: string,
    table: string,
  ) {
    await chooseActiveDatabase(database);
    const detail = await loadTableDetail(database, schema, table);
    if (!detail) {
      return;
    }
    void pushDraft(
      buildInsertTemplate(schema, table, detail.columns),
      false,
    );
  }

  function isViewRelation(type: string): boolean {
    const normalized = type.toUpperCase();
    return normalized === "VIEW" || normalized === "MATERIALIZED VIEW";
  }

  function partitionRelations(
    tables: { name: string; type: string }[],
  ): {
    baseTables: { name: string; type: string }[];
    views: { name: string; type: string }[];
  } {
    const baseTables: { name: string; type: string }[] = [];
    const views: { name: string; type: string }[] = [];
    for (const table of tables) {
      if (isViewRelation(table.type)) {
        views.push(table);
      } else {
        baseTables.push(table);
      }
    }
    return { baseTables, views };
  }

  async function describeTable(
    database: string,
    schema: string,
    table: string,
  ) {
    setDescribeTitle(`${database}.${schema}.${table}`);
    setDescribeOpen(true);
    setDescribeLoading(true);
    setDescribeDetail(null);
    await chooseActiveDatabase(database);
    const detail = await loadTableDetail(database, schema, table);
    if (!detail) {
      setDescribeOpen(false);
      setDescribeLoading(false);
      return;
    }
    setDescribeDetail(detail);
    setDescribeLoading(false);
  }

  function openCreateDialog() {
    setEditing(null);
    setForm(emptyForm());
    setDialogOpen(true);
  }

  function openEditDialog(connection: PublicConnection) {
    setEditing(connection);
    setForm({
      name: connection.name,
      host: connection.host,
      port: String(connection.port),
      database: connection.database,
      user: connection.user,
      password: "",
      ssl: connection.ssl,
      sslCaPath: connection.sslCaPath ?? "",
      sslCertPath: connection.sslCertPath ?? "",
      sslKeyPath: connection.sslKeyPath ?? "",
      accessMode: connection.accessMode ?? "readwrite",
      agentWrite: connection.agentWrite ?? true,
      allowDdl: connection.allowDdl ?? true,
      showAllDatabases: connection.showAllDatabases ?? true,
      uriPaste: "",
    });
    setDialogOpen(true);
  }

  function parseFormPort(): number | null {
    const port = Number(form.port);
    if (!form.name.trim() || !form.host.trim() || !form.database.trim() || !form.user.trim()) {
      toast.error("Name, host, database, and user are required");
      return null;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      toast.error("Port must be an integer 1–65535");
      return null;
    }
    return port;
  }

  function formSslPaths() {
    return {
      sslCaPath: form.ssl ? form.sslCaPath.trim() || null : null,
      sslCertPath: form.ssl ? form.sslCertPath.trim() || null : null,
      sslKeyPath: form.ssl ? form.sslKeyPath.trim() || null : null,
    };
  }

  /**
   * Собирает input для probeConnection без undefined (RPC JSON их не принимает).
   */
  function buildProbeInput(port: number) {
    const input: {
      id?: string;
      host: string;
      port: number;
      database: string;
      user: string;
      password?: string;
      ssl: boolean;
      sslCaPath: string | null;
      sslCertPath: string | null;
      sslKeyPath: string | null;
    } = {
      host: form.host.trim(),
      port,
      database: form.database.trim(),
      user: form.user.trim(),
      ssl: form.ssl,
      ...formSslPaths(),
    };
    if (editing?.id) {
      input.id = editing.id;
    }
    // При edit и пустом поле — не шлём password (подставится из secrets на сервере).
    if (!editing || form.password.length > 0) {
      input.password = form.password;
    }
    return input;
  }

  /** Только проверка полей формы (без сохранения). */
  async function testConnectionForm() {
    const port = parseFormPort();
    if (port === null) {
      return;
    }
    setTesting(true);
    try {
      const probe = await rpc.call("probeConnection", buildProbeInput(port));
      if (probe.ok) {
        toast.success("Connection test OK");
      } else {
        toast.error(probe.error ?? "Connection test failed");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  }

  async function saveConnection() {
    const port = parseFormPort();
    if (port === null) {
      return;
    }
    if (!editing && form.password.length === 0) {
      // Пустой пароль допустим (trust); предупреждаем один раз.
      if (
        !window.confirm(
          "Save with an empty password? (OK for local trust/peer auth)",
        )
      ) {
        return;
      }
    }

    setSaving(true);
    try {
      const sslPaths = formSslPaths();
      const probe = await rpc.call("probeConnection", buildProbeInput(port));
      let savedWithoutLiveTest = false;
      if (!probe.ok) {
        const detail = probe.error ?? "Connection test failed";
        // Флаги Access (Agent write / Allow DDL) должны сохраняться даже если
        // Postgres сейчас недоступен (как local на :5432 без сервера).
        const proceed = window.confirm(
          `${detail}\n\nSave connection settings anyway?`,
        );
        if (!proceed) {
          toast.error(`${detail} — not saved`);
          return;
        }
        savedWithoutLiveTest = true;
      }

      if (editing) {
        const updateInput: {
          id: string;
          name: string;
          host: string;
          port: number;
          database: string;
          user: string;
          password?: string;
          ssl: boolean;
          sslCaPath: string | null;
          sslCertPath: string | null;
          sslKeyPath: string | null;
          accessMode: "readonly" | "readwrite";
          agentWrite: boolean;
          allowDdl: boolean;
          showAllDatabases: boolean;
        } = {
          id: editing.id,
          name: form.name.trim(),
          host: form.host.trim(),
          port,
          database: form.database.trim(),
          user: form.user.trim(),
          ssl: form.ssl,
          accessMode: form.accessMode,
          agentWrite: form.agentWrite,
          allowDdl: form.allowDdl,
          showAllDatabases: form.showAllDatabases,
          ...sslPaths,
        };
        if (form.password.length > 0) {
          updateInput.password = form.password;
        }
        await rpc.call("updateConnection", updateInput);
        toast.success(
          savedWithoutLiveTest
            ? "Connection updated (live test failed)"
            : "Connection tested and updated",
        );
        await selectConnection(editing.id);
      } else {
        const { connection } = await rpc.call("createConnection", {
          name: form.name.trim(),
          host: form.host.trim(),
          port,
          database: form.database.trim(),
          user: form.user.trim(),
          password: form.password,
          ssl: form.ssl,
          accessMode: form.accessMode,
          agentWrite: form.agentWrite,
          allowDdl: form.allowDdl,
          showAllDatabases: form.showAllDatabases,
          ...sslPaths,
        });
        await selectConnection(connection.id);
        toast.success(
          savedWithoutLiveTest
            ? "Connection saved (live test failed)"
            : "Connection tested and saved",
        );
      }
      setDialogOpen(false);
      await refreshConnections();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function duplicateConnection(connection: ConnectionListItem) {
    try {
      const { connection: copy } = await rpc.call("duplicateConnection", {
        id: connection.id,
      });
      toast.success(`Duplicated as “${copy.name}”`);
      await refreshConnections();
      await selectConnection(copy.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function removeConnection(connection: ConnectionListItem) {
    if (!window.confirm(`Delete connection "${connection.name}"?`)) {
      return;
    }
    try {
      await rpc.call("deleteConnection", { id: connection.id });
      if (selectedId === connection.id) {
        await rpc.call("setActiveConnection", { id: null });
      }
      clearTreeCache(connection.id);
      setStatusById((current) => {
        const next = { ...current };
        delete next[connection.id];
        return next;
      });
      toast.success("Connection deleted");
      await refreshConnections();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function testConnection(connection: PublicConnection) {
    try {
      const outcome = await rpc.call("testConnection", { id: connection.id });
      if (outcome.ok) {
        toast.success("Server reachable (test OK)");
      } else {
        toast.error(outcome.error ?? "Connection failed");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function connectConnection(connection: ConnectionListItem) {
    patchConnectionStatus(connection.id, "checking");
    try {
      const outcome = await connectOrReconnectWithPasswordPrompt({
        rpc,
        method: "connectConnection",
        connection,
      });
      if (outcome.ok) {
        patchConnectionStatus(connection.id, "online");
        clearTreeCache(connection.id);
        toast.success("Connected");
        await refreshConnections();
      } else {
        patchConnectionStatus(
          connection.id,
          "offline",
          outcome.error ?? "Connect failed",
        );
        toast.error(outcome.error ?? "Connect failed");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      patchConnectionStatus(connection.id, "offline", message);
      toast.error(message);
    }
  }

  async function disconnectConnection(connection: ConnectionListItem) {
    try {
      await rpc.call("disconnectConnection", { id: connection.id });
      patchConnectionStatus(connection.id, "disconnected");
      clearTreeCache(connection.id);
      toast.success("Disconnected");
      await refreshConnections();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function reconnectConnection(connection: ConnectionListItem) {
    patchConnectionStatus(connection.id, "checking");
    try {
      const outcome = await connectOrReconnectWithPasswordPrompt({
        rpc,
        method: "reconnectConnection",
        connection,
      });
      if (outcome.ok) {
        patchConnectionStatus(connection.id, "online");
        clearTreeCache(connection.id);
        toast.success("Reconnected");
        await refreshConnections();
      } else {
        patchConnectionStatus(
          connection.id,
          "offline",
          outcome.error ?? "Reconnect failed",
        );
        toast.error(outcome.error ?? "Reconnect failed");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      patchConnectionStatus(connection.id, "offline", message);
      toast.error(message);
    }
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden text-sm">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="font-medium">Connections</span>
        <div className="flex items-center gap-1">
          <div className="flex overflow-hidden rounded border border-border">
            {(
              [
                { mode: "asc", label: "A↑", title: "Sort A→Z" },
                { mode: "desc", label: "A↓", title: "Sort Z→A" },
                { mode: "free", label: "⠿", title: "Free order (drag)" },
              ] as const
            ).map((item) => (
              <button
                key={item.mode}
                type="button"
                title={item.title}
                aria-label={item.title}
                aria-pressed={sortMode === item.mode}
                className={
                  sortMode === item.mode
                    ? "bg-state-active px-1.5 py-0.5 text-xs font-medium"
                    : "px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-state-hover"
                }
                onClick={() => void changeSortMode(item.mode)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <Button size="sm" variant="outline" onClick={openCreateDialog}>
            + Add
          </Button>
        </div>
      </div>
      <div className="max-h-48 overflow-auto border-b border-border">
        {connections.length === 0 ? (
          <p className="px-3 py-3 text-muted-foreground">
            No connections yet. Add a Postgres connection to browse schemas.
          </p>
        ) : (
          <ul className="py-1">
            {connections.map((connection) => {
              const isSelected = connection.id === selectedId;
              const rowStatus = connectionStatus(statusById, connection.id);
              const rowError = connectionError(statusById, connection.id);
              const rowOnline =
                rowStatus === "online" || connection.connected;
              const isDragOver =
                sortMode === "free" && dragOverId === connection.id;
              return (
                <li
                  key={connection.id}
                  className={
                    isSelected
                      ? `group flex w-full items-center gap-1 bg-state-active px-2 py-1.5${isDragOver ? " ring-1 ring-inset ring-border" : ""}`
                      : `group flex w-full items-center gap-1 px-2 py-1.5 hover:bg-state-hover${isDragOver ? " ring-1 ring-inset ring-border" : ""}`
                  }
                  onDragOver={(event) => {
                    if (sortMode !== "free") {
                      return;
                    }
                    event.preventDefault();
                    setDragOverId(connection.id);
                  }}
                  onDragLeave={() => {
                    setDragOverId((current) =>
                      current === connection.id ? null : current,
                    );
                  }}
                  onDrop={(event) => {
                    if (sortMode !== "free") {
                      return;
                    }
                    event.preventDefault();
                    const fromId =
                      dragIdRef.current ??
                      event.dataTransfer.getData("text/plain");
                    dragIdRef.current = null;
                    setDragOverId(null);
                    if (fromId) {
                      moveConnection(fromId, connection.id);
                    }
                  }}
                >
                  {sortMode === "free" ? (
                    <button
                      type="button"
                      draggable
                      className="cursor-grab px-0.5 text-muted-foreground active:cursor-grabbing"
                      aria-label={`Drag ${connection.name}`}
                      title="Drag to reorder"
                      onDragStart={(event) => {
                        dragIdRef.current = connection.id;
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", connection.id);
                      }}
                      onDragEnd={() => {
                        dragIdRef.current = null;
                        setDragOverId(null);
                      }}
                    >
                      ⠿
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 px-1 text-left"
                    onClick={() => void selectConnection(connection.id)}
                    title={
                      rowError
                        ? rowError
                        : `${connection.host}:${connection.port}`
                    }
                  >
                    <StatusDot status={rowStatus} />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {connection.name}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {connection.host}:{connection.port}
                    </span>
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 shrink-0 px-0"
                        aria-label={`Actions for ${connection.name}`}
                      >
                        ⋮
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {rowOnline ? (
                        <DropdownMenuItem
                          onSelect={() => void disconnectConnection(connection)}
                        >
                          Disconnect
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem
                          onSelect={() => void connectConnection(connection)}
                        >
                          Connect
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        onSelect={() => void reconnectConnection(connection)}
                      >
                        Reconnect
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => void testConnection(connection)}
                      >
                        Test connection
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={() => openEditDialog(connection)}
                      >
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => void duplicateConnection(connection)}
                      >
                        Duplicate
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={() => void removeConnection(connection)}
                        className="text-destructive focus:text-destructive"
                      >
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
        <div className="mb-1 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {showAllDatabases ? "Databases" : "Schemas"}
          {activeDatabase ? (
            <span className="ml-1 normal-case tracking-normal text-muted-foreground/80">
              · query: {activeDatabase}
            </span>
          ) : null}
        </div>
        {!selectedId || !selectedConnection ? (
          <p className="px-1 text-muted-foreground">Select a connection.</p>
        ) : selectedStatus === "disconnected" ? (
          <p className="px-1 text-muted-foreground">
            Disconnected. Use ⋮ → Connect.
          </p>
        ) : selectedStatus === "checking" || loadingSelectedTree ? (
          <p className="px-1 text-muted-foreground">Loading…</p>
        ) : selectedStatus === "offline" ? (
          <p className="px-1 text-muted-foreground">
            Offline{selectedError ? `: ${selectedError}` : ""}. Use ⋮ → Connect
            / Reconnect.
          </p>
        ) : showAllDatabases && selectedDatabases.length === 0 ? (
          <p className="px-1 text-muted-foreground">No databases.</p>
        ) : !showAllDatabases &&
          (selectedSchemasByDb[selectedConnection.database] ?? []).length ===
            0 ? (
          <p className="px-1 text-muted-foreground">No schemas.</p>
        ) : (
          <ul className="space-y-0.5">
            {(showAllDatabases
              ? selectedDatabases
              : [selectedConnection.database]
            ).map((database) => {
              const dbOpen = showAllDatabases
                ? selectedExpandedDatabases.has(database)
                : true;
              const schemas = selectedSchemasByDb[database];
              const isDefaultDb = database === selectedConnection.database;
              const isActiveDb = database === activeDatabase;
              return (
                <li key={database}>
                  {showAllDatabases ? (
                    <button
                      type="button"
                      className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-state-hover"
                      onClick={() => void toggleDatabase(database)}
                    >
                      <span className="w-3 shrink-0 text-muted-foreground">
                        {dbOpen ? "▾" : "▸"}
                      </span>
                      <span className="truncate font-medium">{database}</span>
                      {isDefaultDb ? (
                        <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                          conn
                        </span>
                      ) : null}
                      {isActiveDb ? (
                        <span className="shrink-0 text-[10px] uppercase tracking-wide text-emerald-600">
                          active
                        </span>
                      ) : null}
                    </button>
                  ) : null}
                  {dbOpen ? (
                    <ul
                      className={
                        showAllDatabases
                          ? "ml-4 border-l border-border pl-2"
                          : "space-y-0.5"
                      }
                    >
                      {!schemas ? (
                        <li className="py-0.5 text-muted-foreground">
                          {showAllDatabases ? "Loading…" : "No schemas."}
                        </li>
                      ) : schemas.length === 0 ? (
                        <li className="py-0.5 text-muted-foreground">
                          No schemas
                        </li>
                      ) : (
                        schemas.map((schema) => {
                          const schemaKey = schemaExpandKey(database, schema);
                          const open = selectedExpandedSchemas.has(schemaKey);
                          const tables = selectedTablesBySchema[schemaKey];
                          return (
                            <li key={schemaKey}>
                              <button
                                type="button"
                                className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-state-hover"
                                onClick={() =>
                                  void toggleSchema(database, schema)
                                }
                              >
                                <span className="w-3 shrink-0 text-muted-foreground">
                                  {open ? "▾" : "▸"}
                                </span>
                                <span className="truncate">{schema}</span>
                              </button>
                              {open ? (
                                <ul className="ml-4 border-l border-border pl-2">
                                  {!tables ? (
                                    <li className="py-0.5 text-muted-foreground">
                                      Loading…
                                    </li>
                                  ) : tables.length === 0 ? (
                                    <li className="py-0.5 text-muted-foreground">
                                      Empty
                                    </li>
                                  ) : (
                                    (() => {
                                      const { baseTables, views } =
                                        partitionRelations(tables);
                                      const renderRelation = (table: {
                                        name: string;
                                        type: string;
                                      }) => {
                                        const key = tableKey(
                                          database,
                                          schema,
                                          table.name,
                                        );
                                        const detailKeyForRow = selectedId
                                          ? detailKey(
                                              selectedId,
                                              database,
                                              schema,
                                              table.name,
                                            )
                                          : key;
                                        const tableOpen =
                                          selectedExpandedTables.has(key);
                                        const detail =
                                          tableDetailsById[detailKeyForRow];
                                        const loadingDetail =
                                          loadingTables.has(detailKeyForRow);
                                        const extras = detail
                                          ? extraConstraints(detail.constraints)
                                          : [];
                                        const view = isViewRelation(table.type);
                                        return (
                                          <li key={key}>
                                            <div className="group flex items-center gap-0.5">
                                              <button
                                                type="button"
                                                className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-state-hover"
                                                title={`${table.type}: ${database}.${schema}.${table.name}`}
                                                onClick={() =>
                                                  void toggleTable(
                                                    database,
                                                    schema,
                                                    table.name,
                                                  )
                                                }
                                              >
                                                <span className="w-3 shrink-0 text-muted-foreground">
                                                  {tableOpen ? "▾" : "▸"}
                                                </span>
                                                <span className="truncate">
                                                  {table.name}
                                                </span>
                                                {view ? (
                                                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                                                    view
                                                  </span>
                                                ) : null}
                                              </button>
                                              <DropdownMenu>
                                                <DropdownMenuTrigger asChild>
                                                  <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    className="h-6 w-6 shrink-0 px-0 opacity-0 group-hover:opacity-100"
                                                    aria-label={`Actions for ${table.name}`}
                                                  >
                                                    ⋮
                                                  </Button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent align="end">
                                                  <DropdownMenuItem
                                                    onSelect={() =>
                                                      insertSelect(
                                                        database,
                                                        schema,
                                                        table.name,
                                                      )
                                                    }
                                                  >
                                                    Insert SELECT
                                                  </DropdownMenuItem>
                                                  <DropdownMenuItem
                                                    onSelect={() =>
                                                      showRecords(
                                                        database,
                                                        schema,
                                                        table.name,
                                                      )
                                                    }
                                                  >
                                                    Show records
                                                  </DropdownMenuItem>
                                                  {!view ? (
                                                    <DropdownMenuItem
                                                      onSelect={() =>
                                                        void insertInsertTemplate(
                                                          database,
                                                          schema,
                                                          table.name,
                                                        )
                                                      }
                                                    >
                                                      Generate INSERT
                                                    </DropdownMenuItem>
                                                  ) : null}
                                                  <DropdownMenuItem
                                                    onSelect={() =>
                                                      void describeTable(
                                                        database,
                                                        schema,
                                                        table.name,
                                                      )
                                                    }
                                                  >
                                                    Describe
                                                  </DropdownMenuItem>
                                                </DropdownMenuContent>
                                              </DropdownMenu>
                                            </div>
                                            {tableOpen ? (
                                              <ul className="ml-4 border-l border-border pl-2 py-0.5">
                                                {loadingDetail && !detail ? (
                                                  <li className="px-1 py-0.5 text-muted-foreground">
                                                    Loading…
                                                  </li>
                                                ) : !detail ||
                                                  detail.columns.length ===
                                                    0 ? (
                                                  <li className="px-1 py-0.5 text-muted-foreground">
                                                    No columns
                                                  </li>
                                                ) : (
                                                  <>
                                                    {detail.columns.map(
                                                      (column) => {
                                                        const fk =
                                                          column.foreignKey;
                                                        const marks: string[] =
                                                          [];
                                                        if (
                                                          column.isPrimaryKey
                                                        ) {
                                                          marks.push("PK");
                                                        }
                                                        if (column.isUnique) {
                                                          marks.push("UQ");
                                                        }
                                                        if (
                                                          !column.isNullable
                                                        ) {
                                                          marks.push("NN");
                                                        }
                                                        const fkLabel = fk
                                                          ? `${fk.schema === schema ? "" : `${fk.schema}.`}${fk.table}.${fk.column}`
                                                          : null;
                                                        return (
                                                          <li
                                                            key={column.name}
                                                            className="flex items-baseline gap-1.5 px-1 py-0.5 font-mono text-[11px] leading-snug"
                                                            title={[
                                                              column.dataType,
                                                              column.isNullable
                                                                ? "nullable"
                                                                : "not null",
                                                              column.defaultValue
                                                                ? `default ${column.defaultValue}`
                                                                : null,
                                                              fk
                                                                ? `FK ${fk.constraintName} → ${fkLabel}`
                                                                : null,
                                                            ]
                                                              .filter(Boolean)
                                                              .join(" · ")}
                                                          >
                                                            <span className="min-w-0 truncate text-foreground">
                                                              {column.name}
                                                            </span>
                                                            <span className="shrink-0 truncate text-muted-foreground">
                                                              {column.dataType}
                                                            </span>
                                                            {marks.length >
                                                            0 ? (
                                                              <span className="shrink-0 text-muted-foreground">
                                                                {marks.join(
                                                                  " ",
                                                                )}
                                                              </span>
                                                            ) : null}
                                                            {fkLabel ? (
                                                              <span className="min-w-0 truncate text-muted-foreground">
                                                                → {fkLabel}
                                                              </span>
                                                            ) : null}
                                                          </li>
                                                        );
                                                      },
                                                    )}
                                                    {extras.length > 0 ? (
                                                      <li className="mt-1 space-y-0.5 border-t border-border/60 pt-1">
                                                        {extras.map(
                                                          (constraint) => (
                                                            <div
                                                              key={
                                                                constraint.name
                                                              }
                                                              className="px-1 font-mono text-[11px] leading-snug text-muted-foreground"
                                                              title={`${constraint.name}: ${constraint.definition}`}
                                                            >
                                                              <span className="text-foreground/80">
                                                                {constraint.type ===
                                                                "PRIMARY KEY"
                                                                  ? "PK"
                                                                  : constraint.type ===
                                                                      "FOREIGN KEY"
                                                                    ? "FK"
                                                                    : constraint.type ===
                                                                        "UNIQUE"
                                                                      ? "UQ"
                                                                      : constraint.type}
                                                              </span>{" "}
                                                              <span className="truncate">
                                                                {constraint
                                                                  .columns
                                                                  .length > 0
                                                                  ? `(${constraint.columns.join(", ")})`
                                                                  : constraint.definition}
                                                              </span>
                                                            </div>
                                                          ),
                                                        )}
                                                      </li>
                                                    ) : null}
                                                  </>
                                                )}
                                              </ul>
                                            ) : null}
                                          </li>
                                        );
                                      };

                                      return (
                                        <>
                                          {baseTables.length > 0 ? (
                                            <>
                                              <li className="px-1 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                                Tables
                                              </li>
                                              {baseTables.map(renderRelation)}
                                            </>
                                          ) : null}
                                          {views.length > 0 ? (
                                            <>
                                              <li className="px-1 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                                Views
                                              </li>
                                              {views.map(renderRelation)}
                                            </>
                                          ) : null}
                                        </>
                                      );
                                    })()
                                  )}
                                </ul>
                              ) : null}
                            </li>
                          );
                        })
                      )}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ConnectionFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        form={form}
        setForm={setForm}
        saving={saving}
        testing={testing}
        onTest={() => void testConnectionForm()}
        onSave={() => void saveConnection()}
      />

      <Dialog open={describeOpen} onOpenChange={setDescribeOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Describe {describeTitle}</DialogTitle>
          </DialogHeader>
          <div className="max-h-96 space-y-3 overflow-auto">
            {describeLoading ? (
              <p className="text-muted-foreground">Loading…</p>
            ) : !describeDetail || describeDetail.columns.length === 0 ? (
              <p className="text-muted-foreground">No columns.</p>
            ) : (
              <>
                <table className="w-full border-collapse text-left font-mono text-xs">
                  <thead>
                    <tr>
                      <th className="border-b border-border px-2 py-1">Column</th>
                      <th className="border-b border-border px-2 py-1">Type</th>
                      <th className="border-b border-border px-2 py-1">Null</th>
                      <th className="border-b border-border px-2 py-1">Keys</th>
                    </tr>
                  </thead>
                  <tbody>
                    {describeDetail.columns.map((column) => {
                      const keys: string[] = [];
                      if (column.isPrimaryKey) {
                        keys.push("PK");
                      }
                      if (column.isUnique) {
                        keys.push("UQ");
                      }
                      if (column.foreignKey) {
                        const fk = column.foreignKey;
                        keys.push(`FK→${fk.table}.${fk.column}`);
                      }
                      return (
                        <tr key={column.name}>
                          <td className="border-b border-border/60 px-2 py-1">
                            {column.name}
                          </td>
                          <td className="border-b border-border/60 px-2 py-1">
                            {column.dataType}
                          </td>
                          <td className="border-b border-border/60 px-2 py-1">
                            {column.isNullable ? "YES" : "NO"}
                          </td>
                          <td className="border-b border-border/60 px-2 py-1 text-muted-foreground">
                            {keys.join(" ") || "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {describeDetail.constraints.length > 0 ? (
                  <div>
                    <div className="mb-1 px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Constraints
                    </div>
                    <ul className="space-y-1 px-2 font-mono text-xs">
                      {describeDetail.constraints.map((constraint) => (
                        <li key={constraint.name} className="leading-snug">
                          <span className="text-foreground">
                            {constraint.type}
                          </span>{" "}
                          <span className="text-muted-foreground">
                            {constraint.name}
                          </span>
                          <div className="text-muted-foreground">
                            {constraint.definition}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDescribeOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
