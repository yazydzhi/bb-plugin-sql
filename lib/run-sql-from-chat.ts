import { toast } from "sonner";
import { extractSqlFromChat } from "./extract-sql-from-chat";
import { parseConnHint } from "./parse-conn-hint";
import { callSqlPluginRpc } from "./plugin-rpc";

type ListedConnection = {
  id: string;
  name: string;
};

type OpenPanel = (options: {
  actionId: string;
  title?: string;
}) => boolean;

/**
 * Run from chat: SQL → выбрать connection → draft + autoRun → SQL panel.
 */
export async function runSqlFromChat(options: {
  selectedText?: string;
  messageText: string;
  openPanel: OpenPanel;
}): Promise<void> {
  const sql = extractSqlFromChat(options.selectedText, options.messageText);
  if (!sql) {
    toast.error("No SQL found — select a query or use a ```sql fence");
    return;
  }

  const listed = (await callSqlPluginRpc("listConnections", null)) as {
    connections: ListedConnection[];
  };
  const connections = listed.connections;
  if (connections.length === 0) {
    toast.error("No SQL connections configured");
    return;
  }

  const ui = (await callSqlPluginRpc("getUiState", null)) as {
    activeConnectionId: string | null;
  };

  let connectionId: string | null = null;
  const hint = parseConnHint(sql);
  if (hint) {
    const byHint = connections.find(
      (item) => item.name === hint || item.id === hint,
    );
    if (!byHint) {
      toast.error(`Unknown @conn "${hint}"`);
      return;
    }
    connectionId = byHint.id;
  } else if (connections.length === 1) {
    connectionId = connections[0].id;
  } else {
    const preferred =
      connections.find((item) => item.id === ui.activeConnectionId) ??
      connections[0];
    const names = connections.map((item) => item.name).join(", ");
    const chosen = window.prompt(
      `Run SQL on which connection?\n${names}`,
      preferred.name,
    );
    if (chosen === null) {
      return;
    }
    const match = connections.find(
      (item) =>
        item.name === chosen.trim() || item.id === chosen.trim(),
    );
    if (!match) {
      toast.error(`Unknown connection "${chosen.trim()}"`);
      return;
    }
    connectionId = match.id;
  }

  await callSqlPluginRpc("setActiveConnection", { id: connectionId });
  await callSqlPluginRpc("setDraftSql", { sql, autoRun: true });

  const opened = options.openPanel({ actionId: "sql", title: "SQL" });
  if (!opened) {
    toast.error("Could not open the SQL panel");
    return;
  }
  toast.success("Running SQL…");
}
