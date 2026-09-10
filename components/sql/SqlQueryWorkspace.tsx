import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useRealtime, useRpc, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../../server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { parseConnHint } from "@/lib/parse-conn-hint";
import { formatSqlLight } from "@/lib/format-sql-light";
import { useOfflineStatusFade } from "@/hooks/use-offline-status-fade";
import { SqlCodeEditor } from "./SqlCodeEditor";
import { connectOrReconnectWithPasswordPrompt } from "./connect-helpers";
import {
  copyText,
  downloadResultCsv,
  downloadResultJson,
  downloadResultMarkdown,
  formatCell,
  resultToCsv,
  resultToJson,
  resultToMarkdown,
  resultToTsv,
  tabTitleFromSql,
} from "./format";
import { StatusDot } from "./Status";
import type {
  BookmarkItem,
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

/** Краткая строка endpoint для UI. */
function connectionEndpoint(connection: ConnectionListItem): string {
  return `${connection.user}@${connection.host}:${connection.port}/${connection.database}`;
}

/** Иконка-кнопка тулбара: без рамки, цвет при hover + title. */
function ToolbarIconButton({
  label,
  title,
  disabled,
  pressed,
  tone,
  onClick,
  children,
}: {
  label: string;
  title: string;
  disabled?: boolean;
  pressed?: boolean;
  tone?: "emerald" | "red" | "sky" | "amber";
  onClick: () => void;
  children: ReactNode;
}) {
  const toneClass =
    tone === "emerald"
      ? "hover:text-emerald-500"
      : tone === "red"
        ? "hover:text-red-500"
        : tone === "sky"
          ? "hover:text-sky-500"
          : tone === "amber"
            ? "hover:text-amber-500 data-[pressed=true]:text-amber-500"
            : "hover:text-foreground";
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      disabled={disabled}
      data-pressed={pressed ? "true" : undefined}
      aria-pressed={pressed}
      onClick={onClick}
      className={`inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors disabled:pointer-events-none disabled:opacity-40 ${toneClass} hover:bg-state-hover data-[pressed=true]:bg-state-active`}
    >
      {children}
    </button>
  );
}

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
  const navigate = useBbNavigate();
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
  const [bookmarks, setBookmarks] = useState<BookmarkItem[]>([]);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [bookmarkDraft, setBookmarkDraft] = useState<{
    sql: string;
    connectionId: string | null;
    defaultTitle: string;
  } | null>(null);
  const [bookmarkTitle, setBookmarkTitle] = useState("");
  const [bookmarkSaving, setBookmarkSaving] = useState(false);
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

  const refreshBookmarks = useCallback(async () => {
    const { items } = await rpc.call("listBookmarks");
    setBookmarks(items);
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
        await refreshBookmarks();
        await applyDraft();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [refreshConnections, refreshHistory, refreshBookmarks, applyDraft]);

  useRealtime("sql:ui", () => {
    void (async () => {
      try {
        await refreshConnections();
        await refreshHistory();
        await refreshBookmarks();
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

  function formatEditorSql() {
    setSql(formatSqlLight(sql));
    toast.success("Beautified");
  }

  function findBookmarkBySql(query: string): BookmarkItem | null {
    const trimmed = query.trim();
    if (!trimmed) {
      return null;
    }
    return bookmarks.find((item) => item.sql.trim() === trimmed) ?? null;
  }

  const matchingBookmark = useMemo(
    () => findBookmarkBySql(sql),
    [bookmarks, sql],
  );

  function beginAddBookmark(query: string, connectionId: string | null) {
    const trimmed = query.trim();
    if (!trimmed) {
      toast.error("Nothing to bookmark");
      return;
    }
    const existing = findBookmarkBySql(trimmed);
    if (existing) {
      toast.info("Already in bookmarks");
      setBookmarksOpen(true);
      setHistoryOpen(false);
      return;
    }
    const defaultTitle = tabTitleFromSql(trimmed);
    setBookmarkDraft({
      sql: trimmed,
      connectionId,
      defaultTitle,
    });
    setBookmarkTitle(defaultTitle);
  }

  async function toggleEditorBookmark() {
    if (matchingBookmark) {
      try {
        await rpc.call("deleteBookmark", { id: matchingBookmark.id });
        await refreshBookmarks();
        toast.success("Bookmark removed");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    beginAddBookmark(sql, selectedId);
  }

  async function toggleHistoryBookmark(item: HistoryItem) {
    const existing = findBookmarkBySql(item.sql);
    if (existing) {
      try {
        await rpc.call("deleteBookmark", { id: existing.id });
        await refreshBookmarks();
        toast.success("Bookmark removed");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    beginAddBookmark(item.sql, item.connectionId);
  }

  async function confirmBookmark() {
    if (!bookmarkDraft) {
      return;
    }
    const finalTitle = bookmarkTitle.trim() || bookmarkDraft.defaultTitle;
    setBookmarkSaving(true);
    try {
      await rpc.call("addBookmark", {
        title: finalTitle,
        sql: bookmarkDraft.sql,
        connectionId: bookmarkDraft.connectionId,
      });
      await refreshBookmarks();
      toast.success("Bookmark saved");
      setBookmarkDraft(null);
      setBookmarksOpen(true);
      setHistoryOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBookmarkSaving(false);
    }
  }

  function loadBookmark(item: BookmarkItem) {
    setSql(item.sql);
    if (
      item.connectionId &&
      connections.some((connection) => connection.id === item.connectionId)
    ) {
      void selectConnection(item.connectionId);
    }
    setBookmarksOpen(false);
  }

  async function removeBookmark(id: string) {
    try {
      await rpc.call("deleteBookmark", { id });
      await refreshBookmarks();
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
      <div className="flex h-10 flex-wrap items-center gap-2 border-b border-border px-3">
        <input
          ref={openSqlInputRef}
          type="file"
          accept=".sql,text/plain"
          className="hidden"
          aria-hidden
          onChange={(event) => void loadSqlFile(event)}
        />
        <ToolbarIconButton
          label="Open SQL panel"
          title="Open SQL panel"
          onClick={() => navigate.toPluginPanel("sql")}
        >
          <Icon name="Layers" className="size-4" aria-hidden />
        </ToolbarIconButton>
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          onClick={() => openSqlInputRef.current?.click()}
        >
          Open .sql…
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              className="h-8 max-w-[18rem] min-w-[10rem] justify-between gap-2 px-2 font-normal"
              aria-label={
                selected
                  ? `Connection ${selected.name}: ${connectionEndpoint(selected)}${
                      selectedError ? ` — ${selectedError}` : ""
                    }`
                  : "Select a connection"
              }
              disabled={connections.length === 0}
            >
              <span className="flex min-w-0 items-center gap-1.5 text-left">
                <StatusDot status={selected ? selectedStatus : "idle"} />
                <span className="truncate">
                  {selected
                    ? selected.name
                    : connections.length === 0
                      ? "No connections"
                      : "Select connection"}
                </span>
              </span>
              <Icon name="ChevronDown" className="size-3.5 shrink-0 opacity-60" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[18rem] max-w-[24rem]">
            {connections.map((connection) => {
              const isActive = connection.id === selectedId;
              const rowStatus = connectionStatusFromMap(statusById, connection.id);
              return (
                <DropdownMenuItem
                  key={connection.id}
                  className="flex cursor-pointer flex-col items-start gap-0.5 py-2"
                  onSelect={() => void selectConnection(connection.id)}
                >
                  <span className="flex w-full items-center gap-1.5 text-xs">
                    <StatusDot status={rowStatus} />
                    <span className={`truncate ${isActive ? "font-semibold" : "font-medium"}`}>
                      {connection.name}
                    </span>
                  </span>
                  <span className="w-full truncate pl-4 text-[10px] text-muted-foreground/70">
                    {connectionEndpoint(connection)}
                  </span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex h-8 shrink-0 items-center gap-0.5">
          {selectedStatus === "online" ? (
            <ToolbarIconButton
              label="Disconnect"
              title="Disconnect"
              tone="red"
              disabled={!selectedId}
              onClick={() => void disconnectSelected()}
            >
              <Icon name="CircleX" className="size-4" aria-hidden />
            </ToolbarIconButton>
          ) : (
            <ToolbarIconButton
              label="Connect"
              title="Connect"
              tone="emerald"
              disabled={!selectedId || selectedStatus === "checking"}
              onClick={() => void connectSelected()}
            >
              <Icon name="ElectricPlugs" className="size-4" aria-hidden />
            </ToolbarIconButton>
          )}
          {selectedStatus === "online" ? (
            <ToolbarIconButton
              label="Reconnect"
              title="Reconnect"
              tone="sky"
              disabled={!selectedId}
              onClick={() => void reconnectSelected()}
            >
              <Icon name="RotateCcw" className="size-4" aria-hidden />
            </ToolbarIconButton>
          ) : null}
        </div>

        <div className="ml-auto flex h-8 shrink-0 items-center gap-2">
          <div className="flex h-8 items-center gap-0.5 rounded-md border border-border px-0.5">
            <ToolbarIconButton
              label="History"
              title="Query history"
              pressed={historyOpen}
              onClick={() => {
                setBookmarksOpen(false);
                setHistoryOpen((open) => !open);
              }}
            >
              <Icon name="Clock" className="size-4" aria-hidden />
            </ToolbarIconButton>
            <ToolbarIconButton
              label="Bookmarks"
              title="Bookmarks"
              pressed={bookmarksOpen}
              onClick={() => {
                setHistoryOpen(false);
                setBookmarksOpen((open) => !open);
              }}
            >
              <Icon name="Explore" className="size-4" aria-hidden />
            </ToolbarIconButton>
            <ToolbarIconButton
              label={matchingBookmark ? "Remove bookmark" : "Add bookmark"}
              title={
                matchingBookmark
                  ? "Remove bookmark for current SQL"
                  : "Add bookmark"
              }
              tone="amber"
              pressed={Boolean(matchingBookmark)}
              onClick={() => void toggleEditorBookmark()}
            >
              <Icon name="Star" className="size-4" aria-hidden />
            </ToolbarIconButton>
          </div>

          <Button
            size="sm"
            className="h-8"
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
              history.map((item) => {
                const bookmarked = findBookmarkBySql(item.sql);
                return (
                  <li
                    key={item.id}
                    className="group flex items-start gap-1 px-1 py-0.5 hover:bg-state-hover"
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 px-2 py-1 text-left"
                      onClick={() => loadHistoryItem(item)}
                    >
                      <div className="truncate font-mono text-xs">{item.sql}</div>
                      <div className="truncate text-[10px] text-muted-foreground">
                        {item.connectionName} ·{" "}
                        {new Date(item.createdAt).toLocaleString()}
                      </div>
                    </button>
                    <ToolbarIconButton
                      label={
                        bookmarked
                          ? "Remove bookmark"
                          : "Save to bookmarks"
                      }
                      title={
                        bookmarked
                          ? "Remove bookmark"
                          : "Save to bookmarks"
                      }
                      tone="amber"
                      pressed={Boolean(bookmarked)}
                      onClick={() => void toggleHistoryBookmark(item)}
                    >
                      <Icon name="Star" className="size-3.5" aria-hidden />
                    </ToolbarIconButton>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      ) : null}

      {bookmarksOpen ? (
        <div className="absolute right-2 top-12 z-20 w-80 max-w-[calc(100%-1rem)] rounded-md border border-border bg-background shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Bookmarks
            </span>
            <Button size="sm" variant="ghost" onClick={() => setBookmarksOpen(false)}>
              ×
            </Button>
          </div>
          <ul className="max-h-64 overflow-auto py-1">
            {bookmarks.length === 0 ? (
              <li className="px-3 py-2 text-muted-foreground">
                No bookmarks yet. Use ★ to save the current SQL.
              </li>
            ) : (
              bookmarks.map((item) => (
                <li
                  key={item.id}
                  className="group flex items-start gap-1 px-2 py-1 hover:bg-state-hover"
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 px-1 py-0.5 text-left"
                    onClick={() => loadBookmark(item)}
                  >
                    <div className="truncate text-xs font-medium">{item.title}</div>
                    <div className="truncate font-mono text-[10px] text-muted-foreground">
                      {item.sql}
                    </div>
                  </button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 shrink-0 px-0 opacity-0 group-hover:opacity-100"
                    aria-label={`Delete bookmark ${item.title}`}
                    onClick={() => void removeBookmark(item.id)}
                  >
                    ×
                  </Button>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}

      <div ref={splitContainerRef} className="flex min-h-0 flex-1 flex-col">
        <div
          className="relative min-h-[9rem] border-b border-border"
          style={{ flex: `0 0 ${editorRatio * 100}%` }}
        >
          <button
            type="button"
            title="Beautify"
            onClick={formatEditorSql}
            className="absolute right-2 top-1.5 z-20 text-xs text-muted-foreground/50 transition-opacity hover:text-muted-foreground hover:underline"
          >
            Format
          </button>
          <SqlCodeEditor
            className="h-full"
            value={sql}
            onChange={setSql}
            onKeyDown={onEditorKeyDown}
          />
        </div>
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
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
                          title="Copy table with headers"
                          onClick={() =>
                            void copyText(resultToTsv(activeResult.result), "Table")
                          }
                        >
                          <Icon name="Copy" className="size-3.5" aria-hidden />
                          table
                        </button>
                        <button
                          type="button"
                          className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
                          title="Copy CSV"
                          onClick={() =>
                            void copyText(resultToCsv(activeResult.result), "CSV")
                          }
                        >
                          <Icon name="Copy" className="size-3.5" aria-hidden />
                          csv
                        </button>
                        <button
                          type="button"
                          className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
                          title="Copy JSON"
                          onClick={() =>
                            void copyText(resultToJson(activeResult.result), "JSON")
                          }
                        >
                          <Icon name="Copy" className="size-3.5" aria-hidden />
                          json
                        </button>
                        <button
                          type="button"
                          className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
                          title="Copy Markdown"
                          onClick={() =>
                            void copyText(resultToMarkdown(activeResult.result), "Markdown")
                          }
                        >
                          <Icon name="Copy" className="size-3.5" aria-hidden />
                          md
                        </button>
                        <button
                          type="button"
                          className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
                          title="Download CSV"
                          onClick={() => downloadResultCsv(activeResult.result)}
                        >
                          <Icon name="Download" className="size-3.5" aria-hidden />
                          csv
                        </button>
                        <button
                          type="button"
                          className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
                          title="Download JSON"
                          onClick={() => downloadResultJson(activeResult.result)}
                        >
                          <Icon name="Download" className="size-3.5" aria-hidden />
                          json
                        </button>
                        <button
                          type="button"
                          className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
                          title="Download Markdown"
                          onClick={() => downloadResultMarkdown(activeResult.result)}
                        >
                          <Icon name="Download" className="size-3.5" aria-hidden />
                          md
                        </button>
                        <button
                          type="button"
                          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
                          title="Load SQL into editor"
                          aria-label="Load SQL into editor"
                          onClick={() => setSql(activeResult.sql)}
                        >
                          <Icon name="Edit" className="size-3.5" aria-hidden />
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto">
                    {activeResult.result.columns.length === 0 ? (
                      <p className="px-3 py-3 text-muted-foreground">
                        No columns returned.
                      </p>
                    ) : (
                      <table className="w-full border-collapse text-left font-mono text-xs">
                        <thead className="sticky top-0 z-10 bg-background">
                          <tr>
                            <th className="w-8 border-b border-border px-1 py-1.5" aria-hidden />
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
                            <tr
                              key={rowIndex}
                              className="group/row odd:bg-muted/20 hover:bg-state-hover/40"
                            >
                              <td className="w-8 border-b border-border/60 px-1 py-1 align-middle">
                                <button
                                  type="button"
                                  className="inline-flex size-6 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-state-hover hover:text-foreground group-hover/row:opacity-100"
                                  title="Copy row"
                                  aria-label={`Copy row ${rowIndex + 1}`}
                                  onClick={() =>
                                    void copyText(
                                      activeResult.result.columns
                                        .map((column) => formatCell(row[column]))
                                        .join("\t"),
                                      "Row",
                                    )
                                  }
                                >
                                  <Icon name="Copy" className="size-3" aria-hidden />
                                </button>
                              </td>
                              {activeResult.result.columns.map((column) => {
                                const cellText = formatCell(row[column]);
                                return (
                                  <td
                                    key={`${rowIndex}-${column}`}
                                    className="group/cell relative max-w-xs border-b border-border/60 px-3 py-1 align-top"
                                    title={cellText}
                                  >
                                    <span className="block truncate pr-5">{cellText}</span>
                                    <button
                                      type="button"
                                      className="absolute right-1 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-state-hover hover:text-foreground group-hover/cell:opacity-100"
                                      title="Copy cell"
                                      aria-label={`Copy ${column}`}
                                      onClick={() => void copyText(cellText, "Cell")}
                                    >
                                      <Icon name="Copy" className="size-3" aria-hidden />
                                    </button>
                                  </td>
                                );
                              })}
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

      <Dialog
        open={bookmarkDraft !== null}
        onOpenChange={(open) => {
          if (!open && !bookmarkSaving) {
            setBookmarkDraft(null);
          }
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Save bookmark</DialogTitle>
            <DialogDescription>
              Title for this query in Favorites / Bookmarks.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={bookmarkTitle}
            onChange={(event) => setBookmarkTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void confirmBookmark();
              }
            }}
            placeholder={bookmarkDraft?.defaultTitle ?? "Bookmark title"}
          />
          <DialogFooter>
            <Button
              size="sm"
              variant="outline"
              disabled={bookmarkSaving}
              onClick={() => setBookmarkDraft(null)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={bookmarkSaving}
              onClick={() => void confirmBookmark()}
            >
              {bookmarkSaving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
