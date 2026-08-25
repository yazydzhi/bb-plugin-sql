import type { ConnStatus } from "./types";

export function StatusDot({ status }: { status: ConnStatus }) {
  const color =
    status === "online"
      ? "bg-emerald-500"
      : status === "offline"
        ? "bg-red-500"
        : status === "disconnected"
          ? "bg-muted-foreground/50"
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

export function StatusLabel({
  status,
  error,
}: {
  status: ConnStatus;
  error: string | null;
}) {
  if (status === "checking") {
    return <span>Connecting…</span>;
  }
  if (status === "online") {
    return <span className="text-emerald-600 dark:text-emerald-400">Connected</span>;
  }
  if (status === "disconnected") {
    return <span className="text-muted-foreground">Disconnected</span>;
  }
  if (status === "offline") {
    return (
      <span className="text-red-600 dark:text-red-400">
        Offline{error ? `: ${error}` : ""}
      </span>
    );
  }
  return <span>Not connected</span>;
}
