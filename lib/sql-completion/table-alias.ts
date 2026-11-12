/**
 * Короткие SQL-alias для имён таблиц: trade → t, trade_role_person → trp.
 */

const RESERVED_ALIASES = new Set(
  [
    "on",
    "as",
    "join",
    "left",
    "right",
    "inner",
    "outer",
    "cross",
    "full",
    "where",
    "group",
    "order",
    "limit",
    "offset",
    "having",
    "union",
    "except",
    "intersect",
    "and",
    "or",
    "not",
    "in",
    "is",
    "null",
    "true",
    "false",
    "select",
    "from",
    "into",
    "update",
    "set",
    "using",
    "natural",
    "lateral",
    "only",
    "tablesample",
  ].map((word) => word.toLowerCase()),
);

/**
 * Разбивает имя таблицы на слова (snake_case / camelCase / kebab).
 */
export function splitTableNameParts(tableName: string): string[] {
  const normalized = tableName.replace(/-/g, "_");
  const snakeParts = normalized.split("_").filter(Boolean);
  if (snakeParts.length > 1) {
    return snakeParts;
  }
  const camel = normalized.match(/[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])/g);
  if (camel && camel.length > 1) {
    return camel;
  }
  return [normalized];
}

/**
 * Предпочтительный короткий alias без учёта занятости.
 */
export function preferredTableAlias(tableName: string): string {
  const parts = splitTableNameParts(tableName);
  if (parts.length >= 2) {
    return parts
      .map((part) => part[0] ?? "")
      .join("")
      .toLowerCase();
  }
  const single = parts[0] ?? tableName;
  return (single[0] ?? "t").toLowerCase();
}

/**
 * Выдаёт свободный alias: trp, trp2, … с учётом уже занятых в запросе.
 */
export function allocateTableAlias(
  tableName: string,
  usedAliases: Iterable<string>,
): string {
  const used = new Set(
    [...usedAliases].map((alias) => alias.toLowerCase()).filter(Boolean),
  );
  const base = preferredTableAlias(tableName) || "t";
  let candidate = base;
  let n = 2;
  while (used.has(candidate) || RESERVED_ALIASES.has(candidate)) {
    candidate = `${base}${n}`;
    n += 1;
  }
  return candidate;
}
