/**
 * The graph-relation inventory is the one owner of "which relations hold a
 * graph's rows". These tests are its ratchet: they fail when a bundled table
 * gains a `graph_id` column without being classified, when a consumer would see
 * a different set of physical names than the table binding defines, and when
 * the per-relation facts consumers read stop matching what those consumers
 * declare themselves.
 */
import { getTableColumns, getTableName, is, type Table } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  getTableConfig as getPgTableConfig,
  PgTable,
} from "drizzle-orm/pg-core";
import {
  getTableConfig as getSqliteTableConfig,
  SQLiteTable,
} from "drizzle-orm/sqlite-core";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import {
  postgresContributions,
  sqliteContributions,
} from "../src/backend/drizzle/ddl";
import { buildClearGraph } from "../src/backend/drizzle/operations/clear";
import type { Tables } from "../src/backend/drizzle/operations/shared";
import {
  createPostgresTables,
  type PostgresTables,
  tables as postgresTables,
} from "../src/backend/drizzle/schema/postgres";
import { defaultPostgresTableNames } from "../src/backend/drizzle/schema/postgres-table-names";
import {
  createSqliteTables,
  type SqliteTables,
  tables as sqliteTables,
} from "../src/backend/drizzle/schema/sqlite";
import {
  GRAPH_ID_COLUMN,
  GRAPH_PRESENCE_ANCHOR_KEYS,
  GRAPH_RELATION_CLEAR_SEQUENCE,
  GRAPH_RELATION_KEYS,
  GRAPH_RELATIONS,
  graphRelationDeclaration,
  type GraphRelationKey,
  type GraphRelationNames,
  isGraphRelationKey,
  resolveGraphRelationNames,
} from "../src/backend/graph-relations";
import { createPostgresBackend } from "../src/backend/postgres";
import { graphIdOrderIndexTables } from "../src/indexes/system";
import { createSqlSchema } from "../src/query/compiler/schema";
import {
  fts5Strategy,
  tsvectorStrategy,
} from "../src/query/dialect/fulltext-strategy";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend } from "./test-utils";

/**
 * Bundled tables that are deliberately NOT graph-scoped, and why. Each must
 * carry no `graph_id` column; a table that gains one fails the ratchet below
 * until it is classified in the inventory instead.
 */
const NOT_GRAPH_SCOPED = {
  fences: "deployment-shared keyed exclusions, never per graph",
  baseSchemaVersions: "one deployment-wide base schema marker",
  graphTemplates: "deployment-shared templates keyed by template id",
} as const;

type BoundTables = SqliteTables | PostgresTables;

function drizzleTables(tables: BoundTables): ReadonlyMap<string, Table> {
  return new Map(
    Object.entries(tables).filter(
      (entry): entry is [string, Table] =>
        is(entry[1], SQLiteTable) || is(entry[1], PgTable),
    ),
  );
}

function hasGraphIdColumn(table: Table): boolean {
  return Object.values(getTableColumns(table)).some(
    (column) => column.name === GRAPH_ID_COLUMN,
  );
}

/** A name for every bundled relation that no default could produce. */
function customNames(): Record<string, string> {
  return Object.fromEntries(
    Object.keys(defaultPostgresTableNames).map((key) => [key, `custom_${key}`]),
  );
}

const BINDINGS: readonly (readonly [string, BoundTables])[] = [
  ["sqlite", sqliteTables],
  ["postgres", postgresTables],
  ["sqlite (custom names)", createSqliteTables(customNames())],
  ["postgres (custom names)", createPostgresTables(customNames())],
];

function tableNameOf(tables: Tables, key: GraphRelationKey): string {
  return key === "fulltext" ?
      tables.fulltextTableName
    : getTableName(tables[key]);
}

/** The physical names `tables` gives every graph-scoped relation. */
function graphRelationNamesOfTables(tables: Tables): GraphRelationNames {
  return resolveGraphRelationNames(
    Object.fromEntries(
      GRAPH_RELATION_KEYS.map((key) => [key, tableNameOf(tables, key)]),
    ),
  );
}

