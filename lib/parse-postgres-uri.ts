/**
 * Разбор postgresql:// / postgres:// URI в поля формы подключения.
 */

export type ParsedPostgresUri = {
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
};

/**
 * @returns null, если строка не похожа на Postgres URI
 */
export function parsePostgresUri(raw: string): ParsedPostgresUri | null {
  const trimmed = raw.trim();
  if (!/^postgres(ql)?:\/\//i.test(trimmed)) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    return null;
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const sslMode = (url.searchParams.get("sslmode") ?? "").toLowerCase();
  const ssl =
    sslMode === "require" ||
    sslMode === "verify-ca" ||
    sslMode === "verify-full" ||
    url.searchParams.get("ssl") === "true";

  const port = url.port || "5432";
  const host = url.hostname || "localhost";

  return {
    host,
    port,
    database: database || "postgres",
    user: decodeURIComponent(url.username || "postgres"),
    password: decodeURIComponent(url.password || ""),
    ssl,
  };
}
