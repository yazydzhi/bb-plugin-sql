/**
 * Классификация SQL и правила безопасного execute (0.5 controlled write).
 * Эвристика по первому значимому ключевому слову; не полный парсер.
 */

export type StatementKind =
  | "read"
  | "insert"
  | "update"
  | "delete"
  | "merge"
  | "ddl"
  | "admin"
  | "unknown";

export type AccessMode = "readonly" | "readwrite";

export type ConfirmLevel = "none" | "confirm" | "type_table";

export type SqlSafetyAssessment = {
  kind: StatementKind;
  allowed: boolean;
  /** Почему запрещено (если allowed=false). */
  blockReason: string | null;
  confirmLevel: ConfirmLevel;
  /** Нужен ли UI/agent confirm перед execute. */
  requiresConfirm: boolean;
  /** WHERE отсутствует или тавтология (для UPDATE/DELETE). */
  missingOrTautologyWhere: boolean;
  /** Имя таблицы для type-to-confirm (best-effort). */
  targetTable: string | null;
  /** Краткое описание риска для диалога. */
  summary: string;
};

const READ_HEADS = new Set([
  "SELECT",
  "WITH",
  "VALUES",
  "TABLE",
  "SHOW",
  "EXPLAIN",
]);

const DDL_HEADS = new Set([
  "CREATE",
  "ALTER",
  "DROP",
  "TRUNCATE",
  "RENAME",
  "COMMENT",
  "GRANT",
  "REVOKE",
  "SECURITY",
]);

const ADMIN_HEADS = new Set([
  "VACUUM",
  "ANALYZE",
  "CLUSTER",
  "REINDEX",
  "CHECKPOINT",
  "DISCARD",
  "LOAD",
  "LISTEN",
  "NOTIFY",
  "UNLISTEN",
  "PREPARE",
  "DEALLOCATE",
  "EXECUTE",
  "CALL",
  "DO",
  "COPY",
  "SET",
  "RESET",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
  "LOCK",
]);

/**
 * Убирает комментарии/строки для грубого разбора ключевых слов.
 * Строки заменяются пробелами той же длины по символам — индексы плывут,
 * поэтому для keyword scan работаем по «очищенной» строке отдельно.
 */
export function stripSqlNoise(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "-" && next === "-") {
      while (i < source.length && source[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < source.length - 1) {
        if (source[i] === "*" && source[i + 1] === "/") {
          out += "  ";
          i += 2;
          break;
        }
        out += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }
    if (ch === "'") {
      out += " ";
      i += 1;
      while (i < source.length) {
        if (source[i] === "'") {
          out += " ";
          i += 1;
          if (source[i] === "'") {
            out += " ";
            i += 1;
            continue;
          }
          break;
        }
        out += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      out += " ";
      i += 1;
      while (i < source.length) {
        if (source[i] === '"') {
          out += " ";
          i += 1;
          if (source[i] === '"') {
            out += " ";
            i += 1;
            continue;
          }
          break;
        }
        out += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }
    if (ch === "$") {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) {
        j += 1;
      }
      if (source[j] === "$") {
        const tag = source.slice(i, j + 1);
        const close = source.indexOf(tag, j + 1);
        const end = close < 0 ? source.length : close + tag.length;
        while (i < end) {
          out += source[i] === "\n" ? "\n" : " ";
          i += 1;
        }
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

function firstKeyword(cleaned: string): string | null {
  const match = /\b([A-Za-z_]+)\b/.exec(cleaned);
  return match ? match[1]!.toUpperCase() : null;
}

/**
 * Для WITH … определяет SELECT vs DML.
 * DML важнее SELECT в CTE: `WITH x AS (SELECT …) INSERT …` → insert.
 */
function kindAfterWith(cleaned: string): StatementKind {
  const upper = cleaned.toUpperCase();
  const insertAt = upper.search(/\bINSERT\b/);
  const updateAt = upper.search(/\bUPDATE\b/);
  const deleteAt = upper.search(/\bDELETE\b/);
  const dml = [
    { kind: "insert" as const, at: insertAt },
    { kind: "update" as const, at: updateAt },
    { kind: "delete" as const, at: deleteAt },
  ].filter((item) => item.at >= 0);
  if (dml.length > 0) {
    dml.sort((left, right) => left.at - right.at);
    return dml[0]!.kind;
  }
  if (/\bSELECT\b/.test(upper) || /\bTABLE\b/.test(upper) || /\bVALUES\b/.test(upper)) {
    return "read";
  }
  return "unknown";
}

export function classifySqlStatement(sql: string): StatementKind {
  const cleaned = stripSqlNoise(sql);
  const head = firstKeyword(cleaned);
  if (!head) {
    return "unknown";
  }
  if (head === "WITH") {
    return kindAfterWith(cleaned);
  }
  if (head === "INSERT") {
    return "insert";
  }
  if (head === "UPDATE") {
    return "update";
  }
  if (head === "DELETE") {
    return "delete";
  }
  if (head === "MERGE") {
    return "merge";
  }
  if (READ_HEADS.has(head)) {
    return "read";
  }
  if (DDL_HEADS.has(head)) {
    return "ddl";
  }
  if (ADMIN_HEADS.has(head)) {
    return "admin";
  }
  return "unknown";
}

/** Есть ли WHERE с не-тавтологичным предикатом (эвристика). */
export function analyzeWhereClause(sql: string): {
  hasWhere: boolean;
  tautology: boolean;
} {
  const cleaned = stripSqlNoise(sql);
  const upper = cleaned.toUpperCase();
  const whereMatch = /\bWHERE\b([\s\S]*?)(?:\bRETURNING\b|\bORDER\b|\bLIMIT\b|\bOFFSET\b|\bFOR\b|$)/i.exec(
    cleaned,
  );
  if (!whereMatch) {
    return { hasWhere: false, tautology: false };
  }
  const predicate = whereMatch[1]!.trim();
  if (predicate.length === 0) {
    return { hasWhere: false, tautology: false };
  }
  const normalized = predicate.replace(/\s+/g, " ").replace(/;+\s*$/, "").trim();
  const tautology =
    /^(TRUE|1\s*=\s*1|0\s*=\s*0)$/i.test(normalized) ||
    (/^TRUE\b/i.test(normalized) && !/\b(AND|OR)\b/i.test(normalized)) ||
    (/^1\s*=\s*1\b/i.test(normalized) && !/\b(AND|OR)\b/i.test(normalized));
  return { hasWhere: true, tautology };
}

/** Best-effort имя таблицы для UPDATE/DELETE/INSERT. */
export function extractTargetTable(sql: string): string | null {
  const cleaned = stripSqlNoise(sql);
  const patterns = [
    /\bUPDATE\s+((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))?)/i,
    /\bDELETE\s+FROM\s+((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))?)/i,
    /\bINSERT\s+INTO\s+((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))?)/i,
    /\bMERGE\s+INTO\s+((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))?)/i,
    /\bTRUNCATE\s+(?:TABLE\s+)?((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))?)/i,
    /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))?)/i,
    /\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))?)/i,
    /\bALTER\s+TABLE\s+((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))?)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(cleaned);
    if (match?.[1]) {
      return match[1].replace(/\s+/g, "");
    }
  }
  return null;
}

