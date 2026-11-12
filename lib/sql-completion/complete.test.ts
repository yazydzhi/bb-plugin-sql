import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { completeSql } from "./complete.js";
import { analyzeCompletionContext, parseFromRelations } from "./context.js";
import { preferredTableAlias, allocateTableAlias } from "./table-alias.js";
import type { SchemaCatalog } from "./types.js";

const catalog: SchemaCatalog = {
  schemas: ["public"],
  tables: [
    {
      schema: "public",
      name: "authors",
      type: "BASE TABLE",
      columns: [
        { name: "id", dataType: "integer", isNullable: false },
        { name: "name", dataType: "text", isNullable: false },
      ],
    },
    {
      schema: "public",
      name: "books",
      type: "BASE TABLE",
      columns: [
        { name: "id", dataType: "integer", isNullable: false },
        { name: "title", dataType: "text", isNullable: false },
        { name: "author_id", dataType: "integer", isNullable: true },
      ],
    },
  ],
};

describe("tableAlias", () => {
  it("builds initials from snake_case", () => {
    assert.equal(preferredTableAlias("trade"), "t");
    assert.equal(preferredTableAlias("trade_role_person"), "trp");
  });

  it("avoids collisions", () => {
    assert.equal(allocateTableAlias("trade", ["t"]), "t2");
  });
});

describe("parseFromRelations", () => {
  it("captures alias", () => {
    const { aliases } = parseFromRelations("SELECT * FROM authors a JOIN books b ON true");
    assert.equal(aliases.a?.table, "authors");
    assert.equal(aliases.b?.table, "books");
  });
});

describe("analyzeCompletionContext", () => {
  it("table slot after FROM", () => {
    const sql = "SELECT * FROM ";
    const ctx = analyzeCompletionContext(sql, sql.length);
    assert.equal(ctx.slot, "table");
    assert.equal(ctx.prefix, "");
  });

  it("column slot after alias dot", () => {
    const sql = "SELECT a. FROM authors a";
    const cursor = sql.indexOf("a.") + 2;
    const ctx = analyzeCompletionContext(sql, cursor);
    assert.equal(ctx.slot, "column");
    assert.equal(ctx.qualifierRelation, "a");
  });
});

describe("completeSql", () => {
  it("suggests tables after FROM with prefix", () => {
    const sql = "SELECT * FROM aut";
    const items = completeSql({ sql, cursor: sql.length, catalog });
    assert.ok(items.some((item) => item.label === "authors"));
    assert.ok(
      items.every(
        (item) =>
          item.label.toLowerCase().includes("aut") ||
          (item.filterText ?? "").toLowerCase().includes("aut") ||
          item.kind === "keyword" ||
          item.kind === "alias",
      ),
    );
  });

  it("inserts short alias when accepting table after FROM", () => {
    const sql = "SELECT * FROM ";
    const items = completeSql({ sql, cursor: sql.length, catalog });
    const authors = items.find((item) => item.label === "authors" && item.kind === "table");
    assert.equal(authors?.insertText, "authors a");
    assert.ok(authors?.detail?.includes("as a"));
  });

  it("suggests by short alias prefix", () => {
    const catalogWithLong: typeof catalog = {
      schemas: ["public"],
      tables: [
        ...catalog.tables,
        {
          schema: "public",
          name: "trade_role_person",
          type: "BASE TABLE",
          columns: [{ name: "id", dataType: "integer", isNullable: false }],
        },
      ],
    };
    const sql = "SELECT * FROM trp";
    const items = completeSql({ sql, cursor: sql.length, catalog: catalogWithLong });
    assert.ok(
      items.some(
        (item) =>
          item.insertText === "trade_role_person trp" &&
          (item.kind === "table" || item.kind === "alias"),
      ),
    );
  });

  it("suggests alias columns", () => {
    const sql = "SELECT a. FROM authors a";
    const cursor = sql.indexOf("a.") + 2;
    const items = completeSql({ sql, cursor, catalog });
    const labels = items.map((item) => item.label);
    assert.ok(labels.includes("id"));
    assert.ok(labels.includes("name"));
    assert.ok(!labels.includes("title"));
  });

  it("ranks by personal usage", () => {
    const sql = "SELECT * FROM ";
    const items = completeSql({
      sql,
      cursor: sql.length,
      catalog,
      usages: [
        {
          usageKey: "table:public.books",
          uses: 5,
          lastUsedAt: new Date().toISOString(),
        },
      ],
      nowMs: Date.now(),
    });
    const tables = items.filter((item) => item.kind === "table");
    assert.equal(tables[0]?.label, "books");
  });

  it("suggests SELECT keyword", () => {
    const sql = "SEL";
    const items = completeSql({ sql, cursor: sql.length, catalog: null });
    assert.ok(items.some((item) => item.label === "SELECT"));
  });
});
