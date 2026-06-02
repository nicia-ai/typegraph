/**
 * sqlite-vec strategy — executable verification.
 *
 * Runs the SQL `sqliteVecStrategy` generates against a real better-sqlite3
 * connection with the sqlite-vec extension loaded, proving the per-field
 * `vec0` virtual-table DDL, DELETE+INSERT upsert, brute-force search, real
 * `vec0` KNN (`MATCH … k =`), partition-correct multi-graph filtering,
 * minScore filtering, and delete all execute and rank correctly.
 */
import Database from "better-sqlite3";
import { type SQL, sql } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type VectorSearchParams } from "../../../src/backend/types";
import { sqliteVecStrategy } from "../../../src/query/dialect/vector/sqlite-vec-strategy";
import { type VectorSlot } from "../../../src/query/dialect/vector-strategy";

const dialect = new SQLiteSyncDialect();

function loadSqliteVec(db: Database.Database): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteVec = require("sqlite-vec") as {
      load: (db: Database.Database) => void;
    };
    sqliteVec.load(db);
    return true;
  } catch {
    return false;
  }
}

function run(
  db: Database.Database,
  query: SQL,
): readonly Record<string, unknown>[] {
  const compiled = dialect.sqlToQuery(query);
  return db.prepare(compiled.sql).all(...compiled.params) as readonly Record<
    string,
    unknown
  >[];
}

function exec(db: Database.Database, query: SQL): void {
  const compiled = dialect.sqlToQuery(query);
  db.prepare(compiled.sql).run(...compiled.params);
}

function execAll(db: Database.Database, queries: readonly SQL[]): void {
  for (const query of queries) exec(db, query);
}

const GRAPH = "g1";
const TS = "2026-06-01T00:00:00.000Z";

function slot(indexType: VectorSlot["indexType"]): VectorSlot {
  return {
    graphId: GRAPH,
    nodeKind: "Document",
    fieldPath: "embedding",
    dimensions: 3,
    metric: "cosine",
    indexType,
  };
}

function searchParams(
  queryEmbedding: readonly number[],
  overrides: Partial<VectorSearchParams> = {},
): VectorSearchParams {
  return {
    graphId: GRAPH,
    nodeKind: "Document",
    fieldPath: "embedding",
    queryEmbedding,
    metric: "cosine",
    dimensions: 3,
    indexType: "none",
    limit: 10,
    ...overrides,
  };
}

