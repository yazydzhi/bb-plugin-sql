import fs from "node:fs";
import path from "node:path";

/**
 * Хранилище паролей коннектов: JSON-файл 0600 рядом с data.db плагина,
 * не в SQLite и не на фронтенд.
 *
 * Пустая строка — валидный сохранённый пароль (trust/peer auth).
 * Отсутствие ключа = пароль не сохранён (нужен ввод при Connect).
 */

type PasswordMap = Record<string, string>;

function ensureSecretsDir(pluginDataDir: string): string {
  const dir = path.join(pluginDataDir, "secrets");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // ignore chmod failures on exotic FS
  }
  return dir;
}

function passwordsFilePath(pluginDataDir: string): string {
  return path.join(ensureSecretsDir(pluginDataDir), "passwords.json");
}

function readMap(pluginDataDir: string): PasswordMap {
  const filePath = passwordsFilePath(pluginDataDir);
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: PasswordMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeMap(pluginDataDir: string, map: PasswordMap): void {
  const filePath = passwordsFilePath(pluginDataDir);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(map, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(tmpPath, 0o600);
  } catch {
    // ignore
  }
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // ignore
  }
}

/** Каталог данных плагина: `<dataDir>/plugins/<id>`. */
export function resolvePluginDataDir(serverDataDir: string, pluginId: string): string {
  return path.join(serverDataDir, "plugins", pluginId);
}

export function getConnectionPassword(
  pluginDataDir: string,
  connectionId: string,
): string | undefined {
  const map = readMap(pluginDataDir);
  return Object.prototype.hasOwnProperty.call(map, connectionId)
    ? map[connectionId]
    : undefined;
}

export function hasConnectionPassword(
  pluginDataDir: string,
  connectionId: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(readMap(pluginDataDir), connectionId);
}

export function setConnectionPassword(
  pluginDataDir: string,
  connectionId: string,
  password: string,
): void {
  const map = readMap(pluginDataDir);
  map[connectionId] = password;
  writeMap(pluginDataDir, map);
}

export function deleteConnectionPassword(
  pluginDataDir: string,
  connectionId: string,
): void {
  const map = readMap(pluginDataDir);
  if (!Object.prototype.hasOwnProperty.call(map, connectionId)) {
    return;
  }
  delete map[connectionId];
  writeMap(pluginDataDir, map);
}
