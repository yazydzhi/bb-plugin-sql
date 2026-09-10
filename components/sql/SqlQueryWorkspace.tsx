import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../../server";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { parseConnHint } from "@/lib/parse-conn-hint";
import { useOfflineStatusFade } from "@/hooks/use-offline-status-fade";
import { SqlCodeEditor } from "./SqlCodeEditor";
import { connectOrReconnectWithPasswordPrompt } from "./connect-helpers";
import {
  copyText,
  downloadResultCsv,
  downloadResultJson,
  formatCell,
  resultToCsv,
  resultToJson,
  tabTitleFromSql,
} from "./format";
import { StatusDot } from "./Status";
import type {
  ConnStatus,
  ConnectionListItem,
  ConnectionStatusEntry,
  HistoryItem,
  ResultTab,
} from "./types";
import {
  connectionErrorFromMap,
  connectionStatusFromMap,
  makeStatusEntry,
  mergeConnectionStatuses,
} from "./types";

/** Доля высоты панели под редактор (остальное — результаты). */
const DEFAULT_EDITOR_RATIO = 0.45;
const MIN_EDITOR_RATIO = 0.18;
const MAX_EDITOR_RATIO = 0.82;

/**
 * Правая панель / Actions: editor + results + history.
 * Active connection синхронизируется через getUiState / realtime.
 */