describe("graph relation inventory ratchet", () => {
  describe.each(BINDINGS)("%s", (_label, tables) => {
    const bound = drizzleTables(tables);

    it("classifies every table carrying a graph_id column", () => {
      for (const [key, table] of bound) {
        if (!hasGraphIdColumn(table)) continue;
        expect(
          isGraphRelationKey(key),
          `table ${key} has a ${GRAPH_ID_COLUMN} column; declare it in the graph-relation inventory`,
        ).toBe(true);
      }
    });

    it("has a graph_id column on every declared relation that has a table", () => {
      // SQLite's fulltext storage is a virtual table Drizzle cannot model; its
      // name is bound separately and checked with the resolved names below.
      const modeled = GRAPH_RELATIONS.filter(
        (relation) => relation.key !== "fulltext" || bound.has("fulltext"),
      );
      for (const { key } of modeled) {
        const table = requireDefined(bound.get(key), `table for ${key}`);
        expect(hasGraphIdColumn(table), `relation ${key}`).toBe(true);
      }
    });

    it("accounts for every bound table as declared or explicitly excluded", () => {
      const unaccounted = [...bound.keys()].filter(
        (key) => !isGraphRelationKey(key) && !(key in NOT_GRAPH_SCOPED),
      );
      expect(unaccounted).toEqual([]);
      for (const key of Object.keys(NOT_GRAPH_SCOPED)) {
        const table = requireDefined(bound.get(key), `excluded table ${key}`);
        expect(hasGraphIdColumn(table), `excluded table ${key}`).toBe(false);
      }
    });

    it("resolves the physical names the binding defines", () => {
      const names = graphRelationNamesOfTables(tables);
      for (const { key } of GRAPH_RELATIONS) {
        const table = bound.get(key);
        const expected =
          table === undefined ? tables.fulltextTableName : getTableName(table);
        expect(names[key], `relation ${key}`).toBe(expected);
      }
    });
  });

  it("lists each relation exactly once", () => {
    expect(new Set(GRAPH_RELATION_KEYS).size).toBe(GRAPH_RELATION_KEYS.length);
    expect(GRAPH_RELATIONS.map((relation) => relation.key)).toEqual([
      ...GRAPH_RELATION_KEYS,
    ]);
  });

  it("agrees with the query compiler's default table names", () => {
    const compilerTables: Readonly<Record<string, string>> =
      createSqlSchema().tables;
    for (const [key, name] of Object.entries(
      resolveGraphRelationNames(undefined),
    )) {
      expect(compilerTables[key], `relation ${key}`).toBe(name);
    }
  });

  it("agrees between the bundled dialects on default relation names", () => {
    const defaults = resolveGraphRelationNames(undefined);
    expect(graphRelationNamesOfTables(sqliteTables)).toEqual(defaults);
    expect(graphRelationNamesOfTables(postgresTables)).toEqual(defaults);
  });
});

describe("graph relation names reach every backend consumer", () => {
  let pool: Pool | undefined;

  afterEach(async () => {
    await pool?.end();
    pool = undefined;
  });

  it("gives the SQLite backend the names its table binding defines", () => {
    const tables = createSqliteTables(customNames());
    const backend = createTestBackend(tables);

    expect(resolveGraphRelationNames(backend.tableNames)).toEqual(
      graphRelationNamesOfTables(tables),
    );
  });

  it("gives the PostgreSQL backend the names its table binding defines", () => {
    pool = new Pool({
      connectionString: "postgresql://placeholder@127.0.0.1:5432/placeholder",
    });
    const tables = createPostgresTables(customNames());
    const backend = createPostgresBackend(drizzle(pool), { tables });

    expect(resolveGraphRelationNames(backend.tableNames)).toEqual(
      graphRelationNamesOfTables(tables),
    );
  });
});

