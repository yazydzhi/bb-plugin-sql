/**
 * Разбиение SQL на statements по `;` с учётом строк, комментариев и dollar-quote.
 */

export type SqlStatementRange = {
  /** Индекс начала (включительно), в исходной строке. */
  start: number;
  /** Индекс конца (исключительно), обычно сразу после `;` или EOF. */
  end: number;
  /** Текст statement без обрезки краёв. */
  text: string;
};

/**
 * Возвращает диапазоны statements, разделённых `;` вне строк/комментариев.
 * Пустой ввод → один пустой диапазон [0, 0].
 */
export function splitSqlStatements(source: string): SqlStatementRange[] {
  if (source.length === 0) {
    return [{ start: 0, end: 0, text: "" }];
  }

  const ranges: SqlStatementRange[] = [];
  let statementStart = 0;
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
    if (ch === ";") {
      const end = i + 1;
      ranges.push({
        start: statementStart,
        end,
        text: source.slice(statementStart, end),
      });
      statementStart = end;
      i = end;
      continue;
    }
    i += 1;
  }

  if (statementStart < source.length || ranges.length === 0) {
    ranges.push({
      start: statementStart,
      end: source.length,
      text: source.slice(statementStart),
    });
  } else if (statementStart === source.length && source.endsWith(";")) {
    // Хвостовой пустой statement после финального `;` — чтобы курсор за ним
    // попадал в отдельный диапазон (ниже схлопнем к предыдущему при выборе).
    ranges.push({
      start: statementStart,
      end: source.length,
      text: "",
    });
  }

  return ranges;
}

/** Есть ли больше одного непустого (после trim) statement. */
export function hasMultipleStatements(source: string): boolean {
  let count = 0;
  for (const range of splitSqlStatements(source)) {
    if (range.text.trim().length > 0) {
      count += 1;
      if (count > 1) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Statement под курсором. Если курсор в пустом хвосте после `;` —
 * берём предыдущий непустой.
 */
export function findStatementAtOffset(
  source: string,
  offset: number,
): SqlStatementRange {
  const ranges = splitSqlStatements(source);
  const clamped = Math.max(0, Math.min(offset, source.length));

  let index = ranges.findIndex(
    (range) => clamped >= range.start && clamped < range.end,
  );
  if (index < 0) {
    // Курсор в самом конце: последний диапазон
    index = ranges.length - 1;
  }

  const current = ranges[index]!;
  if (current.text.trim().length > 0) {
    return current;
  }

  for (let i = index - 1; i >= 0; i -= 1) {
    const prev = ranges[i]!;
    if (prev.text.trim().length > 0) {
      return prev;
    }
  }
  for (let i = index + 1; i < ranges.length; i += 1) {
    const next = ranges[i]!;
    if (next.text.trim().length > 0) {
      return next;
    }
  }
  return current;
}

/**
 * Что запускать: выделение, иначе активный statement при multi, иначе весь текст.
 * Несколько statements в выделении → массив по порядку (каждый отдельный Run).
 */
export function resolveExecutableStatements(
  source: string,
  selectionStart: number,
  selectionEnd: number,
): string[] {
  const from = Math.min(selectionStart, selectionEnd);
  const to = Math.max(selectionStart, selectionEnd);
  if (from !== to) {
    const selected = source.slice(from, to);
    const parts = splitSqlStatements(selected)
      .map((range) => range.text.trim())
      .filter((text) => text.length > 0);
    return parts.length > 0 ? parts : [selected];
  }
  if (!hasMultipleStatements(source)) {
    return [source];
  }
  return [findStatementAtOffset(source, from).text];
}

/**
 * Первый (или единственный) executable-фрагмент — для простых вызовов.
 */
export function resolveExecutableSql(
  source: string,
  selectionStart: number,
  selectionEnd: number,
): string {
  const parts = resolveExecutableStatements(source, selectionStart, selectionEnd);
  return parts[0] ?? "";
}

/**
 * Диапазон для фоновой подсветки при нескольких statements:
 * selection, иначе statement под курсором; иначе null.
 */
export function resolveActiveHighlightRange(
  source: string,
  selectionStart: number,
  selectionEnd: number,
): { start: number; end: number } | null {
  if (!hasMultipleStatements(source)) {
    return null;
  }
  const from = Math.min(selectionStart, selectionEnd);
  const to = Math.max(selectionStart, selectionEnd);
  if (from !== to) {
    return { start: from, end: to };
  }
  const statement = findStatementAtOffset(source, from);
  if (statement.text.trim().length === 0) {
    return null;
  }
  return { start: statement.start, end: statement.end };
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

/**
 * Postgres dollar-quote: $tag$…$tag$ или $$…$$.
 * Возвращает индекс после закрывающего тега или null, если это не dollar-quote.
 */
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
    if (!/[A-Za-z0-9_]/.test(ch)) {
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