export function SqlQueryWorkspace() {
  const rpc = useRpc<typeof rpcContract>();
  const [connections, setConnections] = useState<ConnectionListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sql, setSql] = useState("SELECT 1");
  const [resultTabs, setResultTabs] = useState<ResultTab[]>([]);
  const [activeResultId, setActiveResultId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [statusById, setStatusById] = useState<
    Record<string, ConnectionStatusEntry>
  >({});
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [editorRatio, setEditorRatio] = useState(DEFAULT_EDITOR_RATIO);
  const autoRunRef = useRef(false);
  const openSqlInputRef = useRef<HTMLInputElement | null>(null);
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const dragRatioRef = useRef(DEFAULT_EDITOR_RATIO);
  const connectionsRef = useRef(connections);
  connectionsRef.current = connections;

  const selectedStatus = selectedId
    ? connectionStatusFromMap(statusById, selectedId)
    : "idle";
  const selectedError = selectedId
    ? connectionErrorFromMap(statusById, selectedId)
    : null;

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

  const refreshConnections = useCallback(async () => {
    const { connections: next } = await rpc.call("listConnections");
    setConnections(next);
    setStatusById((current) => mergeConnectionStatuses(current, next));
    const ui = await rpc.call("getUiState");
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

  const refreshHistory = useCallback(async () => {
    const { items } = await rpc.call("listHistory", { limit: 40 });
    setHistory(items);
  }, [rpc]);

  const runSqlWith = useCallback(
    async (connectionId: string, query: string) => {
      const trimmed = query.trim();
      if (!trimmed) {
        toast.error("Enter a SQL query");
        return;
      }
      const connectionName =
        connections.find((item) => item.id === connectionId)?.name ?? connectionId;
      setRunning(true);
      try {
        const next = await rpc.call("runQuery", {
          connectionId,
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
        patchConnectionStatus(connectionId, "online");
        await rpc.call("recordHistory", { connectionId, sql: trimmed });
        await refreshHistory();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toast.error(message);
        if (/connect|ECONNREFUSED|timeout|terminating/i.test(message)) {
          patchConnectionStatus(connectionId, "offline", message);
        }
      } finally {
        setRunning(false);
      }
    },
    [connections, patchConnectionStatus, rpc, refreshHistory],
  );

  const applyDraft = useCallback(async () => {
    const draft = await rpc.call("consumeDraftSql");
    if (!draft.sql) {
      return;
    }
    setSql(draft.sql);
    if (draft.autoRun) {
      autoRunRef.current = true;
    }
  }, [rpc]);

  useEffect(() => {
    void (async () => {
      try {
        await refreshConnections();
        await refreshHistory();
        await applyDraft();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [refreshConnections, refreshHistory, applyDraft]);

  useRealtime("sql:ui", () => {
    void (async () => {
      try {
        await refreshConnections();
        await refreshHistory();
        await applyDraft();
      } catch {
        // ignore transient sync errors
      }
    })();
  });

  useEffect(() => {
    if (!autoRunRef.current) {
      return;
    }
    if (!selectedId || !sql.trim()) {
      return;
    }
    autoRunRef.current = false;
    void runSqlWith(selectedId, sql);
  }, [selectedId, sql, runSqlWith]);

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
        const connection = connectionsRef.current.find(
          (item) => item.id === selectedId,
        );
        const outcome = connection
          ? await connectOrReconnectWithPasswordPrompt({
              rpc,
              method: "connectConnection",
              connection,
            })
          : await rpc.call("connectConnection", { id: selectedId });
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
      } catch (error: unknown) {
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

  async function selectConnection(id: string) {
    setSelectedId(id);
    try {
      await rpc.call("setActiveConnection", { id });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function connectSelected() {
    if (!selectedId) {
      return;
    }
    const connection = connections.find((item) => item.id === selectedId);
    if (!connection) {
      return;
    }
    patchConnectionStatus(selectedId, "checking");
    try {
      const outcome = await connectOrReconnectWithPasswordPrompt({
        rpc,
        method: "connectConnection",
        connection,
      });
      if (outcome.ok) {
        patchConnectionStatus(selectedId, "online");
        toast.success("Connected");
        await refreshConnections();
      } else {
        patchConnectionStatus(
          selectedId,
          "offline",
          outcome.error ?? "Connect failed",
        );
        toast.error(outcome.error ?? "Connect failed");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      patchConnectionStatus(selectedId, "offline", message);
      toast.error(message);
    }
  }

  async function disconnectSelected() {
    if (!selectedId) {
      return;
    }
    try {
      await rpc.call("disconnectConnection", { id: selectedId });
      patchConnectionStatus(selectedId, "disconnected");
      toast.success("Disconnected");
      await refreshConnections();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function reconnectSelected() {
    if (!selectedId) {
      return;
    }
    const connection = connections.find((item) => item.id === selectedId);
    if (!connection) {
      return;
    }
    patchConnectionStatus(selectedId, "checking");
    try {
      const outcome = await connectOrReconnectWithPasswordPrompt({
        rpc,
        method: "reconnectConnection",
        connection,
      });
      if (outcome.ok) {
        patchConnectionStatus(selectedId, "online");
        toast.success("Reconnected");
        await refreshConnections();
      } else {
        patchConnectionStatus(
          selectedId,
          "offline",
          outcome.error ?? "Reconnect failed",
        );
        toast.error(outcome.error ?? "Reconnect failed");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      patchConnectionStatus(selectedId, "offline", message);
      toast.error(message);
    }
  }

  async function runSql() {
    if (!selectedId) {
      toast.error("Select a connection first");
      return;
    }
    await runSqlWith(selectedId, sql);
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

  function closeAllResultTabs() {
    setResultTabs([]);
    setActiveResultId(null);
  }

  function onEditorKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void runSql();
    }
  }

  function clampEditorRatio(ratio: number): number {
    return Math.min(MAX_EDITOR_RATIO, Math.max(MIN_EDITOR_RATIO, ratio));
  }

  function startSplitResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const container = splitContainerRef.current;
    if (!container) {
      return;
    }
    const startY = event.clientY;
    const startRatio = editorRatio;
    const containerHeight = container.getBoundingClientRect().height;
    if (containerHeight <= 0) {
      return;
    }
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    dragRatioRef.current = startRatio;

    function onMove(moveEvent: PointerEvent) {
      const delta = moveEvent.clientY - startY;
      const next = clampEditorRatio(startRatio + delta / containerHeight);
      dragRatioRef.current = next;
      setEditorRatio(next);
    }

    function onUp(upEvent: PointerEvent) {
      target.releasePointerCapture(upEvent.pointerId);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
      setEditorRatio(dragRatioRef.current);
    }

    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  }

  function loadHistoryItem(item: HistoryItem) {
    setSql(item.sql);
    if (connections.some((connection) => connection.id === item.connectionId)) {
      void selectConnection(item.connectionId);
    }
    setHistoryOpen(false);
  }

  async function clearHistory() {
    try {
      await rpc.call("clearHistory");
      await refreshHistory();
      toast.success("History cleared");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function loadSqlFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    try {
      const content = await file.text();
      setSql(content);
      const hint = parseConnHint(content);
      if (hint) {
        const match = connections.find(
          (item) => item.name === hint || item.id === hint,
        );
        if (match) {
          await selectConnection(match.id);
        } else {
          toast.error(`Unknown @conn "${hint}"`);
        }
      }
      await rpc.call("setDraftSql", { sql: content, autoRun: false });
      toast.success(`Loaded ${file.name}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  const selected = connections.find((item) => item.id === selectedId) ?? null;
  const activeResult =
    resultTabs.find((tab) => tab.id === activeResultId) ?? null;

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden text-sm">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <StatusDot status={selected ? selectedStatus : "idle"} />
          <select
            className="max-w-[12rem] truncate rounded border border-border bg-transparent px-2 py-1 text-xs"
            value={selectedId ?? ""}
            onChange={(event) => {
              if (event.target.value) {
                void selectConnection(event.target.value);
              }
            }}
          >
            {connections.length === 0 ? (
              <option value="">No connections</option>
            ) : (
              connections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.connected ? "● " : "○ "}
                  {connection.name}
                </option>
              ))
            )}
          </select>
          <span
            className="hidden min-w-0 truncate text-muted-foreground md:inline"
            title={selectedError ?? undefined}
          >
            {selected
              ? `${selected.user}@${selected.host}:${selected.port}/${selected.database}`
              : "Open SQL in the sidebar to add connections"}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <input
            ref={openSqlInputRef}
            type="file"
            accept=".sql,text/plain"
            className="hidden"
            aria-hidden
            onChange={(event) => void loadSqlFile(event)}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => openSqlInputRef.current?.click()}
          >
            Open .sql…
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" aria-label="Connection session">
                Session
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {selectedStatus === "online" ? (
                <DropdownMenuItem onSelect={() => void disconnectSelected()}>
                  Disconnect
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => void connectSelected()}>
                  Connect
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => void reconnectSelected()}>
                Reconnect
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setHistoryOpen((open) => !open)}
          >
            History
          </Button>
          <Button
            size="sm"
            disabled={running || !selectedId || selectedStatus !== "online"}
            onClick={() => void runSql()}
          >
            {running ? "Running…" : "Run"}
          </Button>
        </div>
      </div>

      {historyOpen ? (
        <div className="absolute right-2 top-12 z-20 w-80 max-w-[calc(100%-1rem)] rounded-md border border-border bg-background shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Query history
            </span>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => void clearHistory()}>
                Clear
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setHistoryOpen(false)}>
                ×
              </Button>
            </div>
          </div>
          <ul className="max-h-64 overflow-auto py-1">
            {history.length === 0 ? (
              <li className="px-3 py-2 text-muted-foreground">No history yet.</li>
            ) : (
              history.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="w-full px-3 py-1.5 text-left hover:bg-state-hover"
                    onClick={() => loadHistoryItem(item)}
                  >
                    <div className="truncate font-mono text-xs">{item.sql}</div>
                    <div className="truncate text-[10px] text-muted-foreground">
                      {item.connectionName} · {new Date(item.createdAt).toLocaleString()}
                    </div>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}

      <div ref={splitContainerRef} className="flex min-h-0 flex-1 flex-col">
        <SqlCodeEditor
          className="min-h-[9rem] border-b border-border"
          style={{ flex: `0 0 ${editorRatio * 100}%` }}
          value={sql}
          onChange={setSql}
          onKeyDown={onEditorKeyDown}
        />

        <div
          role="separator"
          aria-orientation="horizontal"
          aria-valuemin={Math.round(MIN_EDITOR_RATIO * 100)}
          aria-valuemax={Math.round(MAX_EDITOR_RATIO * 100)}
          aria-valuenow={Math.round(editorRatio * 100)}
          aria-label="Resize editor and results"
          className="group relative z-10 h-3 w-full shrink-0 cursor-row-resize touch-none bg-transparent"
          onPointerDown={startSplitResize}
        >
          <span className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border transition-colors group-hover:bg-foreground/40 group-active:bg-foreground/60" />
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {resultTabs.length === 0 ? (
            <p className="px-3 py-3 text-muted-foreground">
              Results appear here as tabs. Each Run opens a new tab. Use the SQL
              sidebar for connections and schema browse. Drag the separator to
              resize the editor.
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
                <button
                  type="button"
                  className="shrink-0 px-2 text-xs text-muted-foreground hover:bg-state-hover"
                  onClick={closeAllResultTabs}
                >
                  Close all
                </button>
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
                          <Button size="sm" variant="ghost" aria-label="Export results">
                            ⋮
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onSelect={() =>
                              void copyText(resultToCsv(activeResult.result), "CSV")
                            }
                          >
                            Copy CSV
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() =>
                              void copyText(resultToJson(activeResult.result), "JSON")
                            }
                          >
                            Copy JSON
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onSelect={() => downloadResultCsv(activeResult.result)}
                          >
                            Download CSV
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => downloadResultJson(activeResult.result)}
                          >
                            Download JSON
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onSelect={() => setSql(activeResult.sql)}>
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
      </div>
    </div>
  );
}
