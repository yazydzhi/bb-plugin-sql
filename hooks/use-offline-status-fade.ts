import { useEffect, type Dispatch, type SetStateAction } from "react";
import {
  OFFLINE_FADE_MS,
  makeStatusEntry,
  type ConnectionStatusEntry,
} from "@/components/sql/types";

/**
 * Через OFFLINE_FADE_MS красный offline → серый disconnected.
 */
export function useOfflineStatusFade(
  statusById: Record<string, ConnectionStatusEntry>,
  setStatusById: Dispatch<SetStateAction<Record<string, ConnectionStatusEntry>>>,
) {
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const now = Date.now();
    for (const [connectionId, entry] of Object.entries(statusById)) {
      if (entry.status !== "offline") {
        continue;
      }
      const startedAt = entry.offlineAt ?? now;
      const remaining = Math.max(0, OFFLINE_FADE_MS - (now - startedAt));
      timers.push(
        setTimeout(() => {
          setStatusById((current) => {
            if (current[connectionId]?.status !== "offline") {
              return current;
            }
            return {
              ...current,
              [connectionId]: makeStatusEntry("disconnected"),
            };
          });
        }, remaining),
      );
    }
    return () => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
    };
  }, [setStatusById, statusById]);
}