function order(key: GraphRelationKey): number {
  const step = GRAPH_RELATION_CLEAR_SEQUENCE.find(
    (candidate) => candidate.key === key,
  );
  return requireDefined(step, `${key} is not cleared by delete`).clear.order;
}

describe("graph relation clear declarations", () => {
  it("orders every deleted relation uniquely", () => {
    const orders = GRAPH_RELATION_CLEAR_SEQUENCE.map(
      (step) => step.clear.order,
    );
    expect(new Set(orders).size).toBe(orders.length);
    expect(orders).toEqual(orders.toSorted((left, right) => left - right));
  });

  it("clears a relation before the relation whose rows it names", () => {
    expect(order("uniques")).toBeLessThan(order("nodes"));
    expect(order("edgeClaims")).toBeLessThan(order("edges"));
  });

  it("empties the revision journal after every relation its triggers observe", () => {
    for (const journaled of ["nodes", "edges", "identityAssertions"] as const) {
      expect(order("revisionChanges")).toBeGreaterThan(order(journaled));
    }
  });

  it("deletes the revision origin with every other relation, tolerating its absence", () => {
    const origins = requireDefined(
      GRAPH_RELATION_CLEAR_SEQUENCE.find(
        (step) => step.key === "revisionOrigins",
      ),
    );
    expect(origins.clear).toMatchObject({
      kind: "delete",
      missingTable: "tolerated",
    });
    expect(GRAPH_RELATION_CLEAR_SEQUENCE).toHaveLength(GRAPH_RELATIONS.length);
  });

  it("targets the physical names of a custom table binding", () => {
    const tables = createSqliteTables(customNames());
    const names = new Set(Object.values(graphRelationNamesOfTables(tables)));

    const statements = buildClearGraph(tables, "graph", fts5Strategy);

    const tolerated = statements.filter(
      (statement) => statement.ignoreMissingTable === true,
    );
    expect(tolerated.length).toBeGreaterThan(0);
    for (const statement of tolerated) {
      expect(names.has(statement.requiredTableName ?? "")).toBe(true);
    }
  });
});

describe("graph relation working-copy clone policies", () => {
  it("gives every graph-scoped base table the policy its declaration states", () => {
    for (const { key, workingCopyClonePolicy } of GRAPH_RELATIONS) {
      if (key === "fulltext") continue;
      const contribution = postgresContributions(postgresTables).find(
        (candidate) => candidate.logicalName === key,
      );
      expect(contribution?.workingCopyClonePolicy, `relation ${key}`).toEqual(
        workingCopyClonePolicy,
      );
    }
  });

  it("rebuilds rather than copies the per-deployment status relations", () => {
    // Stated independently of the declaration: copying these rows by column
    // shape would attest physical indexes and tables the clone never built.
    expect(
      GRAPH_RELATIONS.filter(
        (relation) =>
          relation.workingCopyClonePolicy.kind === "rebuildAfterClone",
      ).map((relation) => relation.key),
    ).toEqual(["indexMaterializations", "contributionMaterializations"]);
  });

  it("agrees with the bundled fulltext strategy's own declaration", () => {
    const declared =
      graphRelationDeclaration("fulltext").workingCopyClonePolicy;
    const owned = tsvectorStrategy
      .ownedTables(defaultPostgresTableNames.fulltext)
      .map((contribution) => contribution.workingCopyClonePolicy);

    expect(owned).toEqual([declared]);
  });

  it("clones by graph id only what carries a graph_id column", () => {
    for (const { logicalName, workingCopyClonePolicy } of postgresContributions(
      postgresTables,
    )) {
      if (workingCopyClonePolicy?.kind !== "graphRows") continue;
      expect(isGraphRelationKey(logicalName)).toBe(true);
      expect(workingCopyClonePolicy.graphIdColumn).toBe(GRAPH_ID_COLUMN);
    }
  });
});

