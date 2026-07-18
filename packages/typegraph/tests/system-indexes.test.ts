/**
 * System-index declarations: single source of truth for TypeGraph's own
 * base-relation indexes.
 *
 * - Dialect parity: both schema factories derive their index builders from
 *   SYSTEM_INDEX_DECLARATIONS, and the extraction test proves the two
 *   dialects' full index sets (including the hand-written structural
 *   remainder) agree name-by-name and column-by-column.
 * - Upgrade path: bootstrap DDL runs only on first boot, so
 *   materializeSystemIndexes() / the createStoreWithSchema boot step are
 *   what carry a new library version's indexes onto an already-initialized
 *   database.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  defineNodeIndex,
  SYSTEM_INDEX_DECLARATIONS,
} from "../src";
import {
  createPostgresTables,
  generatePostgresDDL,
} from "../src/backend/postgres";
import { createSqliteTables, generateSqliteDDL } from "../src/backend/sqlite";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { type GraphBackend } from "../src/backend/types";
import { systemIndexName } from "../src/indexes/system";
import { renderSqlInline, sql } from "../src/query/sql-fragment";
import { asCompiledRowsSql } from "../src/query/sql-intent";
import { requireDefined } from "../src/utils/presence";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const knows = defineEdge("knows");

const graph = defineGraph({
  id: "system-indexes",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

type ExtractedIndex = Readonly<{
  name: string;
  table: string;
  columns: string;
  unique: boolean;
}>;

/**
 * Pulls every plain-column CREATE INDEX out of a generated DDL script.
 * Expression indexes (none exist for system/base tables) and partial
 * WHERE clauses are captured via the trailing segment so the comparison
 * still sees a difference if one dialect grows a predicate.
 */
function extractIndexes(statements: readonly string[]): ExtractedIndex[] {
  const pattern =
    /CREATE (UNIQUE )?INDEX IF NOT EXISTS "([^"]+)" ON "([^"]+)" \(([^;]*)\)(?: WHERE .*)?;/u;
  const extracted: ExtractedIndex[] = [];
  for (const statement of statements) {
    const match = pattern.exec(statement);
    if (match === null) continue;
    extracted.push({
      unique: match[1] !== undefined,
      name: requireDefined(match[2]),
      table: requireDefined(match[3]),
      columns: requireDefined(match[4]),
    });
  }
  return extracted;
}

describe("system-index dialect parity", () => {
  it("emits the same index set (names, columns, uniqueness) on both dialects", () => {
    const sqliteIndexes = extractIndexes(
      generateSqliteDDL(createSqliteTables()),
    );
    const postgresIndexes = extractIndexes(generatePostgresDDL());

    // The fulltext table is an intentional asymmetry: SQLite uses an FTS5
    // virtual table (no plain indexes), Postgres a typed table + GIN.
    const fulltextTable = "typegraph_node_fulltext";
    const normalize = (indexes: readonly ExtractedIndex[]): string[] =>
      indexes
        .filter((index) => index.table !== fulltextTable)
        .map(
          (index) =>
            `${index.unique ? "unique " : ""}${index.table}.${index.name}(${index.columns})`,
        )
        .toSorted((a, b) => a.localeCompare(b));

    const sqliteSet = normalize(sqliteIndexes);
    const postgresSet = normalize(postgresIndexes);
    expect(sqliteSet).toEqual(postgresSet);
    expect(sqliteSet.length).toBeGreaterThan(0);
  });

  it("covers every declaration in both dialects' generated DDL", () => {
    const scripts = [
      generateSqliteDDL(createSqliteTables()).join("\n"),
      generatePostgresDDL(createPostgresTables()).join("\n"),
    ];
    for (const script of scripts) {
      for (const declaration of SYSTEM_INDEX_DECLARATIONS) {
        const columns = declaration.columns
          .map((column) => `"${column}"`)
          .join(", ");
        expect(script).toContain(`(${columns})`);
      }
    }
  });
});

describe("system-index identifier bounds", () => {
  it("keeps every generated name distinct and within 63 characters for long custom table names", () => {
    // A valid 58-char custom table name: naive `${table}_${suffix}` names
    // would exceed PostgreSQL's 63-byte identifier bound, get silently
    // truncated by the engine, and collide (kind_idx vs kind_created_idx
    // share their first 63 chars).
    const longBase = `t${"x".repeat(57)}`;
    // Distinctness matters within one physical table (suffixes repeat
    // across tables by design — their physical names differ in practice).
    // Edges carries the largest suffix set, including the kind_idx /
    // kind_created_idx pair whose first 63 chars collide when naively
    // truncated.
    const edgeNames = SYSTEM_INDEX_DECLARATIONS.filter(
      (declaration) => declaration.table === "edges",
    ).map((declaration) => systemIndexName(longBase, declaration.suffix));
    for (const name of edgeNames) {
      expect(name.length).toBeLessThanOrEqual(63);
    }
    expect(new Set(edgeNames).size).toBe(edgeNames.length);
    // Deterministic: the same inputs must resolve to the same name (the
    // Drizzle builders, runtime DDL, and catalog probes all derive it).
    expect(systemIndexName(longBase, "kind_idx")).toBe(
      systemIndexName(longBase, "kind_idx"),
    );
    // Short names stay exactly as before — no gratuitous hashing.
    expect(systemIndexName("typegraph_nodes", "id_idx")).toBe(
      "typegraph_nodes_id_idx",
    );
  });

  it("emits the bounded names in generated DDL for long custom table names", () => {
    const longNodes = `n${"x".repeat(57)}`;
    const ddl = generateSqliteDDL(createSqliteTables({ nodes: longNodes }));
    const script = ddl.join("\n");
    expect(script).toContain(`"${systemIndexName(longNodes, "kind_idx")}"`);
    expect(script).toContain(
      `"${systemIndexName(longNodes, "kind_created_idx")}"`,
    );
  });
});

describe("system-index name reservation", () => {
  it("rejects a graph-declared index named like a system index at table definition", () => {
    const colliding = defineNodeIndex(Person, {
      fields: ["name"],
      name: "typegraph_nodes_id_idx",
    });
    expect(() => createSqliteTables({}, { indexes: [colliding] })).toThrow(
      /collides with a TypeGraph system index/,
    );
    expect(() => createPostgresTables({}, { indexes: [colliding] })).toThrow(
      /collides with a TypeGraph system index/,
    );
  });

  it("fails a colliding declaration in materializeIndexes without any write", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const colliding = defineNodeIndex(Person, {
        fields: ["name"],
        name: "typegraph_nodes_id_idx",
      });
      const collidingGraph = defineGraph({
        id: "system-indexes-collide",
        nodes: { Person: { type: Person } },
        edges: {},
        indexes: [colliding],
      });
      const [store] = await createStoreWithSchema(collidingGraph, backend);

      const { results } = await store.materializeIndexes();
      const target = results.find(
        (result) => result.indexName === "typegraph_nodes_id_idx",
      );
      expect(target?.status).toBe("failed");
      expect(target?.error?.message).toContain("collides with a TypeGraph");
      // No false-success row was recorded over the system index's name.
      const row = await requireDefined(backend.getIndexMaterialization)(
        "typegraph_nodes_id_idx",
      );
      expect(row?.entity === "node").toBe(false);
    } finally {
      await backend.close();
    }
  });
});

