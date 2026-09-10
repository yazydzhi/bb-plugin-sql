/**
 * Лёгкая подсветка SQL для overlay-редактора (без Monaco/CodeMirror).
 * Экранирует HTML и раскрашивает ключевые слова, строки, комментарии, числа.
 */

const SQL_KEYWORDS = new Set(
  [
    "abort",
    "add",
    "all",
    "alter",
    "analyze",
    "and",
    "any",
    "as",
    "asc",
    "begin",
    "between",
    "by",
    "cascade",
    "case",
    "cast",
    "check",
    "column",
    "commit",
    "constraint",
    "create",
    "cross",
    "current",
    "default",
    "delete",
    "desc",
    "distinct",
    "do",
    "drop",
    "else",
    "end",
    "except",
    "exists",
    "explain",
    "false",
    "fetch",
    "for",
    "foreign",
    "from",
    "full",
    "grant",
    "group",
    "having",
    "if",
    "ilike",
    "in",
    "index",
    "inner",
    "insert",
    "intersect",
    "into",
    "is",
    "isnull",
    "join",
    "key",
    "lateral",
    "left",
    "like",
    "limit",
    "not",
    "null",
    "nulls",
    "offset",
    "on",
    "only",
    "or",
    "order",
    "outer",
    "over",
    "partition",
    "primary",
    "references",
    "returning",
    "right",
    "rollback",
    "row",
    "rows",
    "select",
    "set",
    "table",
    "then",
    "to",
    "true",
    "truncate",
    "union",
    "unique",
    "update",
    "using",
    "values",
    "view",
    "when",
    "where",
    "with",
  ].map((word) => word.toUpperCase()),
);

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wrapToken(className: string, text: string): string {
  return `<span class="${className}">${escapeHtml(text)}</span>`;
}

/**
 * Возвращает HTML с подсветкой; пустой ввод → неразрывный пробел, чтобы блок
 * сохранял высоту строки.
 */
export function highlightSql(source: string): string {
  if (!source) {
    return "&nbsp;";
  }

  const tokenPattern =
    /(\/\*[\s\S]*?\*\/)|(--[^\n]*)|('(?:''|[^'])*')|("(?:""|[^"])*")|(`(?:``|[^`])*`)|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_][\w$]*\b)|(\s+)|([^\w\s])/g;

  let html = "";
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(source)) !== null) {
    const [
      full,
      blockComment,
      lineComment,
      singleString,
      doubleString,
      backtickString,
      numberLiteral,
      ident,
      whitespace,
      punct,
    ] = match;

    if (blockComment || lineComment) {
      html += wrapToken("sql-tok-comment", full);
    } else if (singleString || doubleString || backtickString) {
      html += wrapToken("sql-tok-string", full);
    } else if (numberLiteral) {
      html += wrapToken("sql-tok-number", full);
    } else if (ident) {
      if (SQL_KEYWORDS.has(ident.toUpperCase())) {
        html += wrapToken("sql-tok-keyword", ident);
      } else {
        html += wrapToken("sql-tok-ident", ident);
      }
    } else if (whitespace) {
      html += escapeHtml(whitespace);
    } else if (punct) {
      html += wrapToken("sql-tok-punct", punct);
    } else {
      html += escapeHtml(full);
    }
  }

  // Завершающий перевод строки нужен, чтобы pre и textarea совпадали по высоте.
  if (source.endsWith("\n")) {
    html += "&nbsp;";
  }
  return html;
}
