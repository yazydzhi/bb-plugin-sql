// bb-plugin-sql — UI slots: nav explorer + query (fixed tab / Actions) + .sql opener.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { SqlExplorer } from "@/components/sql/SqlExplorer";
import { SqlFileOpener } from "@/components/sql/SqlFileOpener";
import { SqlQueryWorkspace } from "@/components/sql/SqlQueryWorkspace";

function SqlExplorerPage() {
  return <SqlExplorer />;
}

function SqlQueryPage() {
  return <SqlQueryWorkspace />;
}

function SqlThreadQueryPanel() {
  return <SqlQueryWorkspace />;
}

const queryActionRegistration = {
  id: "sql",
  title: "SQL",
  icon: "Database",
  layout: "flush" as const,
  component: SqlThreadQueryPanel,
};

export default definePluginApp((app) => {
  // Левая навигация приложения: connections + schema tree
  app.slots.navPanel({
    id: "sql",
    title: "SQL",
    icon: "Database",
    path: "sql",
    component: SqlExplorerPage,
    fixedTabs: [
      {
        panelId: "sql",
        id: "query",
        title: "Query",
        icon: "Terminal",
        layout: "flush",
        component: SqlQueryPage,
      },
    ],
  });

  // Правая панель треда / New thread → Actions → SQL (только query)
  app.slots.threadPanelAction(queryActionRegistration);
  app.slots.experimental_newThreadPanelAction(queryActionRegistration);

  // Открытие .sql файлов
  app.slots.fileOpener({
    id: "sql-file",
    title: "SQL",
    extensions: ["sql"],
    component: SqlFileOpener,
  });
});
