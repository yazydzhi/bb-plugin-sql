/**
 * Сбор и ранжирование кандидатов автодополнения.
 */

import { analyzeCompletionContext } from "./context.js";
import { SQL_KEYWORDS } from "./keywords.js";
import { rankCompletionItems } from "./rank.js";
import { allocateTableAlias } from "./table-alias.js";
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

function usedAliasesFromContext(
  aliases: Record<string, unknown>,
  fromRelations: { alias: string | null }[],
  /** Префикс под курсором ещё не занят — пользователь его как раз набирает. */
  editingPrefix?: string,
): Set<string> {
  const used = new Set<string>(
    Object.keys(aliases).map((key) => key.toLowerCase()),
  );
  for (const rel of fromRelations) {
    if (rel.alias) {
      used.add(rel.alias.toLowerCase());
    }
  }
  if (editingPrefix) {
    used.delete(editingPrefix.toLowerCase());
  }
  return used;
}

/**
 * Кандидаты таблиц. В слоте FROM/JOIN — вставка с коротким alias (`trade t`).
 */
function tableItems(
  catalog: SchemaCatalog,
  options: {
    withAlias: boolean;
    usedAliases: Set<string>;
    schemaFilter?: string;
  },
): Omit<CompletionItem, "score">[] {
  const tables = options.schemaFilter
    ? catalog.tables.filter(
        (table) =>
          table.schema.toLowerCase() === options.schemaFilter!.toLowerCase(),
      )
    : catalog.tables;

  return tables.map((table) => {
    if (!options.withAlias) {
      return {
        label: table.name,
        kind: "table" as const,
        insertText: table.name,
        detail: `${table.schema}.${table.name} (${table.type})`,
        usageKey: tableKey(table.schema, table.name),
      };
    }

    const alias = allocateTableAlias(table.name, options.usedAliases);
    const insertText = `${table.name} ${alias}`;
    return {
      label: table.name,
      kind: "table" as const,
      insertText,
      detail: `as ${alias} · ${table.schema}.${table.name}`,
      filterText: `${table.name} ${alias}`,
      usageKey: tableKey(table.schema, table.name),
    };
  });
}

/**
 * Короткие alias как отдельные подсказки (ввод `trp` → trade_role_person trp).
 * Только при непустом префиксе, чтобы не засорять список.
 */
function aliasShortcutItems(
  catalog: SchemaCatalog,
  usedAliases: Set<string>,
  prefix: string,
  schemaFilter?: string,
): Omit<CompletionItem, "score">[] {
  if (!prefix) {
    return [];
  }
  const p = prefix.toLowerCase();
  const tables = schemaFilter
    ? catalog.tables.filter(
        (table) => table.schema.toLowerCase() === schemaFilter.toLowerCase(),
      )
    : catalog.tables;

  const items: Omit<CompletionItem, "score">[] = [];
  for (const table of tables) {
    const alias = allocateTableAlias(table.name, usedAliases);
    if (!alias.startsWith(p)) {
      continue;
    }
    items.push({
      label: alias,
      kind: "alias",
      insertText: `${table.name} ${alias}`,
      detail: `→ ${table.schema}.${table.name}`,
      filterText: `${alias} ${table.name}`,
      usageKey: `alias:${table.schema}.${table.name}:${alias}`,
    });
  }
  return items;
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
  const usedAliases = usedAliasesFromContext(
    ctx.aliases,
    ctx.fromRelations,
    ctx.prefix,
  );

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
        // Возможно это schema. — тогда таблицы схемы (с alias, если слот table).
        const withAlias = ctx.slot === "table";
        raw.push(
          ...tableItems(catalog, {
            withAlias,
            usedAliases,
            schemaFilter: ctx.qualifierRelation,
          }),
        );
        if (withAlias) {
          raw.push(
            ...aliasShortcutItems(
              catalog,
              usedAliases,
              ctx.prefix,
              ctx.qualifierRelation,
            ),
          );
        }
      }
    }
  } else if (ctx.slot === "table") {
    if (catalog) {
      raw.push(
        ...tableItems(catalog, { withAlias: true, usedAliases }),
        ...aliasShortcutItems(catalog, usedAliases, ctx.prefix),
        ...schemaItems(catalog),
      );
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
        // Нет FROM — предлагаем все колонки + таблицы без alias
        // (часто печатают SELECT * FROM…).
        for (const table of catalog.tables) {
          raw.push(
            ...columnsForRelations(catalog, [
              { schema: table.schema, table: table.name },
            ]),
          );
        }
        raw.push(...tableItems(catalog, { withAlias: false, usedAliases }));
      }
    }
    raw.push(...keywordItems());
  } else {
    // keyword_or_any
    raw.push(...keywordItems());
    if (catalog) {
      raw.push(...tableItems(catalog, { withAlias: false, usedAliases }), ...schemaItems(catalog));
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
export {
  allocateTableAlias,
  preferredTableAlias,
  splitTableNameParts,
} from "./table-alias.js";
export type * from "./types.js";
