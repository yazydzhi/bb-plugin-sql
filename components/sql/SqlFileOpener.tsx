import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { useRpc, type PluginFileOpenerProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../../server";
import { Button } from "@/components/ui/button";
import { SqlQueryWorkspace } from "./SqlQueryWorkspace";
import type { ConnectionListItem } from "./types";

/**
 * fileOpener для `.sql`: грузит файл, учитывает `-- @conn Name`,
 * даёт выбрать коннект в шапке, кладёт SQL в draft и показывает Query workspace.
 */
export function SqlFileOpener({ path, source }: PluginFileOpenerProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [localSql, setLocalSql] = useState("");
  const [connections, setConnections] = useState<ConnectionListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const label = useMemo(() => path.split(/[\\/]/).pop() ?? path, [path]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setReady(false);
    void (async () => {
      try {
        const [{ content, connectionHint }, { connections: listed }, ui] =
          await Promise.all([
            rpc.call("readSqlFile", {
              path,
              kind: source.kind,
              threadId: source.threadId,
              environmentId: source.environmentId,
              projectId: source.projectId,
            }),
            rpc.call("listConnections"),
            rpc.call("getUiState"),
          ]);
        if (cancelled) {
          return;
        }
        setLocalSql(content);
        setConnections(listed);

        let nextId: string | null = ui.activeConnectionId;
        if (connectionHint) {
          const match = listed.find(
            (item) =>
              item.name === connectionHint || item.id === connectionHint,
          );
          if (match) {
            nextId = match.id;
          } else {
            toast.error(`Unknown @conn "${connectionHint}"`);
          }
        }
        if (nextId && !listed.some((item) => item.id === nextId)) {
          nextId = listed[0]?.id ?? null;
        }
        if (!nextId) {
          nextId = listed[0]?.id ?? null;
        }
        setSelectedId(nextId);
        if (nextId) {
          await rpc.call("setActiveConnection", { id: nextId });
        }
        await rpc.call("setDraftSql", { sql: content, autoRun: false });
        setReady(true);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, rpc, source.environmentId, source.kind, source.projectId, source.threadId]);

  async function selectConnection(id: string) {
    setSelectedId(id);
    try {
      await rpc.call("setActiveConnection", { id });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function pushToQuery(autoRun: boolean) {
    try {
      if (selectedId) {
        await rpc.call("setActiveConnection", { id: selectedId });
      }
      await rpc.call("setDraftSql", { sql: localSql, autoRun });
      toast.success(autoRun ? "Sent to Query (auto-run)" : "Sent to Query tab");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void pushToQuery(true);
    }
  }

  if (loading) {
    return (
      <div className="p-4 text-sm text-muted-foreground">Loading {label}…</div>
    );
  }

  if (error) {
    return (
      <div className="space-y-2 p-4 text-sm">
        <p className="text-red-600 dark:text-red-400">{error}</p>
        <p className="text-muted-foreground">Path: {path}</p>
      </div>
    );
  }

  if (ready) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          <span className="truncate font-mono">{label}</span>
          <div className="flex flex-wrap items-center gap-1">
            <select
              className="max-w-[12rem] truncate rounded border border-border bg-transparent px-2 py-1 text-xs"
              value={selectedId ?? ""}
              aria-label="Connection for this SQL file"
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
            <Button size="sm" variant="outline" onClick={() => void pushToQuery(false)}>
              Sync editor
            </Button>
            <Button
              size="sm"
              disabled={!selectedId}
              onClick={() => void pushToQuery(true)}
            >
              Run file
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1">
          <SqlQueryWorkspace />
        </div>
        <details className="border-t border-border">
          <summary className="cursor-pointer px-3 py-1.5 text-xs text-muted-foreground">
            Raw file
          </summary>
          <textarea
            className="max-h-40 w-full resize-y bg-transparent px-3 py-2 font-mono text-xs outline-none"
            value={localSql}
            onChange={(event) => setLocalSql(event.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
          />
        </details>
      </div>
    );
  }

  return null;
}
