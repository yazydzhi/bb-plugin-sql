export { completeSql, analyzeCompletionContext, matchScore, rankCompletionItems } from "./complete.js";
export {
  allocateTableAlias,
  preferredTableAlias,
  splitTableNameParts,
} from "./table-alias.js";
export { parseFromRelations } from "./context.js";
export type {
  CatalogColumn,
  CatalogTable,
  CompletionContext,
  CompletionItem,
  CompletionKind,
  CompletionSlot,
  CompletionUsage,
  SchemaCatalog,
} from "./types.js";
