/**
 * Contract tests for the unified `TableContribution` surface (#129).
 *
 * Covers the invariants the refactor must hold and that #135 (durable
 * materialization) builds on: the Postgres fulltext slot emitted once
 * (strategy-owned, never duplicated by the column-walker), custom table
 * names reflected in contribution identity, FTS5 staying raw-ddl,
 * supporting indexes still emitted, and a custom strategy plugging in
 * through the `ownedTables` public API.
 */
import { describe, expect, it } from "vitest";

import {
  generatePostgresDDL,
  postgresContributions,
  sqliteContributions,
} from "../src/backend/drizzle/ddl";
import { resolvePostgresCloneActions } from "../src/backend/drizzle/postgres-clone-policy";
import { createPostgresTables } from "../src/backend/drizzle/schema/postgres";
import { createSqliteTables } from "../src/backend/drizzle/schema/sqlite";
import type { TableContribution } from "../src/backend/table-contribution";
import { BranchError } from "../src/graph-merge/errors";
import { type FulltextStrategy, tsvectorStrategy } from "../src/query/dialect";
import { pgvectorStrategy } from "../src/query/dialect/vector/pgvector-strategy";
import { requireDefined } from "../src/utils/presence";

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
  it("declares a clone policy for every bundled table and vector sidecar", () => {
    const contributions = postgresContributions();
    const vectorContributions = pgvectorStrategy.ownedTables({
      graphId: "clone-policy",
      nodeKind: "Person",
      fieldPath: "embedding",
      dimensions: 3,
      metric: "cosine",
      indexType: "hnsw",
    });
    expect(
      [...contributions, ...vectorContributions].every(
        (contribution) => contribution.workingCopyClonePolicy !== undefined,
      ),
    ).toBe(true);
  });

  it("keeps seed, rebuild, document, and graph-row policies through custom names", () => {
    const source = postgresContributions();
    const target = postgresContributions(
      createPostgresTables({
        nodes: "private_nodes",
        baseSchemaVersions: "private_marker",
        graphTemplates: "private_templates",
        fences: "private_fences",
        indexMaterializations: "private_index_status",
        contributionMaterializations: "private_contribution_status",
        fulltext: "private_fulltext",
      }),
    );
    const actions = resolvePostgresCloneActions(source, target);
    function action(logicalName: string) {
      const found = actions.find(
        (candidate) => candidate.source.logicalName === logicalName,
      );
      if (found === undefined) throw new Error(`Missing ${logicalName}`);
      return found;
    }
    expect(action("nodes")).toMatchObject({
      target: { tableName: "private_nodes" },
      policy: { kind: "graphRows", graphIdColumn: "graph_id" },
    });
    function policy(logicalName: string) {
      const found = target.find(
        (contribution) => contribution.logicalName === logicalName,
      );
      if (found === undefined) throw new Error(`Missing ${logicalName}`);
      return found.workingCopyClonePolicy;
    }
    expect(policy("baseSchemaVersions")).toEqual({ kind: "freshSeed" });
    expect(policy("fences")).toEqual({ kind: "freshSeed" });
    expect(
      actions.some((candidate) =>
        ["baseSchemaVersions", "fences"].includes(candidate.source.logicalName),
      ),
    ).toBe(false);
    expect(action("graphTemplates")).toMatchObject({
      target: { tableName: "private_templates" },
      policy: {
        kind: "graphDocument",
        documentColumn: "schema_doc",
        graphIdKey: "graphId",
      },
    });
    expect(policy("indexMaterializations")).toEqual({
      kind: "rebuildAfterClone",
    });
    expect(policy("contributionMaterializations")).toEqual({
      kind: "rebuildAfterClone",
    });
    expect(
      actions.some((candidate) =>
        ["indexMaterializations", "contributionMaterializations"].includes(
          candidate.source.logicalName,
        ),
      ),
    ).toBe(false);
    expect(action("fulltext")).toMatchObject({
      target: { tableName: "private_fulltext" },
      policy: { kind: "graphRows" },
    });
  });

  it("does not infer a copy for a graph-scoped physical status table", () => {
    const status: TableContribution = {
      logicalName: "physicalStatus",
      owner: "test",
      tableName: "source_status",
      createDdl: [
        'CREATE TABLE "source_status" (graph_id text, physical_name text);',
      ],
      runtimeEnsure: false,
      workingCopyClonePolicy: { kind: "rebuildAfterClone" },
    };
    expect(
      resolvePostgresCloneActions(
        [status],
        [{ ...status, tableName: "private_status" }],
      ),
    ).toEqual([]);
    const missingPolicy: TableContribution = {
      logicalName: status.logicalName,
      owner: status.owner,
      tableName: status.tableName,
      createDdl: status.createDdl,
      runtimeEnsure: status.runtimeEnsure,
    };
    expect(() =>
      resolvePostgresCloneActions([missingPolicy], [status]),
    ).toThrow(BranchError);
    expect(() =>
      resolvePostgresCloneActions(
        [
          {
            ...status,
            workingCopyClonePolicy: {
              kind: "unsupported",
              reason: "physical references",
            },
          },
        ],
        [
          {
            ...status,
            workingCopyClonePolicy: {
              kind: "unsupported",
              reason: "physical references",
            },
          },
        ],
      ),
    ).toThrow(BranchError);
  });

  it("emits the strategy-owned fulltext table exactly once", () => {
    const tables = createPostgresTables();
    const ddl = generatePostgresDDL(tables, tsvectorStrategy);
    // The column-walker skips `tables.fulltext` (the strategy owns its
    // generated tsvector DDL); it must not also emit a second CREATE
    // TABLE for the same physical name.
    const creates = ddl.filter((statement) =>
      statement.includes(
        'CREATE TABLE IF NOT EXISTS "typegraph_node_fulltext"',
      ),
    );
    expect(creates).toHaveLength(1);
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
    expect(fulltextContribution(contributions)).toMatchObject({
      runtimeEnsure: true,
      scope: "deployment",
    });
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
  it("emits the FTS5 virtual table as raw DDL", () => {
    const contributions = sqliteContributions(createSqliteTables());
    const fulltext = contributions.find(
      (contribution) => contribution.logicalName === "fulltext",
    );
    if (fulltext === undefined) throw new Error("no fulltext contribution");

    expect(fulltext.owner).toBe("fts5");
    expect(fulltext.scope).toBe("deployment");
    expect(fulltext.createDdl.join("\n")).toContain(
      "CREATE VIRTUAL TABLE IF NOT EXISTS",
    );
    expect(fulltext.createDdl.join("\n")).toContain("USING fts5(");
  });
});