/**
 * SELECT … FOR UPDATE/SHARE нуждается в RW-транзакции (не в BEGIN READ ONLY).
 */
export function hasRowLockClause(sql: string): boolean {
  return /\bFOR\s+(UPDATE|NO\s+KEY\s+UPDATE|SHARE|KEY\s+SHARE)\b/i.test(
    stripSqlNoise(sql),
  );
}

/**
 * Нужен ли BEGIN (не READ ONLY) для statement.
 */
export function sqlNeedsWriteTransaction(sql: string, kind: StatementKind): boolean {
  if (
    kind === "insert" ||
    kind === "update" ||
    kind === "delete" ||
    kind === "merge" ||
    kind === "ddl"
  ) {
    return true;
  }
  return kind === "read" && hasRowLockClause(sql);
}

export type AssessOptions = {
  accessMode: AccessMode;
  /** Вызов из agent tool. */
  fromAgent?: boolean;
  /** Per-connection: agent write разрешён. */
  agentWriteEnabled?: boolean;
  /** Per-connection: DDL (CREATE/ALTER/DROP/…) разрешён. Default off. */
  allowDdl?: boolean;
};

/**
 * Оценка одного statement перед execute.
 * Admin/unknown запрещены. DML — при readwrite (+ agentWrite для агента).
 * DDL — только если allowDdl (и agentWrite для агента).
 */
