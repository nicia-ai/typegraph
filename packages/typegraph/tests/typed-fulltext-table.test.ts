/**
 * Drift sentinel for the typed Drizzle pg-core fulltext table
 * (`tables.fulltext`). The typed table's introspectable shape must
 * match `tsvectorStrategy.generateDdl()` — same columns + types,
 * primary key, indexes, and GENERATED expression. If either side
 * diverges, drizzle-kit will emit spurious migrations on every run.
 */
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { createPostgresTables } from "../src/backend/drizzle/schema/postgres";
import { tsvectorStrategy } from "../src/query/dialect";

describe("typed Drizzle fulltext table (tsvectorStrategy)", () => {
  const tables = createPostgresTables();
  const config = getTableConfig(tables.fulltext);

  it("table name matches the strategy's expected target", () => {
    expect(config.name).toBe(tables.fulltextTableName);
    expect(config.name).toBe("typegraph_node_fulltext");
  });

  it("declares the columns the strategy expects", () => {
    const columns = Object.fromEntries(
      config.columns.map((column) => [column.name, column.getSQLType()]),
    );

    expect(columns).toEqual({
      graph_id: "text",
      node_kind: "text",
      node_id: "text",
      content: "text",
      language: "regconfig",
      tsv: "tsvector",
      updated_at: "timestamp with time zone",
    });

    // All seven columns must be NOT NULL — no implicit nulls allowed
    // in the fulltext index.
    for (const column of config.columns) {
      expect(column.notNull).toBe(true);
    }
  });

  it("declares the (graph_id, node_kind, node_id) composite primary key", () => {
    const [pk] = config.primaryKeys;
    expect(pk).toBeDefined();
    expect(pk?.columns.map((column) => column.name)).toEqual([
      "graph_id",
      "node_kind",
      "node_id",
    ]);
  });

  it("declares the GIN index on tsv that the strategy creates", () => {
    const ginIndex = config.indexes.find(
      (index) => index.config.name === `${tables.fulltextTableName}_tsv_idx`,
    );
    expect(ginIndex).toBeDefined();
    expect(ginIndex?.config.method).toBe("gin");
    expect(ginIndex?.config.columns).toHaveLength(1);
  });

  it("declares the B-tree (graph_id, node_kind) lookup index", () => {
    const kindIndex = config.indexes.find(
      (index) => index.config.name === `${tables.fulltextTableName}_kind_idx`,
    );
    expect(kindIndex).toBeDefined();
    // No explicit method = B-tree (the Postgres default).
    expect(kindIndex?.config.method ?? "btree").toBe("btree");
    expect(
      kindIndex?.config.columns.map((column) =>
        "name" in column ? column.name : undefined,
      ),
    ).toEqual(["graph_id", "node_kind"]);
  });

  it("declares the GENERATED ALWAYS AS expression on tsv", () => {
    const tsvColumn = config.columns.find((column) => column.name === "tsv");
    expect(tsvColumn).toBeDefined();
    // Drizzle stores the generation config under `generated`. Type cast
    // through unknown because the runtime field isn't on the public
    // PgColumn type (it's a `HasGenerated` mixin tracked structurally).
    const generated = (
      tsvColumn as unknown as {
        generated?: { type: string; as: unknown };
      }
    ).generated;
    expect(generated).toBeDefined();
    expect(generated?.type).toBe("always");
  });

  it("matches the strategy DDL for the same table name", () => {
    // The strategy's own DDL is the source of truth at runtime
    // (bootstrap probe + raw `generatePostgresDDL` both call into it).
    // This sentinel just confirms the strategy still emits the table
    // shape we modeled in Drizzle — if either side diverges, this
    // test catches it before a consumer hits drizzle-kit drift.
    const strategyDdl = tsvectorStrategy
      .ownedTables(tables.fulltextTableName)
      .flatMap((contribution) => contribution.createDdl);
    const ddlText = strategyDdl.join("\n");

    expect(ddlText).toContain(`"${tables.fulltextTableName}"`);
    expect(ddlText).toMatch(/"language" regconfig NOT NULL/);
    expect(ddlText).toMatch(
      /"tsv" tsvector NOT NULL\s+GENERATED ALWAYS AS \(to_tsvector\("language", "content"\)\) STORED/,
    );
    expect(ddlText).toContain(
      `PRIMARY KEY ("graph_id", "node_kind", "node_id")`,
    );
    expect(ddlText).toContain(
      `CREATE INDEX IF NOT EXISTS "${tables.fulltextTableName}_tsv_idx"`,
    );
    expect(ddlText).toContain(`USING GIN ("tsv")`);
    expect(ddlText).toContain(
      `CREATE INDEX IF NOT EXISTS "${tables.fulltextTableName}_kind_idx"`,
    );
  });

  it("respects custom table names from the factory", () => {
    const customTables = createPostgresTables({
      fulltext: "myapp_search_index",
    });
    const customConfig = getTableConfig(customTables.fulltext);

    expect(customConfig.name).toBe("myapp_search_index");
    expect(
      customConfig.indexes.find(
        (index) => index.config.name === "myapp_search_index_tsv_idx",
      ),
    ).toBeDefined();
    expect(
      customConfig.indexes.find(
        (index) => index.config.name === "myapp_search_index_kind_idx",
      ),
    ).toBeDefined();
  });

  it("is included in the @nicia-ai/typegraph/postgres named exports", async () => {
    // `export *` from "@nicia-ai/typegraph/postgres" is only complete
    // if `fulltext` is named — drizzle-kit picks up named exports.
    const postgresPublic = await import("../src/backend/postgres");
    expect(postgresPublic.fulltext).toBeDefined();
    expect(getTableConfig(postgresPublic.fulltext).name).toBe(
      "typegraph_node_fulltext",
    );
  });
});

describe("generatePostgresDDL skips the typed fulltext table", () => {
  it("does not emit a column-walked CREATE TABLE for typegraph_node_fulltext", async () => {
    // Walking the typed table with `generatePgCreateTableSQL` would
    // skip the GENERATED clause entirely (the column-walker has no
    // generated-column branch), producing a non-equivalent table.
    // The strategy's `generateDdl` owns CREATE TABLE for the
    // fulltext table and is what we want to see in the output.
    const { generatePostgresDDL } = await import("../src/backend/drizzle/ddl");
    const tables = createPostgresTables();
    const ddl = generatePostgresDDL(tables, tsvectorStrategy);

    const fulltextCreateTables = ddl.filter(
      (statement) =>
        statement.includes(`"${tables.fulltextTableName}"`) &&
        statement.startsWith("CREATE TABLE"),
    );

    // Exactly one CREATE TABLE for the fulltext name — the
    // strategy's, which has the GENERATED clause.
    expect(fulltextCreateTables).toHaveLength(1);
    expect(fulltextCreateTables[0]).toMatch(/GENERATED ALWAYS AS/);
  });
});
