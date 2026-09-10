export type InsertColumnHint = {
  name: string;
  dataType: string;
  isNullable: boolean;
  defaultValue: string | null;
};

function quoteIdent(ident: string): string {
  return `"${ident.replaceAll('"', '""')}"`;
}

/**
 * Черновик INSERT для copy-paste (выполнение остаётся read-only до 0.5).
 */
export function buildInsertTemplate(
  schema: string,
  table: string,
  columns: InsertColumnHint[],
): string {
  if (columns.length === 0) {
    return `INSERT INTO ${quoteIdent(schema)}.${quoteIdent(table)} DEFAULT VALUES;`;
  }

  const names = columns.map((column) => quoteIdent(column.name)).join(", ");
  const values = columns.map((column) => placeholderForColumn(column)).join(", ");
  return (
    `INSERT INTO ${quoteIdent(schema)}.${quoteIdent(table)} (${names})\n` +
    `VALUES (${values});`
  );
}

function placeholderForColumn(column: InsertColumnHint): string {
  if (column.defaultValue) {
    return "DEFAULT";
  }
  if (column.isNullable) {
    return "NULL";
  }
  const type = column.dataType.toLowerCase();
  if (/(^|[^a-z])(int|serial|smallint|bigint|numeric|decimal|real|double|money)/.test(type)) {
    return "0";
  }
  if (/bool/.test(type)) {
    return "FALSE";
  }
  if (/timestamp|date|time/.test(type)) {
    return "NOW()";
  }
  if (/uuid/.test(type)) {
    return "gen_random_uuid()";
  }
  if (/json/.test(type)) {
    return "'{}'";
  }
  return "'…'";
}