describe("TableContribution — custom strategy via the ownedTables API", () => {
  it("a custom strategy's ownedTables flows into generated DDL", () => {
    // Exercises the public API shape: a strategy declares its storage
    // through `ownedTables` (Drizzle-free) and it flows into emitted DDL.
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
          },
        ];
      },
    };

    const contribution = fulltextContribution(
      postgresContributions(createPostgresTables(), customStrategy),
    );
    expect(contribution.owner).toBe("custom-pg-trgm");

    const ddl = generatePostgresDDL(
      createPostgresTables(),
      customStrategy,
    ).join("\n");
    expect(ddl).toContain(
      'CREATE TABLE IF NOT EXISTS "typegraph_node_fulltext" (id TEXT);',
    );
  });
});

/**
 * The separation relation's ordered-pair CHECK is the database-level identity
 * contradiction backstop. It is declared once, in the Drizzle table, and must
 * survive BOTH consumers of that declaration: drizzle-kit migrations and the
 * runtime DDL the column-walker emits. A walker that silently dropped checks
 * would leave every runtime-provisioned database without the barrier.
 */
function separationCreateTableDdl(
  contributions: ReturnType<typeof sqliteContributions>,
): string {
  const found = contributions.find(
    (contribution) => contribution.logicalName === "identitySeparation",
  );
  if (found === undefined) throw new Error("no identitySeparation table");
  return requireDefined(found.createDdl[0]);
}

describe("identity separation ordered-pair constraint", () => {
  it("emits the CHECK in the SQLite create statement", () => {
    const ddl = separationCreateTableDdl(
      sqliteContributions(createSqliteTables()),
    );

    expect(ddl).toContain(
      'CONSTRAINT "typegraph_identity_separation_ordered_pair_check" CHECK (class_key_low < class_key_high)',
    );
  });

  it("pins the C collation in the PostgreSQL create statement", () => {
    const ddl = separationCreateTableDdl(
      postgresContributions(createPostgresTables()),
    );

    // Without an explicit collation the CHECK would use the database default,
    // which on a linguistic collation orders text differently from the writer
    // and would reject legitimate pairs.
    expect(ddl).toContain(
      'CHECK (class_key_low COLLATE "C" < class_key_high COLLATE "C")',
    );
  });

  it("derives the constraint name from a custom table name", () => {
    const ddl = separationCreateTableDdl(
      sqliteContributions(
        createSqliteTables({ identitySeparation: "app_separation" }),
      ),
    );

    expect(ddl).toContain('CONSTRAINT "app_separation_ordered_pair_check"');
  });
});
