/**
 * RPC из non-React колбэков (messageAction и т.п.) — как у builtin side-chat.
 */
export async function callSqlPluginRpc(
  method: string,
  input: unknown = null,
): Promise<unknown> {
  const response = await fetch(
    `/api/v1/plugins/sql/rpc/${encodeURIComponent(method)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean;
    result?: unknown;
    error?: { message?: string } | null;
  } | null;
  if (!response.ok || payload?.ok !== true) {
    const message =
      typeof payload?.error === "object" &&
      payload.error !== null &&
      typeof payload.error.message === "string"
        ? payload.error.message
        : `rpc "${method}" failed (HTTP ${response.status})`;
    throw new Error(message);
  }
  return payload.result;
}