/** The columns of the table's primary key, in key order, whichever dialect. */
function primaryKeyColumns(table: Table): readonly string[] {
  const primaryKey =
    is(table, PgTable) ?
      getPgTableConfig(table).primaryKeys[0]
    : getSqliteTableConfig(table as SQLiteTable).primaryKeys[0];
  return requireDefined(primaryKey, "table declares a primary key").columns.map(
    (column) => column.name,
  );
}

describe("graph presence anchors", () => {
  it("are exactly the relations whose rows mean a graph holds data", () => {
    // Stated independently of the declaration. Contribution markers are
    // bookkeeping the default clear keeps, so anchoring on them would list a
    // cleared graph forever.
    expect(GRAPH_PRESENCE_ANCHOR_KEYS).toEqual([
      "nodes",
      "edges",
      "schemaVersions",
    ]);
  });

  it("are emptied by a default Store.clear()", () => {
    for (const key of GRAPH_PRESENCE_ANCHOR_KEYS) {
      const { clear } = graphRelationDeclaration(key);
      expect(clear.kind, `relation ${key}`).toBe("delete");
      expect(
        "preservable" in clear && clear.preservable,
        `relation ${key} survives a default clear`,
      ).toBe(false);
    }
  });

  it("carry the byte-ordered graph_id index the listing seeks on PostgreSQL, and nowhere else", () => {
    // The listing walks anchors in byte order; PostgreSQL orders ordinary text
    // indexes by the database collation, so an anchor without this index would
    // make every page scan a table. Stated literally rather than derived from
    // the index declaration under test.
    const expected = new Map([
      [
        "nodes",
        'CREATE INDEX IF NOT EXISTS "typegraph_nodes_graph_id_bytes_idx" ON "typegraph_nodes" ("graph_id" COLLATE "C");',
      ],
      [
        "edges",
        'CREATE INDEX IF NOT EXISTS "typegraph_edges_graph_id_bytes_idx" ON "typegraph_edges" ("graph_id" COLLATE "C");',
      ],
      [
        "schemaVersions",
        'CREATE INDEX IF NOT EXISTS "typegraph_schema_versions_graph_id_bytes_idx" ON "typegraph_schema_versions" ("graph_id" COLLATE "C");',
      ],
    ]);
    expect([...expected.keys()].toSorted()).toEqual(
      [...GRAPH_PRESENCE_ANCHOR_KEYS].toSorted(),
    );
    const carriers = new Map(
      postgresContributions(postgresTables).flatMap((contribution) => {
        const statement = contribution.createDdl.find((ddl) =>
          ddl.includes("graph_id_bytes_idx"),
        );
        return statement === undefined ?
            []
          : [[contribution.logicalName, statement] as const];
      }),
    );
    expect(carriers).toEqual(expected);
    const sqliteCarriers = sqliteContributions(sqliteTables).filter(
      (contribution) =>
        contribution.createDdl.some((ddl) =>
          ddl.includes("graph_id_bytes_idx"),
        ),
    );
    expect(sqliteCarriers).toEqual([]);
  });

  it("are the tables the adoption step and the name reservation cover, under custom names too", () => {
    const overrides = customNames();
    expect(graphIdOrderIndexTables(overrides)).toEqual(
      GRAPH_PRESENCE_ANCHOR_KEYS.map((relation) => ({
        relation,
        table: `custom_${relation}`,
      })),
    );
  });

  describe.each(BINDINGS)("%s", (_label, tables) => {
    it("lead their primary key with graph_id, so graph ids can be walked by index seek", () => {
      const bound = drizzleTables(tables);
      for (const key of GRAPH_PRESENCE_ANCHOR_KEYS) {
        const table = requireDefined(bound.get(key), `table for ${key}`);
        expect(primaryKeyColumns(table)[0], `relation ${key}`).toBe(
          GRAPH_ID_COLUMN,
        );
      }
    });
  });
});