export function assessSqlStatement(
  sql: string,
  options: AssessOptions,
): SqlSafetyAssessment {
  const kind = classifySqlStatement(sql);
  const targetTable = extractTargetTable(sql);
  const whereInfo =
    kind === "update" || kind === "delete"
      ? analyzeWhereClause(sql)
      : { hasWhere: true, tautology: false };
  const missingOrTautologyWhere =
    (kind === "update" || kind === "delete") &&
    (!whereInfo.hasWhere || whereInfo.tautology);

  const base = {
    kind,
    missingOrTautologyWhere,
    targetTable,
  };

  if (kind === "read") {
    if (hasRowLockClause(sql) && options.accessMode === "readonly") {
      return {
        ...base,
        allowed: false,
        blockReason:
          "SELECT FOR UPDATE/SHARE needs a read/write connection (not read-only).",
        confirmLevel: "none",
        requiresConfirm: false,
        summary: "Row lock blocked by connection mode",
      };
    }
    return {
      ...base,
      allowed: true,
      blockReason: null,
      confirmLevel: "none",
      requiresConfirm: false,
      summary: hasRowLockClause(sql)
        ? "SELECT with row lock (FOR UPDATE/SHARE)"
        : "Read-only statement",
    };
  }

  if (kind === "admin" || kind === "unknown") {
    return {
      ...base,
      allowed: false,
      blockReason:
        kind === "admin"
          ? "Admin/session statements are not allowed (SET/VACUUM/COPY/…)."
          : "Unrecognized SQL — blocked for safety.",
      confirmLevel: "none",
      requiresConfirm: false,
      summary: "Blocked statement kind",
    };
  }

  if (options.accessMode === "readonly") {
    return {
      ...base,
      allowed: false,
      blockReason: "Connection is read-only. Switch it to read/write to mutate data.",
      confirmLevel: "none",
      requiresConfirm: false,
      summary: "Write blocked by connection mode",
    };
  }

  if (kind === "ddl") {
    if (!options.allowDdl) {
      return {
        ...base,
        allowed: false,
        blockReason:
          "DDL is disabled for this connection (default). Enable “Allow DDL” to run CREATE/ALTER/DROP/TRUNCATE/…",
        confirmLevel: "none",
        requiresConfirm: false,
        summary: "DDL disabled",
      };
    }
    if (options.fromAgent && !options.agentWriteEnabled) {
      return {
        ...base,
        allowed: false,
        blockReason:
          "Agent write is disabled for this connection. Enable “Agent write” (and Allow DDL) for tool-driven DDL.",
        confirmLevel: "none",
        requiresConfirm: false,
        summary: "Agent write disabled",
      };
    }

    const cleaned = stripSqlNoise(sql).trimStart();
    const head = cleaned.split(/\s+/)[0]?.toUpperCase() ?? "DDL";
    let confirmLevel: ConfirmLevel = "confirm";
    let summary = `${head} will change the schema`;
    if (head === "DROP" || head === "TRUNCATE") {
      confirmLevel = targetTable ? "type_table" : "confirm";
      summary = targetTable
        ? `${head} requires typing the table name (${targetTable}) to confirm`
        : `${head} will destroy data/schema objects`;
    } else if (head === "CREATE") {
      summary = "CREATE will add schema objects";
    } else if (head === "ALTER") {
      summary = "ALTER will change schema objects";
    }

    if (options.fromAgent) {
      return {
        ...base,
        allowed: true,
        blockReason: null,
        confirmLevel: "none",
        requiresConfirm: false,
        summary,
      };
    }

    return {
      ...base,
      allowed: true,
      blockReason: null,
      confirmLevel,
      requiresConfirm: true,
      summary,
    };
  }

  // DML: insert | update | delete | merge
  if (options.fromAgent && !options.agentWriteEnabled) {
    return {
      ...base,
      allowed: false,
      blockReason:
        "Agent write is disabled for this connection (default). Enable “Agent write” on the connection to allow DML from tools.",
      confirmLevel: "none",
      requiresConfirm: false,
      summary: "Agent write disabled",
    };
  }

  let confirmLevel: ConfirmLevel = "confirm";
  let summary = `${kind.toUpperCase()} will modify data`;
  if (kind === "delete") {
    confirmLevel = "type_table";
    summary = missingOrTautologyWhere
      ? "DELETE without a selective WHERE — will affect all matching rows"
      : "DELETE requires typing the table name to confirm";
  } else if (kind === "update" && missingOrTautologyWhere) {
    confirmLevel = "type_table";
    summary = "UPDATE without a selective WHERE — will affect all matching rows";
  } else if (kind === "insert") {
    summary = "INSERT will add rows";
  } else if (kind === "update") {
    summary = "UPDATE will modify rows";
  } else if (kind === "merge") {
    summary = "MERGE will insert and/or update rows";
  }

  // Agent: нет UI type-to-confirm — тавтологичный WHERE запрещаем навсегда.
  if (options.fromAgent && missingOrTautologyWhere) {
    return {
      ...base,
      allowed: false,
      blockReason:
        "Agent write refuses UPDATE/DELETE without a selective WHERE (no WHERE / WHERE TRUE / 1=1).",
      confirmLevel: "none",
      requiresConfirm: false,
      summary: "Unsafe WHERE for agent write",
    };
  }

  // Agent write включён на коннекте = opt-in; UI-confirm не нужен.
  if (options.fromAgent) {
    return {
      ...base,
      allowed: true,
      blockReason: null,
      confirmLevel: "none",
      requiresConfirm: false,
      summary,
    };
  }

  return {
    ...base,
    allowed: true,
    blockReason: null,
    confirmLevel,
    requiresConfirm: true,
    summary,
  };
}
