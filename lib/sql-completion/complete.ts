/**
 * Сбор и ранжирование кандидатов автодополнения.
 */

import { analyzeCompletionContext } from "./context.js";
import { SQL_KEYWORDS } from "./keywords.js";
import { rankCompletionItems } from "./rank.js";
import type {
  CompletionItem,
  CompletionUsage,
  SchemaCatalog,
} from "./types.js";

export type CompleteSqlOptions = {
  sql: string;
  cursor: number;
  catalog: SchemaCatalog | null;
  usages?: CompletionUsage[];
  limit?: number;
  nowMs?: number;
};

function tableKey(schema: string, name: string): string {
  return `table:${schema}.${name}`;
}

function columnKey(schema: string, table: string, name: string): string {
  return `column:${schema}.${table}.${name}`;
}

function keywordItems(): Omit<CompletionItem, "score">[] {
  return SQL_KEYWORDS.map((kw) => ({
    label: kw,
    kind: "keyword" as const,
    insertText: kw,
    detail: "keyword",
    usageKey: `keyword:${kw}`,
  }));
}

function allTables(catalog: SchemaCatalog): Omit<CompletionItem, "score">[] {
  return catalog.tables.map((table) => ({
    label: table.name,
    kind: "table" as const,
    insertText: table.name,
    detail: `${table.schema}.${table.name} (${table.type})`,
    usageKey: tableKey(table.schema, table.name),
  }));
}

function schemaItems(catalog: SchemaCatalog): Omit<CompletionItem, "score">[] {
  return catalog.schemas.map((schema) => ({
    label: schema,
    kind: "schema" as const,
    insertText: schema,
    detail: "schema",
    usageKey: `schema:${schema}`,
  }));
}

function resolveRelation(
  catalog: SchemaCatalog,
  schema: string | null,
  name: string,
) {
  const lower = name.toLowerCase();
  return catalog.tables.find((table) => {
    if (table.name.toLowerCase() !== lower) {
      return false;
    }
    if (schema && table.schema.toLowerCase() !== schema.toLowerCase()) {
      return false;
    }
    return true;
  });
}

function columnsForRelations(
  catalog: SchemaCatalog,
  relations: { schema: string | null; table: string }[],
): Omit<CompletionItem, "score">[] {
  const items: Omit<CompletionItem, "score">[] = [];
  const seen = new Set<string>();
  for (const rel of relations) {
    const table = resolveRelation(catalog, rel.schema, rel.table);
    if (!table) {
      continue;
    }
    for (const column of table.columns) {
      const key = columnKey(table.schema, table.name, column.name);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      items.push({
        label: column.name,
        kind: "column",
        insertText: column.name,
        detail: `${column.dataType}${column.isNullable ? "" : " not null"} · ${table.schema}.${table.name}`,
        usageKey: key,
      });
    }
  }
  return items;
}

/**
 * Возвращает отсортированный список подсказок для позиции курсора.
 */
export function completeSql(options: CompleteSqlOptions): CompletionItem[] {
  const ctx = analyzeCompletionContext(options.sql, options.cursor);
  const catalog = options.catalog;
  const raw: Omit<CompletionItem, "score">[] = [];

  if (ctx.slot === "none") {
    return [];
  }

  if (catalog && ctx.qualifierRelation) {
    const aliasHit = ctx.aliases[ctx.qualifierRelation.toLowerCase()];
    if (aliasHit) {
      raw.push(...columnsForRelations(catalog, [aliasHit]));
    } else if (ctx.qualifierSchema) {
      const table = resolveRelation(
        catalog,
        ctx.qualifierSchema,
        ctx.qualifierRelation,
      );
      if (table) {
        raw.push(
          ...columnsForRelations(catalog, [
            { schema: table.schema, table: table.name },
          ]),
        );
      }
    } else {
      const asTable = resolveRelation(catalog, null, ctx.qualifierRelation);
      if (asTable) {
        raw.push(
          ...columnsForRelations(catalog, [
            { schema: asTable.schema, table: asTable.name },
          ]),
        );
      } else {
        // Возможно это schema. — тогда таблицы схемы.
        const schemaName = ctx.qualifierRelation;
        const tables = catalog.tables.filter(
          (table) => table.schema.toLowerCase() === schemaName.toLowerCase(),
        );
        for (const table of tables) {
          raw.push({
            label: table.name,
            kind: "table",
            insertText: table.name,
            detail: `${table.schema}.${table.name}`,
            usageKey: tableKey(table.schema, table.name),
          });
        }
      }
    }
  } else if (ctx.slot === "table") {
    if (catalog) {
      raw.push(...allTables(catalog), ...schemaItems(catalog));
    }
    raw.push(...keywordItems());
  } else if (ctx.slot === "column") {
    if (catalog) {
      if (ctx.fromRelations.length > 0) {
        raw.push(
          ...columnsForRelations(
            catalog,
            ctx.fromRelations.map((rel) => ({
              schema: rel.schema,
              table: rel.table,
            })),
          ),
        );
      } else {
        // Нет FROM — предлагаем все колонки + таблицы (часто печатают SELECT * FROM…).
        for (const table of catalog.tables) {
          raw.push(
            ...columnsForRelations(catalog, [
              { schema: table.schema, table: table.name },
            ]),
          );
        }
        raw.push(...allTables(catalog));
      }
    }
    raw.push(...keywordItems());
  } else {
    // keyword_or_any
    raw.push(...keywordItems());
    if (catalog) {
      raw.push(...allTables(catalog), ...schemaItems(catalog));
    }
  }

  const ranked = rankCompletionItems(
    raw,
    ctx.prefix,
    options.usages ?? [],
    options.nowMs,
  );
  const limit = options.limit ?? 50;
  return ranked.slice(0, limit);
}

export { analyzeCompletionContext } from "./context.js";
export { rankCompletionItems, matchScore } from "./rank.js";
export type * from "./types.js";
