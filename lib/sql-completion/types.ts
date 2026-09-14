/**
 * Типы каталога схемы и кандидатов автодополнения SQL (0.6).
 */

export type CatalogColumn = {
  name: string;
  dataType: string;
  isNullable: boolean;
};

export type CatalogTable = {
  schema: string;
  name: string;
  /** BASE TABLE | VIEW | … */
  type: string;
  columns: CatalogColumn[];
};

export type SchemaCatalog = {
  schemas: string[];
  tables: CatalogTable[];
};

export type CompletionKind =
  | "keyword"
  | "schema"
  | "table"
  | "column"
  | "alias";

export type CompletionItem = {
  label: string;
  kind: CompletionKind;
  /** Текст вставки (может отличаться от label). */
  insertText: string;
  detail?: string;
  /** Ключ для статистики: kind:qualifiedName */
  usageKey: string;
  score: number;
};

export type CompletionUsage = {
  usageKey: string;
  uses: number;
  lastUsedAt: string;
};

export type CompletionSlot =
  | "keyword_or_any"
  | "table"
  | "column"
  | "schema_or_table"
  | "none";

export type CompletionContext = {
  slot: CompletionSlot;
  /** Префикс идентификатора до курсора (без кавычек). */
  prefix: string;
  /** Начало префикса в statement (абсолютный индекс в sql). */
  prefixStart: number;
  /** Курсор (абсолютный). */
  cursor: number;
  /** Текст statement, содержащего курсор. */
  statement: string;
  statementStart: number;
  /** schema. из квалификации перед префиксом. */
  qualifierSchema: string | null;
  /** table. или alias. перед префиксом. */
  qualifierRelation: string | null;
  /** FROM/JOIN aliases: alias → { schema, table }. */
  aliases: Record<string, { schema: string | null; table: string }>;
  /** Таблицы/views, упомянутые в FROM/JOIN (без alias ключа = имя таблицы). */
  fromRelations: { schema: string | null; table: string; alias: string | null }[];
};
