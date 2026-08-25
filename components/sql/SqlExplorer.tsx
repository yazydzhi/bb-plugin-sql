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
import { StatusDot } from "./Status";
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

function tableKey(schema: string, table: string): string {
  return `${schema}.${table}`;
}

function detailKey(connectionId: string, schema: string, table: string): string {
  return `${connectionId}:${schema}.${table}`;
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
  const [schemasById, setSchemasById] = useState<Record<string, string[]>>({});
  const [tablesById, setTablesById] = useState<
    Record<string, Record<string, { name: string; type: string }[]>>
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
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PublicConnection | null>(null);
  const [form, setForm] = useState<ConnectionForm>(emptyForm());
  const [saving, setSaving] = useState(false);
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
  const selectedSchemas = selectedId ? (schemasById[selectedId] ?? []) : [];
  const selectedTables = selectedId ? (tablesById[selectedId] ?? {}) : {};
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
    setSchemasById((current) => {
      const next = { ...current };
      delete next[connectionId];
      return next;
    });
    setTablesById((current) => {
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
    if (!selectedId || selectedStatus !== "online") {
      return;
    }
    if (schemasById[selectedId]) {
      return;
    }
    let cancelled = false;
    setLoadingTreeById((current) => ({ ...current, [selectedId]: true }));
    void rpc
      .call("listSchemas", { connectionId: selectedId })
      .then(({ schemas: next }) => {
        if (cancelled) {
          return;
        }
        setSchemasById((current) => ({ ...current, [selectedId]: next }));
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingTreeById((current) => ({ ...current, [selectedId]: false }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, schemasById, selectedId, selectedStatus]);

  async function toggleSchema(schema: string) {
    if (!selectedId) {
      return;
    }
    const expanded = expandedSchemasById[selectedId] ?? [];
    if (expanded.includes(schema)) {
      setExpandedSchemasById((current) => ({
        ...current,
        [selectedId]: expanded.filter((item) => item !== schema),
      }));
      return;
    }
    setExpandedSchemasById((current) => ({
      ...current,
      [selectedId]: [...expanded, schema],
    }));
    if (selectedTables[schema]) {
      return;
    }
    try {
      const { tables } = await rpc.call("listTables", {
        connectionId: selectedId,
        schema,
      });
      setTablesById((current) => ({
        ...current,
        [selectedId]: { ...(current[selectedId] ?? {}), [schema]: tables },
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
    schema: string,
    table: string,
  ): Promise<TableDetail | null> {
    if (!selectedId) {
      return null;
    }
    const key = detailKey(selectedId, schema, table);
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

  async function toggleTable(schema: string, table: string) {
    if (!selectedId) {
      return;
    }
    const key = tableKey(schema, table);
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
    await loadTableDetail(schema, table);
  }

  function insertSelect(schema: string, table: string) {
    void pushDraft(
      `SELECT * FROM ${quoteIdent(schema)}.${quoteIdent(table)} LIMIT 100`,
      false,
    );
  }

  function showRecords(schema: string, table: string) {
    void pushDraft(
      `SELECT * FROM ${quoteIdent(schema)}.${quoteIdent(table)} LIMIT 100`,
      true,
    );
  }

  async function describeTable(schema: string, table: string) {
    setDescribeTitle(`${schema}.${table}`);
    setDescribeOpen(true);
    setDescribeLoading(true);
    setDescribeDetail(null);
    const detail = await loadTableDetail(schema, table);
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
    });
    setDialogOpen(true);
  }

  async function saveConnection() {
    const port = Number(form.port);
    if (!form.name.trim() || !form.host.trim() || !form.database.trim() || !form.user.trim()) {
      toast.error("Name, host, database, and user are required");
      return;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      toast.error("Port must be an integer 1–65535");
      return;
    }
    if (!editing && form.password.length === 0) {
      toast.error("Password is required for a new connection");
      return;
    }

    setSaving(true);
    try {
      const probe = await rpc.call("probeConnection", {
        id: editing?.id,
        host: form.host.trim(),
        port,
        database: form.database.trim(),
        user: form.user.trim(),
        password: form.password.length > 0 ? form.password : undefined,
        ssl: form.ssl,
      });
      if (!probe.ok) {
        toast.error(probe.error ?? "Connection test failed — not saved");
        return;
      }

      if (editing) {
        await rpc.call("updateConnection", {
          id: editing.id,
          name: form.name.trim(),
          host: form.host.trim(),
          port,
          database: form.database.trim(),
          user: form.user.trim(),
          password: form.password.length > 0 ? form.password : undefined,
          ssl: form.ssl,
        });
        toast.success("Connection tested and updated");
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
        });
        await selectConnection(connection.id);
        toast.success("Connection tested and saved");
      }
      setDialogOpen(false);
      await refreshConnections();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
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
      const outcome = await rpc.call("connectConnection", { id: connection.id });
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
      const outcome = await rpc.call("reconnectConnection", {
        id: connection.id,
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
          Schemas
        </div>
        {!selectedId ? (
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
        ) : selectedSchemas.length === 0 ? (
          <p className="px-1 text-muted-foreground">No schemas.</p>
        ) : (
          <ul className="space-y-0.5">
            {selectedSchemas.map((schema) => {
              const open = selectedExpandedSchemas.has(schema);
              const tables = selectedTables[schema];
              return (
                <li key={schema}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-state-hover"
                    onClick={() => void toggleSchema(schema)}
                  >
                    <span className="w-3 shrink-0 text-muted-foreground">
                      {open ? "▾" : "▸"}
                    </span>
                    <span className="truncate">{schema}</span>
                  </button>
                  {open ? (
                    <ul className="ml-4 border-l border-border pl-2">
                      {!tables ? (
                        <li className="py-0.5 text-muted-foreground">Loading…</li>
                      ) : tables.length === 0 ? (
                        <li className="py-0.5 text-muted-foreground">Empty</li>
                      ) : (
                        tables.map((table) => {
                          const key = tableKey(schema, table.name);
                          const detailKeyForRow = selectedId
                            ? detailKey(selectedId, schema, table.name)
                            : key;
                          const tableOpen = selectedExpandedTables.has(key);
                          const detail = tableDetailsById[detailKeyForRow];
                          const loadingDetail = loadingTables.has(detailKeyForRow);
                          const extras = detail
                            ? extraConstraints(detail.constraints)
                            : [];
                          return (
                            <li key={key}>
                              <div className="group flex items-center gap-0.5">
                                <button
                                  type="button"
                                  className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-state-hover"
                                  title={`${table.type}: ${schema}.${table.name}`}
                                  onClick={() =>
                                    void toggleTable(schema, table.name)
                                  }
                                >
                                  <span className="w-3 shrink-0 text-muted-foreground">
                                    {tableOpen ? "▾" : "▸"}
                                  </span>
                                  <span className="truncate">{table.name}</span>
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
                                        insertSelect(schema, table.name)
                                      }
                                    >
                                      Insert SELECT
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onSelect={() =>
                                        showRecords(schema, table.name)
                                      }
                                    >
                                      Show records
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onSelect={() =>
                                        void describeTable(schema, table.name)
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
                                  ) : !detail || detail.columns.length === 0 ? (
                                    <li className="px-1 py-0.5 text-muted-foreground">
                                      No columns
                                    </li>
                                  ) : (
                                    <>
                                      {detail.columns.map((column) => {
                                        const fk = column.foreignKey;
                                        const marks: string[] = [];
                                        if (column.isPrimaryKey) {
                                          marks.push("PK");
                                        }
                                        if (column.isUnique) {
                                          marks.push("UQ");
                                        }
                                        if (!column.isNullable) {
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
                                            {marks.length > 0 ? (
                                              <span className="shrink-0 text-muted-foreground">
                                                {marks.join(" ")}
                                              </span>
                                            ) : null}
                                            {fkLabel ? (
                                              <span className="min-w-0 truncate text-muted-foreground">
                                                → {fkLabel}
                                              </span>
                                            ) : null}
                                          </li>
                                        );
                                      })}
                                      {extras.length > 0 ? (
                                        <li className="mt-1 space-y-0.5 border-t border-border/60 pt-1">
                                          {extras.map((constraint) => (
                                            <div
                                              key={constraint.name}
                                              className="px-1 font-mono text-[11px] leading-snug text-muted-foreground"
                                              title={`${constraint.name}: ${constraint.definition}`}
                                            >
                                              <span className="text-foreground/80">
                                                {constraint.type === "PRIMARY KEY"
                                                  ? "PK"
                                                  : constraint.type === "FOREIGN KEY"
                                                    ? "FK"
                                                    : constraint.type === "UNIQUE"
                                                      ? "UQ"
                                                      : constraint.type}
                                              </span>{" "}
                                              <span className="truncate">
                                                {constraint.columns.length > 0
                                                  ? `(${constraint.columns.join(", ")})`
                                                  : constraint.definition}
                                              </span>
                                            </div>
                                          ))}
                                        </li>
                                      ) : null}
                                    </>
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
