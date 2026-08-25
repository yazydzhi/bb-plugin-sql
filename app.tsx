// bb-plugin-sql — nav panel: connections, schema tree, SQL editor, results.
import {
  useCallback,
  useEffect,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Input } from "@/components/ui/input";

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

type QueryResult = {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  durationMs: number;
  truncated: boolean;
};

type ConnectionForm = {
  name: string;
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
};

type ConnStatus = "idle" | "checking" | "online" | "offline";

type ResultTab = {
  id: string;
  title: string;
  sql: string;
  connectionName: string;
  result: QueryResult;
  createdAt: number;
};

const emptyForm = (): ConnectionForm => ({
  name: "",
  host: "localhost",
  port: "5432",
  database: "postgres",
  user: "postgres",
  password: "",
  ssl: false,
});

function quoteIdent(ident: string): string {
  return `"${ident.replaceAll('"', '""')}"`;
}

function SqlPanel(_props: {
  threadId?: string;
  projectId?: string | null;
  params?: unknown;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [connections, setConnections] = useState<PublicConnection[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set());
  const [tablesBySchema, setTablesBySchema] = useState<
    Record<string, { name: string; type: string }[]>
  >({});
  const [sql, setSql] = useState("SELECT 1");
  const [resultTabs, setResultTabs] = useState<ResultTab[]>([]);
  const [activeResultId, setActiveResultId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [loadingTree, setLoadingTree] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PublicConnection | null>(null);
  const [form, setForm] = useState<ConnectionForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [connStatus, setConnStatus] = useState<ConnStatus>("idle");
  const [connStatusError, setConnStatusError] = useState<string | null>(null);

  const refreshConnections = useCallback(async () => {
    const { connections: next } = await rpc.call("listConnections");
    setConnections(next);
    setSelectedId((current) => {
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

  const refreshStatus = useCallback(
    async (connectionId: string) => {
      setConnStatus("checking");
      setConnStatusError(null);
      try {
        const outcome = await rpc.call("testConnection", { id: connectionId });
        if (outcome.ok) {
          setConnStatus("online");
          setConnStatusError(null);
        } else {
          setConnStatus("offline");
          setConnStatusError(outcome.error ?? "Connection failed");
        }
      } catch (error) {
        setConnStatus("offline");
        setConnStatusError(error instanceof Error ? error.message : String(error));
      }
    },
    [rpc],
  );

  useEffect(() => {
    if (!selectedId) {
      setConnStatus("idle");
      setConnStatusError(null);
      return;
    }
    void refreshStatus(selectedId);
  }, [selectedId, refreshStatus]);

  useEffect(() => {
    if (!selectedId) {
      setSchemas([]);
      setTablesBySchema({});
      setExpandedSchemas(new Set());
      return;
    }
    let cancelled = false;
    setLoadingTree(true);
    void rpc
      .call("listSchemas", { connectionId: selectedId })
      .then(({ schemas: next }) => {
        if (cancelled) {
          return;
        }
        setSchemas(next);
        setTablesBySchema({});
        setExpandedSchemas(new Set());
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : String(error));
          setSchemas([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingTree(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, selectedId]);

  async function toggleSchema(schema: string) {
    if (!selectedId) {
      return;
    }
    const next = new Set(expandedSchemas);
    if (next.has(schema)) {
      next.delete(schema);
      setExpandedSchemas(next);
      return;
    }
    next.add(schema);
    setExpandedSchemas(next);
    if (tablesBySchema[schema]) {
      return;
    }
    try {
      const { tables } = await rpc.call("listTables", {
        connectionId: selectedId,
        schema,
      });
      setTablesBySchema((current) => ({ ...current, [schema]: tables }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
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
        setSelectedId(editing.id);
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
        setSelectedId(connection.id);
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

  async function removeConnection(connection: PublicConnection) {
    if (!window.confirm(`Delete connection "${connection.name}"?`)) {
      return;
    }
    try {
      await rpc.call("deleteConnection", { id: connection.id });
      toast.success("Connection deleted");
      await refreshConnections();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function testSelected() {
    if (!selectedId) {
      return;
    }
    setConnStatus("checking");
    setConnStatusError(null);
    try {
      const outcome = await rpc.call("testConnection", { id: selectedId });
      if (outcome.ok) {
        setConnStatus("online");
        setConnStatusError(null);
        toast.success("Connection OK");
      } else {
        setConnStatus("offline");
        setConnStatusError(outcome.error ?? "Connection failed");
        toast.error(outcome.error ?? "Connection failed");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setConnStatus("offline");
      setConnStatusError(message);
      toast.error(message);
    }
  }

  async function runSql() {
    if (!selectedId) {
      toast.error("Select a connection first");
      return;
    }
    const trimmed = sql.trim();
    if (!trimmed) {
      toast.error("Enter a SQL query");
      return;
    }
    const connectionName =
      connections.find((item) => item.id === selectedId)?.name ?? selectedId;
    setRunning(true);
    try {
      const next = await rpc.call("runQuery", {
        connectionId: selectedId,
        sql: trimmed,
      });
      const tab: ResultTab = {
        id: crypto.randomUUID(),
        title: tabTitleFromSql(trimmed),
        sql: trimmed,
        connectionName,
        result: next,
        createdAt: Date.now(),
      };
      setResultTabs((current) => [...current, tab].slice(-20));
      setActiveResultId(tab.id);
      setConnStatus("online");
      setConnStatusError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(message);
      if (/connect|ECONNREFUSED|timeout|terminating/i.test(message)) {
        setConnStatus("offline");
        setConnStatusError(message);
      }
    } finally {
      setRunning(false);
    }
  }

  function closeResultTab(tabId: string) {
    setResultTabs((current) => {
      const index = current.findIndex((tab) => tab.id === tabId);
      if (index < 0) {
        return current;
      }
      const next = current.filter((tab) => tab.id !== tabId);
      setActiveResultId((active) => {
        if (active !== tabId) {
          return active;
        }
        const neighbor = next[index] ?? next[index - 1] ?? null;
        return neighbor?.id ?? null;
      });
      return next;
    });
  }

  function onEditorKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void runSql();
    }
  }

  function insertSelect(schema: string, table: string) {
    setSql(`SELECT * FROM ${quoteIdent(schema)}.${quoteIdent(table)} LIMIT 100`);
  }

  const selected = connections.find((item) => item.id === selectedId) ?? null;
  const activeResult =
    resultTabs.find((tab) => tab.id === activeResultId) ?? null;

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden text-sm">
      <aside className="flex w-72 shrink-0 flex-col border-r border-border bg-background">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <span className="font-medium">Connections</span>
          <Button size="sm" variant="outline" onClick={openCreateDialog}>
            + Add
          </Button>
        </div>
        <div className="max-h-48 overflow-auto border-b border-border">
          {connections.length === 0 ? (
            <p className="px-3 py-3 text-muted-foreground">No connections yet.</p>
          ) : (
            <ul className="py-1">
              {connections.map((connection) => (
                <li key={connection.id}>
                  <button
                    type="button"
                    className={
                      connection.id === selectedId
                        ? "flex w-full items-center gap-2 bg-state-active px-3 py-1.5 text-left"
                        : "flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-state-hover"
                    }
                    onClick={() => setSelectedId(connection.id)}
                  >
                    <StatusDot
                      status={
                        connection.id === selectedId ? connStatus : "idle"
                      }
                    />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {connection.name}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {connection.host}:{connection.port}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {selected ? (
          <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
            <div
              className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
              title={connStatusError ?? undefined}
            >
              <StatusLabel status={connStatus} error={connStatusError} />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" aria-label="Connection actions">
                  ⋮
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void testSelected()}>
                  Test connection
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => openEditDialog(selected)}>
                  Edit
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => void removeConnection(selected)}
                  className="text-destructive focus:text-destructive"
                >
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
          <div className="mb-1 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Schemas
          </div>
          {!selectedId ? (
            <p className="px-1 text-muted-foreground">Select a connection.</p>
          ) : loadingTree ? (
            <p className="px-1 text-muted-foreground">Loading…</p>
          ) : schemas.length === 0 ? (
            <p className="px-1 text-muted-foreground">No schemas.</p>
          ) : (
            <ul className="space-y-0.5">
              {schemas.map((schema) => {
                const open = expandedSchemas.has(schema);
                const tables = tablesBySchema[schema];
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
                          tables.map((table) => (
                            <li key={`${schema}.${table.name}`}>
                              <button
                                type="button"
                                className="w-full truncate rounded px-1 py-0.5 text-left hover:bg-state-hover"
                                title={`${table.type}: ${schema}.${table.name}`}
                                onClick={() => insertSelect(schema, table.name)}
                              >
                                {table.name}
                              </button>
                            </li>
                          ))
                        )}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <StatusDot status={selected ? connStatus : "idle"} />
            <span
              className="truncate text-muted-foreground"
              title={connStatusError ?? undefined}
            >
              {selected
                ? `${selected.user}@${selected.host}:${selected.port}/${selected.database}`
                : "No connection selected"}
            </span>
          </div>
          <Button size="sm" disabled={running || !selectedId} onClick={() => void runSql()}>
            {running ? "Running…" : "Run"}
          </Button>
        </div>
        <textarea
          className="min-h-40 w-full resize-y border-b border-border bg-transparent px-3 py-2 font-mono text-sm outline-none focus-visible:bg-state-hover/30"
          value={sql}
          onChange={(event) => setSql(event.target.value)}
          onKeyDown={onEditorKeyDown}
          spellCheck={false}
          placeholder="SELECT …  (⌘/Ctrl+Enter to run)"
        />
        <div className="flex min-h-0 flex-1 flex-col">
          {resultTabs.length === 0 ? (
            <p className="px-3 py-3 text-muted-foreground">
              Results appear here as tabs. Each Run opens a new tab.
            </p>
          ) : (
            <>
              <div className="flex items-stretch gap-0 overflow-x-auto border-b border-border">
                {resultTabs.map((tab) => {
                  const isActive = tab.id === activeResultId;
                  return (
                    <div
                      key={tab.id}
                      className={
                        isActive
                          ? "group flex max-w-[14rem] shrink-0 items-center gap-1 border-r border-border bg-state-active px-2 py-1.5"
                          : "group flex max-w-[14rem] shrink-0 items-center gap-1 border-r border-border px-2 py-1.5 hover:bg-state-hover"
                      }
                    >
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left text-xs"
                        title={`${tab.connectionName}\n${tab.sql}`}
                        onClick={() => setActiveResultId(tab.id)}
                      >
                        {tab.title}
                      </button>
                      <button
                        type="button"
                        className="shrink-0 rounded px-1 text-xs text-muted-foreground opacity-60 hover:bg-state-hover hover:opacity-100 group-hover:opacity-100"
                        aria-label={`Close ${tab.title}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          closeResultTab(tab.id);
                        }}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>

              {activeResult ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-1.5 text-xs">
                    <span className="min-w-0 truncate text-muted-foreground">
                      {activeResult.result.rowCount} row(s) ·{" "}
                      {activeResult.result.durationMs}ms
                      {activeResult.result.truncated ? " · truncated" : ""}
                      {" · "}
                      {activeResult.connectionName}
                    </span>
                    {activeResult.result.columns.length > 0 ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label="Export results"
                          >
                            ⋮
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onSelect={() =>
                              void copyText(
                                resultToCsv(activeResult.result),
                                "CSV",
                              )
                            }
                          >
                            Copy CSV
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() =>
                              void copyText(
                                resultToJson(activeResult.result),
                                "JSON",
                              )
                            }
                          >
                            Copy JSON
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onSelect={() =>
                              downloadText(
                                resultToCsv(activeResult.result),
                                `query-result-${stamp()}.csv`,
                                "text/csv;charset=utf-8",
                              )
                            }
                          >
                            Download CSV
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() =>
                              downloadText(
                                resultToJson(activeResult.result),
                                `query-result-${stamp()}.json`,
                                "application/json;charset=utf-8",
                              )
                            }
                          >
                            Download JSON
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onSelect={() => setSql(activeResult.sql)}
                          >
                            Load SQL into editor
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto">
                    {activeResult.result.columns.length === 0 ? (
                      <p className="px-3 py-3 text-muted-foreground">
                        No columns returned.
                      </p>
                    ) : (
                      <table className="w-full border-collapse text-left font-mono text-xs">
                        <thead className="sticky top-0 bg-background">
                          <tr>
                            {activeResult.result.columns.map((column) => (
                              <th
                                key={column}
                                className="border-b border-border px-3 py-1.5 font-medium"
                              >
                                {column}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {activeResult.result.rows.map((row, rowIndex) => (
                            <tr key={rowIndex} className="odd:bg-muted/20">
                              {activeResult.result.columns.map((column) => (
                                <td
                                  key={`${rowIndex}-${column}`}
                                  className="max-w-xs truncate border-b border-border/60 px-3 py-1 align-top"
                                  title={formatCell(row[column])}
                                >
                                  {formatCell(row[column])}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </>
              ) : null}
            </>
          )}
        </div>
      </section>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit connection" : "Add connection"}</DialogTitle>
            <DialogDescription>
              Saved connections persist in the plugin database across reloads —
              you do not need to re-add them after disconnect. A live test runs
              before save; failed tests are not stored.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <Field label="Name">
              <Input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="local"
              />
            </Field>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Host" className="col-span-2">
                <Input
                  value={form.host}
                  onChange={(event) => setForm({ ...form, host: event.target.value })}
                />
              </Field>
              <Field label="Port">
                <Input
                  value={form.port}
                  onChange={(event) => setForm({ ...form, port: event.target.value })}
                />
              </Field>
            </div>
            <Field label="Database">
              <Input
                value={form.database}
                onChange={(event) => setForm({ ...form, database: event.target.value })}
              />
            </Field>
            <Field label="User">
              <Input
                value={form.user}
                onChange={(event) => setForm({ ...form, user: event.target.value })}
              />
            </Field>
            <Field label={editing ? "Password (leave blank to keep)" : "Password"}>
              <Input
                type="password"
                value={form.password}
                onChange={(event) => setForm({ ...form, password: event.target.value })}
                autoComplete="new-password"
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.ssl}
                onChange={(event) => setForm({ ...form, ssl: event.target.checked })}
              />
              Use SSL
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button disabled={saving} onClick={() => void saveConnection()}>
              {saving ? "Testing & saving…" : "Test & save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={className ? `grid gap-1 ${className}` : "grid gap-1"}>
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function StatusDot({ status }: { status: ConnStatus }) {
  const color =
    status === "online"
      ? "bg-emerald-500"
      : status === "offline"
        ? "bg-red-500"
        : status === "checking"
          ? "bg-amber-400 animate-pulse"
          : "bg-muted-foreground/40";
  return (
    <span
      className={`inline-block size-2 shrink-0 rounded-full ${color}`}
      aria-hidden
    />
  );
}

function StatusLabel({
  status,
  error,
}: {
  status: ConnStatus;
  error: string | null;
}) {
  if (status === "checking") {
    return <span>Checking…</span>;
  }
  if (status === "online") {
    return <span className="text-emerald-600 dark:text-emerald-400">Connected</span>;
  }
  if (status === "offline") {
    return (
      <span className="text-red-600 dark:text-red-400">
        Disconnected{error ? `: ${error}` : ""}
      </span>
    );
  }
  return <span>Not checked</span>;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function tabTitleFromSql(sql: string): string {
  const oneLine = sql.replace(/\s+/g, " ").trim();
  if (oneLine.length <= 36) {
    return oneLine;
  }
  return `${oneLine.slice(0, 33)}…`;
}

/** CSV с экранированием кавычек и UTF-8 BOM для Excel. */
function resultToCsv(result: QueryResult): string {
  const escape = (value: unknown): string => {
    let text: string;
    if (value === null || value === undefined) {
      text = "";
    } else if (typeof value === "string") {
      text = value;
    } else {
      text = JSON.stringify(value) ?? "";
    }
    if (/[",\r\n]/.test(text)) {
      return `"${text.replaceAll('"', '""')}"`;
    }
    return text;
  };
  const header = result.columns.map(escape).join(",");
  const body = result.rows
    .map((row) => result.columns.map((column) => escape(row[column])).join(","))
    .join("\r\n");
  return `\uFEFF${header}\r\n${body}\r\n`;
}

function resultToJson(result: QueryResult): string {
  return `${JSON.stringify(result.rows, null, 2)}\n`;
}

function stamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function downloadText(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
  toast.success(`Saved ${filename}`);
}

async function copyText(content: string, label: string) {
  try {
    await navigator.clipboard.writeText(content);
    toast.success(`${label} copied`);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : `Failed to copy ${label}`);
  }
}

const sqlPanelRegistration = {
  id: "sql",
  title: "SQL",
  icon: "Database",
  // flush: свой скролл/лейаут на всю высоту вкладки справа
  layout: "flush" as const,
  component: SqlPanel,
};

export default definePluginApp((app) => {
  // Правая панель треда → New tab → Actions → SQL
  app.slots.threadPanelAction(sqlPanelRegistration);
  // То же на экране New thread
  app.slots.experimental_newThreadPanelAction(sqlPanelRegistration);
});