async function indexNames(backend: GraphBackend): Promise<readonly string[]> {
  const rows = await backend.execute<{ name: string }>(
    asCompiledRowsSql(sql`SELECT name FROM sqlite_master WHERE type = 'index'`),
  );
  return rows.map((row) => row.name);
}

describe("materializeSystemIndexes", () => {
  it("adopts indexes missing from an initialized database and records status", async () => {
    const { backend, db } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(graph, backend);

      // Simulate a database initialized by an older library version: the
      // index does not exist and no materialization was ever recorded.
      db.run(
        renderSqlInline(sql`DROP INDEX "typegraph_nodes_id_idx"`, "sqlite"),
      );
      db.run(
        renderSqlInline(
          sql`DROP INDEX "typegraph_recorded_edges_from_idx"`,
          "sqlite",
        ),
      );
      db.run(
        renderSqlInline(
          sql`DELETE FROM "typegraph_index_materializations" WHERE index_name IN ('typegraph_nodes_id_idx', 'typegraph_recorded_edges_from_idx')`,
          "sqlite",
        ),
      );
      expect(await indexNames(backend)).not.toContain("typegraph_nodes_id_idx");

      const { results } = await store.materializeSystemIndexes();
      expect(results).toHaveLength(SYSTEM_INDEX_DECLARATIONS.length);
      // Every entry either created its index or found the recorded boot
      // materialization; none may fail or be skipped on the bundled backend.
      for (const result of results) {
        expect(["created", "alreadyMaterialized"]).toContain(result.status);
        expect(result.entity).toBe("system");
      }

      const adopted = await indexNames(backend);
      expect(adopted).toContain("typegraph_nodes_id_idx");
      expect(adopted).toContain("typegraph_recorded_edges_from_idx");

      // Status rows carry the system entity and the relation key.
      const statusRows = await backend.execute<{
        entity: string;
        kind: string;
      }>(
        asCompiledRowsSql(
          sql`SELECT entity, kind FROM "typegraph_index_materializations" WHERE index_name = 'typegraph_nodes_id_idx'`,
        ),
      );
      expect(statusRows[0]).toEqual({ entity: "system", kind: "nodes" });

      // Second call settles everything without DDL.
      const second = await store.materializeSystemIndexes();
      for (const result of second.results) {
        expect(result.status).toBe("alreadyMaterialized");
      }
    } finally {
      await backend.close();
    }
  });

  it("rebuilds a physically missing index even when a success row survives", async () => {
    const { backend, db } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      // Adopt once so a genuine success row exists for the index.
      db.run(
        renderSqlInline(sql`DROP INDEX "typegraph_nodes_id_idx"`, "sqlite"),
      );
      await store.materializeSystemIndexes();

      // Dump/restore or a manual drop can lose the index but keep the
      // row. Physical state is authoritative for system indexes: the
      // runner must rebuild, not settle on the stale success.
      db.run(
        renderSqlInline(sql`DROP INDEX "typegraph_nodes_id_idx"`, "sqlite"),
      );
      const { results } = await store.materializeSystemIndexes();
      const target = results.find(
        (result) => result.indexName === "typegraph_nodes_id_idx",
      );
      expect(target?.status).toBe("created");
      expect(await indexNames(backend)).toContain("typegraph_nodes_id_idx");
    } finally {
      await backend.close();
    }
  });

  it("reports signature drift persistently instead of self-silencing", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      // A recorded success under a DIFFERENT signature — the shape an
      // in-place declaration change would leave behind.
      await requireDefined(backend.recordIndexMaterialization)({
        indexName: "typegraph_nodes_id_idx",
        graphId: "system-indexes",
        entity: "system",
        kind: "nodes",
        signature: "stale-signature",
        schemaVersion: 1,
        attemptedAt: new Date().toISOString(),
        materializedAt: new Date().toISOString(),
        error: undefined,
      });

      const first = await store.materializeSystemIndexes();
      const firstTarget = first.results.find(
        (result) => result.indexName === "typegraph_nodes_id_idx",
      );
      expect(firstTarget?.status).toBe("failed");
      expect(firstTarget?.error?.message).toContain("different signature");

      // The drift record must not overwrite the row's signature — the
      // second run has to keep failing, not settle as alreadyMaterialized.
      const second = await store.materializeSystemIndexes();
      const secondTarget = second.results.find(
        (result) => result.indexName === "typegraph_nodes_id_idx",
      );
      expect(secondTarget?.status).toBe("failed");
    } finally {
      await backend.close();
    }
  });

  it("refuses a name collision with a graph-declared index without touching its row", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      // A graph-declared index materialized under a system index's name.
      await requireDefined(backend.recordIndexMaterialization)({
        indexName: "typegraph_nodes_id_idx",
        graphId: "someone-elses-graph",
        entity: "node",
        kind: "Person",
        signature: "relational-signature",
        schemaVersion: 3,
        attemptedAt: new Date().toISOString(),
        materializedAt: new Date().toISOString(),
        error: undefined,
      });

      const { results } = await store.materializeSystemIndexes();
      const target = results.find(
        (result) => result.indexName === "typegraph_nodes_id_idx",
      );
      expect(target?.status).toBe("failed");
      expect(target?.error?.message).toContain("Rename the graph-declared");

      // The foreign row is untouched — no drift write bricked it.
      const row = await requireDefined(backend.getIndexMaterialization)(
        "typegraph_nodes_id_idx",
      );
      expect(row?.signature).toBe("relational-signature");
      expect(row?.entity).toBe("node");
      expect(row?.materializedAt).toBeDefined();
    } finally {
      await backend.close();
    }
  });

  it("skips indexes for optional relations the database predates", async () => {
    const { backend, db } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      // A legacy database that predates the recorded relations.
      db.run(
        renderSqlInline(sql`DROP TABLE "typegraph_recorded_edges"`, "sqlite"),
      );
      db.run(
        renderSqlInline(sql`DROP TABLE "typegraph_recorded_nodes"`, "sqlite"),
      );

      const { results } = await store.materializeSystemIndexes();
      const recorded = results.filter(
        (result) =>
          result.kind === "recordedNodes" || result.kind === "recordedEdges",
      );
      expect(recorded.length).toBeGreaterThan(0);
      for (const result of recorded) {
        expect(result.status).toBe("skipped");
        expect(result.reason).toContain("does not exist");
      }
      const live = results.filter(
        (result) => result.kind === "nodes" || result.kind === "edges",
      );
      for (const result of live) {
        expect(result.status).toBe("alreadyMaterialized");
      }

      // Boot on the same legacy database stays quiet too (no failing DDL,
      // no warnings) — the lenient boot path reuses the same runner.
      await createStoreWithSchema(graph, backend);
    } finally {
      await backend.close();
    }
  });

  it("createStoreWithSchema brings an initialized database up to the current index set", async () => {
    const { backend, db } = createLocalSqliteBackend();
    try {
      await createStoreWithSchema(graph, backend);

      db.run(
        renderSqlInline(
          sql`DROP INDEX "typegraph_recorded_nodes_id_idx"`,
          "sqlite",
        ),
      );
      // Clear the recorded materialization so the next boot cannot settle
      // on the (now stale) success row — this mirrors a database created
      // by a version that predates the index entirely, where no status
      // row exists.
      db.run(
        renderSqlInline(
          sql`DELETE FROM "typegraph_index_materializations" WHERE index_name = 'typegraph_recorded_nodes_id_idx'`,
          "sqlite",
        ),
      );

      await createStoreWithSchema(graph, backend);
      expect(await indexNames(backend)).toContain(
        "typegraph_recorded_nodes_id_idx",
      );
    } finally {
      await backend.close();
    }
  });
});
