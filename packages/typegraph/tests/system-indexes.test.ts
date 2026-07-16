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
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asCompiledRowsSql,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  SYSTEM_INDEX_DECLARATIONS,
} from "../src";
import {
  createPostgresTables,
  generatePostgresDDL,
} from "../src/backend/postgres";
import { createSqliteTables, generateSqliteDDL } from "../src/backend/sqlite";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { type GraphBackend } from "../src/backend/types";

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
      name: match[2]!,
      table: match[3]!,
      columns: match[4]!,
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
      db.run(sql`DROP INDEX "typegraph_nodes_id_idx"`);
      db.run(sql`DROP INDEX "typegraph_recorded_edges_from_idx"`);
      db.run(
        sql`DELETE FROM "typegraph_index_materializations" WHERE index_name IN ('typegraph_nodes_id_idx', 'typegraph_recorded_edges_from_idx')`,
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
      db.run(sql`DROP INDEX "typegraph_nodes_id_idx"`);
      await store.materializeSystemIndexes();

      // Dump/restore or a manual drop can lose the index but keep the
      // row. Physical state is authoritative for system indexes: the
      // runner must rebuild, not settle on the stale success.
      db.run(sql`DROP INDEX "typegraph_nodes_id_idx"`);
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
      await backend.recordIndexMaterialization!({
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
      await backend.recordIndexMaterialization!({
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
      const row = await backend.getIndexMaterialization!(
        "typegraph_nodes_id_idx",
      );
      expect(row?.signature).toBe("relational-signature");
      expect(row?.entity).toBe("node");
      expect(row?.materializedAt).toBeDefined();
    } finally {
      await backend.close();
    }
  });

  it("createStoreWithSchema brings an initialized database up to the current index set", async () => {
    const { backend, db } = createLocalSqliteBackend();
    try {
      await createStoreWithSchema(graph, backend);

      db.run(sql`DROP INDEX "typegraph_recorded_nodes_id_idx"`);
      // Clear the recorded materialization so the next boot cannot settle
      // on the (now stale) success row — this mirrors a database created
      // by a version that predates the index entirely, where no status
      // row exists.
      db.run(
        sql`DELETE FROM "typegraph_index_materializations" WHERE index_name = 'typegraph_recorded_nodes_id_idx'`,
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
