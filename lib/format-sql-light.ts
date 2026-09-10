/**
 * Лёгкое форматирование SQL: ключевые слова в UPPER, переносы вокруг FROM/WHERE/…
 * Не парсер — эвристика для читаемости черновиков.
 */

const KEYWORDS = [
  "select",
  "from",
  "where",
  "and",
  "or",
  "not",
  "in",
  "is",
  "null",
  "join",
  "left",
  "right",
  "inner",
  "outer",
  "full",
  "cross",
  "on",
  "as",
  "order",
  "by",
  "group",
  "having",
  "limit",
  "offset",
  "insert",
  "into",
  "values",
  "update",
  "set",
  "delete",
  "with",
  "union",
  "all",
  "distinct",
  "case",
  "when",
  "then",
  "else",
  "end",
  "returning",
  "exists",
  "between",
  "like",
  "ilike",
  "true",
  "false",
];

const BREAK_BEFORE = new Set([
  "FROM",
  "WHERE",
  "JOIN",
  "LEFT",
  "RIGHT",
  "INNER",
  "OUTER",
  "FULL",
  "CROSS",
  "GROUP",
  "ORDER",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "UNION",
  "VALUES",
  "SET",
  "RETURNING",
]);

/**
 * @returns отформатированный текст (или исходный, если пустой)
 */
export function formatSqlLight(sql: string): string {
  const trimmed = sql.trim();
  if (!trimmed) {
    return sql;
  }

  const keywordSet = new Set(KEYWORDS);
  const tokens = trimmed.split(/(\s+|('[^']*')|("[^"]*")|(`[^`]*`)|(--[^\n]*)|(\/\*[\s\S]*?\*\/))/);

  const uppercased = tokens.map((token) => {
    if (!token || /^\s+$/.test(token)) {
      return token;
    }
    if (
      token.startsWith("'") ||
      token.startsWith('"') ||
      token.startsWith("`") ||
      token.startsWith("--") ||
      token.startsWith("/*")
    ) {
      return token;
    }
    const lower = token.toLowerCase();
    if (keywordSet.has(lower)) {
      return lower.toUpperCase();
    }
    return token;
  });

  let joined = uppercased.join("").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();

  // Переносы перед основными клаузами (простая эвристика по словам).
  const parts = joined.split(/(\s+)/);
  const out: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (BREAK_BEFORE.has(part) && out.length > 0) {
      // Не дублировать перевод строки.
      const prev = out[out.length - 1];
      if (prev && !prev.endsWith("\n")) {
        out.push("\n");
      }
    }
    out.push(part === " " || part === "\t" ? (out[out.length - 1] === "\n" ? "" : part) : part);
  }

  return out.join("").replace(/\n{3,}/g, "\n\n").trim() + (sql.endsWith("\n") ? "\n" : "");
}
