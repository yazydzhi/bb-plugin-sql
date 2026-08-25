/** Общие типы UI SQL-плагина. */
export type PublicConnection = {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  ssl: boolean;
  createdAt: string;
};

/** Элемент списка connections с флагом живого пула. */
export type ConnectionListItem = PublicConnection & {
  connected: boolean;
};

export type ConnStatus = "idle" | "disconnected" | "checking" | "online" | "offline";

/** Режим сортировки списка подключений. */
export type ConnectionSortMode = "asc" | "desc" | "free";

/** Через сколько мс красный offline снова становится серым. */
export const OFFLINE_FADE_MS = 30_000;

export type ConnectionStatusEntry = {
  status: ConnStatus;
  error: string | null;
  /** Когда статус стал offline — для автосброса в серый. */
  offlineAt?: number;
};

export function makeStatusEntry(
  status: ConnStatus,
  error: string | null = null,
): ConnectionStatusEntry {
  return {
    status,
    error,
    offlineAt: status === "offline" ? Date.now() : undefined,
  };
}

export function mergeConnectionStatuses(
  prev: Record<string, ConnectionStatusEntry>,
  items: ConnectionListItem[],
): Record<string, ConnectionStatusEntry> {
  const next = { ...prev };
  for (const item of items) {
    if (item.connected) {
      next[item.id] = makeStatusEntry("online");
      continue;
    }
    const current = next[item.id];
    if (
      !current ||
      current.status === "online" ||
      current.status === "checking"
    ) {
      next[item.id] = makeStatusEntry("disconnected");
    }
  }
  return next;
}

export function connectionStatusFromMap(
  statusById: Record<string, ConnectionStatusEntry>,
  connectionId: string,
): ConnStatus {
  return statusById[connectionId]?.status ?? "disconnected";
}

export function connectionErrorFromMap(
  statusById: Record<string, ConnectionStatusEntry>,
  connectionId: string,
): string | null {
  return statusById[connectionId]?.error ?? null;
}

export type QueryResult = {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  durationMs: number;
  truncated: boolean;
};

export type ConnectionForm = {
  name: string;
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
};

export type ResultTab = {
  id: string;
  title: string;
  sql: string;
  connectionName: string;
  result: QueryResult;
  createdAt: number;
};

export type HistoryItem = {
  id: string;
  connectionId: string;
  connectionName: string;
  sql: string;
  createdAt: string;
};

export function emptyForm(): ConnectionForm {
  return {
    name: "",
    host: "localhost",
    port: "5432",
    database: "postgres",
    user: "postgres",
    password: "",
    ssl: false,
  };
}

export function quoteIdent(ident: string): string {
  return `"${ident.replaceAll('"', '""')}"`;
}
