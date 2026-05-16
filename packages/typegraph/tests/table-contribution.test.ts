/**
 * Contract tests for the unified `TableContribution` surface (#129).
 *
 * Covers the invariants the refactor must hold and that #135 (durable
 * materialization) will build on: a single Drizzle table object for the
 * Postgres fulltext slot (no duplicate), custom table names reflected
 * in contribution identity, FTS5 staying raw-ddl, tsvector staying
 * drizzle-visible, supporting indexes still emitted, and a custom
 * strategy plugging in through the new `ownedTables` public API.
 */
import { describe, expect, it } from "vitest";

import {
  generatePostgresDDL,
  postgresContributions,
  sqliteContributions,
} from "../src/backend/drizzle/ddl";
import { createPostgresTables } from "../src/backend/drizzle/schema/postgres";
import { createSqliteTables } from "../src/backend/drizzle/schema/sqlite";
import { isDrizzleContribution } from "../src/backend/table-contribution";
import { type FulltextStrategy, tsvectorStrategy } from "../src/query/dialect";

function fulltextContribution(
  contributions: ReturnType<typeof postgresContributions>,
) {
  const found = contributions.find(
    (contribution) => contribution.logicalName === "fulltext",
  );
  if (found === undefined) throw new Error("no fulltext contribution");
  return found;
}

describe("TableContribution — Postgres (tsvectorStrategy)", () => {
  it("attaches the exact factory pgTable object — no duplicate", () => {
    const tables = createPostgresTables();
    const contribution = fulltextContribution(postgresContributions(tables));

    expect(contribution.source.kind).toBe("drizzle-pg");
    if (contribution.source.kind !== "drizzle-pg") return;
    // Reference identity: the contribution must carry the SAME object
    // the factory created and exports, never a second pgTable for the
    // same physical table.
    expect(contribution.source.table).toBe(tables.fulltext);
  });

  it("stays drizzle-kit visible", () => {
    const contribution = fulltextContribution(
      postgresContributions(createPostgresTables()),
    );
    expect(isDrizzleContribution(contribution)).toBe(true);
  });

  it("reflects custom table names in contribution identity", () => {
    const tables = createPostgresTables({ fulltext: "myapp_search_index" });
    const contribution = fulltextContribution(postgresContributions(tables));

    expect(contribution.logicalName).toBe("fulltext"); // stable slot
    expect(contribution.tableName).toBe("myapp_search_index"); // physical
    expect(contribution.createDdl.join("\n")).toContain("myapp_search_index");
  });

  it("still emits the supporting GIN + kind indexes", () => {
    const ddl = generatePostgresDDL(
      createPostgresTables(),
      tsvectorStrategy,
    ).join("\n");
    expect(ddl).toContain("typegraph_node_fulltext_tsv_idx");
    expect(ddl).toContain('USING GIN ("tsv")');
    expect(ddl).toContain("typegraph_node_fulltext_kind_idx");
  });

  it("keeps base-table logicalName stable across custom table names", () => {
    const tables = createPostgresTables({
      nodes: "myapp_nodes",
      edges: "myapp_edges",
    });
    const contributions = postgresContributions(tables);

    const nodes = contributions.find((c) => c.logicalName === "nodes");
    const edges = contributions.find((c) => c.logicalName === "edges");
    if (nodes === undefined || edges === undefined) {
      throw new Error("base contributions missing");
    }
    // logicalName is the stable factory key — the #135 materialization
    // identity must not move when the physical name is overridden.
    expect(nodes.tableName).toBe("myapp_nodes");
    expect(edges.tableName).toBe("myapp_edges");
    expect(nodes.createDdl.join("\n")).toContain("myapp_nodes");
    // The physical name must NOT have leaked into logicalName.
    expect(contributions.some((c) => c.logicalName === "myapp_nodes")).toBe(
      false,
    );
  });

  it("marks the fulltext slot runtimeEnsure but base tables not", () => {
    const contributions = postgresContributions(createPostgresTables());
    expect(fulltextContribution(contributions).runtimeEnsure).toBe(true);
    const base = contributions.filter(
      (contribution) => contribution.owner === "base",
    );
    expect(base.length).toBeGreaterThan(0);
    expect(base.every((contribution) => !contribution.runtimeEnsure)).toBe(
      true,
    );
  });
});

describe("TableContribution — SQLite (fts5Strategy)", () => {
  it("is raw-ddl, not drizzle-visible, and emits the FTS5 virtual table", () => {
    const contributions = sqliteContributions(createSqliteTables());
    const fulltext = contributions.find(
      (contribution) => contribution.logicalName === "fulltext",
    );
    if (fulltext === undefined) throw new Error("no fulltext contribution");

    expect(fulltext.source.kind).toBe("raw-ddl");
    expect(isDrizzleContribution(fulltext)).toBe(false);
    expect(fulltext.createDdl.join("\n")).toContain(
      "CREATE VIRTUAL TABLE IF NOT EXISTS",
    );
    expect(fulltext.createDdl.join("\n")).toContain("USING fts5(");
  });
});

describe("TableContribution — custom strategy via the ownedTables API", () => {
  it("a custom strategy's ownedTables flows into generated DDL", () => {
    // Exercises the new public API shape: a strategy declares its
    // storage through `ownedTables` (Drizzle-free) and the resolver
    // turns it into emitted DDL.
    const customStrategy: FulltextStrategy = {
      ...tsvectorStrategy,
      ownedTables(primaryTableName) {
        return [
          {
            logicalName: "fulltext",
            owner: "custom-pg-trgm",
            tableName: primaryTableName,
            createDdl: [
              `CREATE TABLE IF NOT EXISTS "${primaryTableName}" (id TEXT);`,
            ],
            runtimeEnsure: true,
            drizzleModel: "raw-ddl",
          },
        ];
      },
    };

    const contribution = fulltextContribution(
      postgresContributions(createPostgresTables(), customStrategy),
    );
    expect(contribution.owner).toBe("custom-pg-trgm");
    expect(contribution.source.kind).toBe("raw-ddl");

    const ddl = generatePostgresDDL(
      createPostgresTables(),
      customStrategy,
    ).join("\n");
    expect(ddl).toContain(
      'CREATE TABLE IF NOT EXISTS "typegraph_node_fulltext" (id TEXT);',
    );
  });
});
