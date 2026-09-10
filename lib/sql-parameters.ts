/**
 * Именованные параметры `:name` в SQL (не путать с Postgres `::cast`).
 * Пропуск строк, комментариев и dollar-quote.
 */

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*/;

export type SqlParamMatch = {
  name: string;
  start: number;
  end: number;
};

/**
 * Все вхождения `:name` вне строк/комментариев; `::type` не считается.
 */
export function findSqlParamMatches(source: string): SqlParamMatch[] {
  const matches: SqlParamMatch[] = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "-" && next === "-") {
      i = skipLineComment(source, i);
      continue;
    }
    if (ch === "/" && next === "*") {
      i = skipBlockComment(source, i);
      continue;
    }
    if (ch === "'") {
      i = skipSingleQuoted(source, i);
      continue;
    }
    if (ch === '"') {
      i = skipDoubleQuoted(source, i);
      continue;
    }
    if (ch === "`") {
      i = skipBacktickQuoted(source, i);
      continue;
    }
    if (ch === "$") {
      const dollarEnd = trySkipDollarQuoted(source, i);
      if (dollarEnd !== null) {
        i = dollarEnd;
        continue;
      }
    }
    if (ch === ":") {
      // Postgres cast `::type` — пропускаем оба двоеточия
      if (next === ":") {
        i += 2;
        continue;
      }
      const nameMatch = PARAM_NAME.exec(source.slice(i + 1));
      if (nameMatch) {
        const name = nameMatch[0];
        matches.push({
          name,
          start: i,
          end: i + 1 + name.length,
        });
        i += 1 + name.length;
        continue;
      }
    }
    i += 1;
  }

  return matches;
}

/** Уникальные имена параметров в порядке первого появления. */
export function extractSqlParamNames(source: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const match of findSqlParamMatches(source)) {
    if (seen.has(match.name)) {
      continue;
    }
    seen.add(match.name);
    names.push(match.name);
  }
  return names;
}

/** Уникальные имена по нескольким statements. */
export function extractSqlParamNamesFromQueries(queries: string[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const query of queries) {
    for (const name of extractSqlParamNames(query)) {
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/**
 * Значение из промпта → SQL-литерал.
 * null/NULL → NULL; true/false → bool; число → as-is; иначе quoted string.
 */
export function formatSqlParamLiteral(raw: string): string {
  const trimmed = raw.trim();
  if (/^null$/i.test(trimmed)) {
    return "NULL";
  }
  if (/^(true|false)$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)) {
    return trimmed;
  }
  return `'${trimmed.replace(/'/g, "''")}'`;
}

/**
 * Подставляет значения `:name`. Неизвестный параметр → ошибка.
 */
export function applySqlParams(
  source: string,
  values: Record<string, string>,
): string {
  const matches = findSqlParamMatches(source);
  if (matches.length === 0) {
    return source;
  }

  let out = "";
  let cursor = 0;
  for (const match of matches) {
    if (!(match.name in values)) {
      throw new Error(`Missing value for :${match.name}`);
    }
    out += source.slice(cursor, match.start);
    out += formatSqlParamLiteral(values[match.name]!);
    cursor = match.end;
  }
  out += source.slice(cursor);
  return out;
}

/** Есть ли хотя бы один `:name` в тексте. */
export function hasSqlParams(source: string): boolean {
  return extractSqlParamNames(source).length > 0;
}

function skipLineComment(source: string, start: number): number {
  let i = start + 2;
  while (i < source.length && source[i] !== "\n") {
    i += 1;
  }
  return i;
}

function skipBlockComment(source: string, start: number): number {
  let i = start + 2;
  while (i < source.length - 1) {
    if (source[i] === "*" && source[i + 1] === "/") {
      return i + 2;
    }
    i += 1;
  }
  return source.length;
}

function skipSingleQuoted(source: string, start: number): number {
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "'") {
      if (source[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return source.length;
}

function skipDoubleQuoted(source: string, start: number): number {
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === '"') {
      if (source[i + 1] === '"') {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return source.length;
}

function skipBacktickQuoted(source: string, start: number): number {
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "`") {
      if (source[i + 1] === "`") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return source.length;
}

function trySkipDollarQuoted(source: string, start: number): number | null {
  if (source[start] !== "$") {
    return null;
  }
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "$") {
      break;
    }
    if (!/[A-Za-z0-9_]/.test(ch!)) {
      return null;
    }
    i += 1;
  }
  if (i >= source.length || source[i] !== "$") {
    return null;
  }
  const tag = source.slice(start, i + 1);
  const contentStart = i + 1;
  const closeAt = source.indexOf(tag, contentStart);
  if (closeAt < 0) {
    return source.length;
  }
  return closeAt + tag.length;
}
