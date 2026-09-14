/**
 * Определение слота автодополнения и alias/FROM scope по тексту до курсора.
 */

import { findStatementAtOffset } from "../sql-statements.js";
import type { CompletionContext, CompletionSlot } from "./types.js";

function stripTrailingIncompleteIdent(before: string): {
  stem: string;
  prefix: string;
  prefixStartInBefore: number;
} {
  const match = before.match(/([A-Za-z_\u0080-\uFFFF][\w$]*)$/);
  if (!match) {
    return { stem: before, prefix: "", prefixStartInBefore: before.length };
  }
  const prefix = match[1] ?? "";
  const prefixStartInBefore = before.length - prefix.length;
  return {
    stem: before.slice(0, prefixStartInBefore),
    prefix,
    prefixStartInBefore,
  };
}

/**
 * Разбирает `schema.` / `rel.` непосредственно перед префиксом.
 */
function parseQualifier(stem: string): {
  cleanStem: string;
  schema: string | null;
  relation: string | null;
} {
  const trimmed = stem.replace(/\s+$/u, "");
  const double = trimmed.match(
    /("?[A-Za-z_\u0080-\uFFFF][\w$]*"?)\s*\.\s*("?[A-Za-z_\u0080-\uFFFF][\w$]*"?)\s*\.\s*$/u,
  );
  if (double && double.index !== undefined) {
    return {
      cleanStem: trimmed.slice(0, double.index),
      schema: unquote(double[1] ?? ""),
      relation: unquote(double[2] ?? ""),
    };
  }
  const single = trimmed.match(
    /("?[A-Za-z_\u0080-\uFFFF][\w$]*"?)\s*\.\s*$/u,
  );
  if (single && single.index !== undefined) {
    return {
      cleanStem: trimmed.slice(0, single.index),
      schema: null,
      relation: unquote(single[1] ?? ""),
    };
  }
  return { cleanStem: trimmed, schema: null, relation: null };
}

function unquote(value: string): string {
  const t = value.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    return t.slice(1, -1);
  }
  return t;
}

type FromRel = {
  schema: string | null;
  table: string;
  alias: string | null;
};

/**
 * Грубый разбор FROM/JOIN … [AS] alias (без подзапросов).
 */
export function parseFromRelations(statement: string): {
  aliases: Record<string, { schema: string | null; table: string }>;
  fromRelations: FromRel[];
} {
  const aliases: Record<string, { schema: string | null; table: string }> = {};
  const fromRelations: FromRel[] = [];
  const clauseRe = /\b(FROM|JOIN)\b/gi;
  const reserved =
    /^(WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|CROSS|ON|USING|GROUP|ORDER|LIMIT|OFFSET|HAVING|UNION|RETURNING|SELECT|SET|AND|OR)$/i;

  let clause: RegExpExecArray | null;
  while ((clause = clauseRe.exec(statement)) !== null) {
    const after = statement.slice(clause.index + clause[0].length);
    const relMatch = after.match(
      /^\s*("?[A-Za-z_\u0080-\uFFFF][\w$]*"?)(?:\s*\.\s*("?[A-Za-z_\u0080-\uFFFF][\w$]*"?))?/u,
    );
    if (!relMatch) {
      continue;
    }
    const first = unquote(relMatch[1] ?? "");
    const second = relMatch[2] ? unquote(relMatch[2]) : null;
    const schema = second ? first : null;
    const table = second ?? first;
    if (!table) {
      continue;
    }

    let alias: string | null = null;
    const rest = after.slice(relMatch[0].length);
    const aliasMatch = rest.match(
      /^\s+(?:AS\s+)?("?[A-Za-z_\u0080-\uFFFF][\w$]*"?)/iu,
    );
    if (aliasMatch) {
      const candidate = unquote(aliasMatch[1] ?? "");
      if (candidate && !reserved.test(candidate)) {
        alias = candidate;
      }
    }

    fromRelations.push({ schema, table, alias });
    if (alias) {
      aliases[alias.toLowerCase()] = { schema, table };
    }
    aliases[table.toLowerCase()] = { schema, table };
  }
  return { aliases, fromRelations };
}

function lastKeyword(stem: string): string | null {
  const tokens = stem.match(/[A-Za-z_\u0080-\uFFFF][\w$]*/g);
  if (!tokens || tokens.length === 0) {
    return null;
  }
  return tokens[tokens.length - 1]?.toUpperCase() ?? null;
}

function detectSlot(stem: string, hasRelationQualifier: boolean): CompletionSlot {
  if (hasRelationQualifier) {
    return "column";
  }
  const kw = lastKeyword(stem);
  if (!kw) {
    return "keyword_or_any";
  }
  if (
    kw === "FROM" ||
    kw === "JOIN" ||
    kw === "INTO" ||
    kw === "UPDATE" ||
    kw === "TABLE"
  ) {
    return "table";
  }
  if (kw === "ON" || kw === "USING") {
    return "column";
  }
  if (
    kw === "SELECT" ||
    kw === "WHERE" ||
    kw === "AND" ||
    kw === "OR" ||
    kw === "SET" ||
    kw === "BY" ||
    kw === "HAVING" ||
    kw === "RETURNING"
  ) {
    return "column";
  }
  return "keyword_or_any";
}

/**
 * Контекст автодополнения в позиции cursor (абсолютный индекс в sql).
 */
export function analyzeCompletionContext(
  sql: string,
  cursor: number,
): CompletionContext {
  const safeCursor = Math.max(0, Math.min(cursor, sql.length));
  const range = findStatementAtOffset(sql, safeCursor);
  const statement = range.text;
  const statementStart = range.start;
  const localCursor = safeCursor - statementStart;
  const before = statement.slice(0, Math.max(0, localCursor));
  const { stem, prefix, prefixStartInBefore } = stripTrailingIncompleteIdent(before);
  const qualifier = parseQualifier(stem);
  const { aliases, fromRelations } = parseFromRelations(statement);
  const slot = detectSlot(
    qualifier.cleanStem,
    qualifier.relation !== null || qualifier.schema !== null,
  );

  return {
    slot,
    prefix,
    prefixStart: statementStart + prefixStartInBefore,
    cursor: safeCursor,
    statement,
    statementStart,
    qualifierSchema: qualifier.schema,
    qualifierRelation: qualifier.relation,
    aliases,
    fromRelations,
  };
}