describe("sqliteVecStrategy (executed against better-sqlite3 + sqlite-vec)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    if (!loadSqliteVec(db)) {
      db.close();
      throw new Error(
        "sqlite-vec extension failed to load — required for this suite",
      );
    }
  });
  afterEach(() => {
    db.close();
  });

  function createStorage(s: VectorSlot): void {
    for (const contribution of sqliteVecStrategy.ownedTables(s)) {
      for (const ddl of contribution.createDdl) {
        db.exec(ddl);
      }
    }
  }

  function upsert(
    s: VectorSlot,
    nodeId: string,
    embedding: readonly number[],
    graphId = GRAPH,
  ): void {
    execAll(
      db,
      sqliteVecStrategy.buildUpsert(
        s,
        {
          graphId,
          nodeKind: s.nodeKind,
          nodeId,
          fieldPath: s.fieldPath,
          embedding,
          dimensions: s.dimensions,
          metric: s.metric,
          indexType: s.indexType,
        },
        TS,
      ),
    );
  }

  it("creates a per-field vec0 virtual table named from (kind, field)", () => {
    const s = slot("none");
    createStorage(s);
    const table = sqliteVecStrategy.tableName(GRAPH, "Document", "embedding");
    // Readable prefix + an exact-tuple hash suffix (collision-safe).
    expect(table).toMatch(/^tg_vec_g1_document_embedding_[0-9a-f]{8}$/u);
    const info = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .all(table);
    expect(info.length).toBe(1);
  });

  it("brute-force search ranks by cosine similarity (closest first)", () => {
    const s = slot("none");
    createStorage(s);
    upsert(s, "d1", [1, 0, 0]);
    upsert(s, "d2", [0, 1, 0]);
    upsert(s, "d3", [0.9, 0.1, 0]);

    const rows = run(
      db,
      sqliteVecStrategy.buildSearch(s, searchParams([1, 0, 0])),
    );
    const ids = rows.map((r) => r.node_id as string);
    expect(ids[0]).toBe("d1");
    expect(ids[1]).toBe("d3");
    expect(ids[2]).toBe("d2");
    expect(Number(rows[0]?.score)).toBeCloseTo(1, 5);
  });

  it("upsert replaces an existing embedding for the same node", () => {
    const s = slot("none");
    createStorage(s);
    upsert(s, "d1", [0, 1, 0]);
    upsert(s, "d1", [1, 0, 0]);
    const rows = run(
      db,
      sqliteVecStrategy.buildSearch(s, searchParams([1, 0, 0])),
    );
    expect(rows.length).toBe(1);
    expect(Number(rows[0]?.score)).toBeCloseTo(1, 5);
  });

  it("minScore filters out dissimilar rows (brute force)", () => {
    const s = slot("none");
    createStorage(s);
    upsert(s, "d1", [1, 0, 0]);
    upsert(s, "d2", [0, 1, 0]); // orthogonal → cosine similarity 0
    const rows = run(
      db,
      sqliteVecStrategy.buildSearch(
        s,
        searchParams([1, 0, 0], { minScore: 0.5 }),
      ),
    );
    expect(rows.map((r) => r.node_id as string)).toEqual(["d1"]);
  });

  it("delete removes a node's embedding", () => {
    const s = slot("none");
    createStorage(s);
    upsert(s, "d1", [1, 0, 0]);
    execAll(
      db,
      sqliteVecStrategy.buildDelete(s, {
        graphId: GRAPH,
        nodeKind: s.nodeKind,
        nodeId: "d1",
        fieldPath: s.fieldPath,
        dimensions: s.dimensions,
        metric: s.metric,
        indexType: s.indexType,
      }),
    );
    const rows = run(
      db,
      sqliteVecStrategy.buildSearch(s, searchParams([1, 0, 0])),
    );
    expect(rows.length).toBe(0);
  });

  it("ANN (hnsw) slot: vec0 KNN returns nearest neighbors", () => {
    const s = slot("hnsw");
    createStorage(s);
    upsert(s, "d1", [1, 0, 0]);
    upsert(s, "d2", [0, 1, 0]);
    upsert(s, "d3", [0.9, 0.1, 0]);

    const rows = run(
      db,
      sqliteVecStrategy.buildSearch(s, searchParams([1, 0, 0], { limit: 2 })),
    );
    const ids = rows.map((r) => r.node_id as string);
    expect(ids).toHaveLength(2);
    expect(ids).toContain("d1");
    expect(ids).not.toContain("d2"); // orthogonal vector excluded from top-2
  });

  it("ANN (hnsw) slot: minScore filters within KNN", () => {
    const s = slot("hnsw");
    createStorage(s);
    upsert(s, "d1", [1, 0, 0]);
    upsert(s, "d2", [0, 1, 0]); // cosine similarity 0 → below 0.5 floor
    upsert(s, "d3", [0.9, 0.1, 0]);
    const rows = run(
      db,
      sqliteVecStrategy.buildSearch(
        s,
        searchParams([1, 0, 0], { minScore: 0.5 }),
      ),
    );
    const ids = rows.map((r) => r.node_id as string);
    expect(ids).toContain("d1");
    expect(ids).not.toContain("d2");
  });

  it("KNN is partition-correct: another graph's near vector does not leak", () => {
    const s = slot("hnsw");
    createStorage(s);
    upsert(s, "d1", [1, 0, 0], GRAPH);
    upsert(s, "other", [1, 0, 0], "g2"); // identical vector, different graph
    const rows = run(
      db,
      sqliteVecStrategy.buildSearch(s, searchParams([1, 0, 0], { limit: 10 })),
    );
    const ids = rows.map((r) => r.node_id as string);
    expect(ids).toEqual(["d1"]);
    expect(ids).not.toContain("other");
  });

  it("l2 metric ranks by distance (brute force)", () => {
    const s: VectorSlot = { ...slot("none"), metric: "l2" };
    createStorage(s);
    upsert(s, "d1", [1, 0, 0]);
    upsert(s, "d2", [0, 5, 0]);
    upsert(s, "d3", [0.9, 0.1, 0]);
    const rows = run(
      db,
      sqliteVecStrategy.buildSearch(
        s,
        searchParams([1, 0, 0], { metric: "l2" }),
      ),
    );
    const ids = rows.map((r) => r.node_id as string);
    expect(ids[0]).toBe("d1");
    expect(ids[1]).toBe("d3");
    expect(ids[2]).toBe("d2");
  });

  it("distanceExpression brute-forces the vec0 embedding column directly", () => {
    const s = slot("none");
    createStorage(s);
    upsert(s, "d1", [1, 0, 0]);
    upsert(s, "d2", [0, 1, 0]);
    const table = sqliteVecStrategy.tableName(GRAPH, "Document", "embedding");
    const distance = sqliteVecStrategy.distanceExpression(
      sql`"embedding"`,
      [1, 0, 0],
      "cosine",
    );
    // The compiler CTE path uses distanceExpression to scan the per-field
    // table; prove it computes a correct cosine distance over the vec0 column.
    const rows = run(
      db,
      sql`SELECT "node_id" AS node_id, ${distance} AS d FROM ${sql.raw(`"${table}"`)} WHERE "graph_id" = ${GRAPH} ORDER BY d ASC`,
    );
    expect(rows[0]?.node_id).toBe("d1");
    expect(Number(rows[0]?.d)).toBeCloseTo(0, 5);
  });

  it("buildCreateIndex / buildDropIndex are no-ops (vec0 indexes inline)", () => {
    const s = slot("hnsw");
    expect(sqliteVecStrategy.buildCreateIndex?.(s)).toBeUndefined();
    expect(sqliteVecStrategy.buildDropIndex?.(s)).toBeUndefined();
  });

  it("advertises cosine+l2, hnsw+none, and no inner_product", () => {
    expect(sqliteVecStrategy.capabilities.metrics).toEqual(["cosine", "l2"]);
    expect(sqliteVecStrategy.capabilities.indexTypes).toEqual(["hnsw", "none"]);
    expect(sqliteVecStrategy.capabilities.metrics).not.toContain(
      "inner_product",
    );
  });

  it("rejects inner_product at DDL and search time", () => {
    const s: VectorSlot = { ...slot("none"), metric: "inner_product" };
    expect(() => sqliteVecStrategy.ownedTables(s)).toThrow(/inner_product/);
    expect(() =>
      sqliteVecStrategy.distanceExpression(
        sql`"embedding"`,
        [1, 0, 0],
        "inner_product",
      ),
    ).toThrow(/inner_product/);
  });
});
