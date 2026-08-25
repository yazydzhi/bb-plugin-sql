/**
 * Извлекает `-- @conn Name` из первых строк SQL-файла.
 */
export function parseConnHint(content: string): string | null {
  for (const line of content.split(/\r?\n/).slice(0, 20)) {
    const match = /^\s*--\s*@conn\s+(.+?)\s*$/i.exec(line);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return null;
}
