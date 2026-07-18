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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type VectorSearchParams } from "../../../src/backend/types";
import { sqliteVecStrategy } from "../../../src/query/dialect/vector/sqlite-vec-strategy";
import { type VectorSlot } from "../../../src/query/dialect/vector-strategy";
import {
  renderSqlite,
  sql,
  type SqlFragment,
} from "../../../src/query/sql-fragment";

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
  query: SqlFragment,
): readonly Record<string, unknown>[] {
  const compiled = renderSqlite(query);
  return db.prepare(compiled.sql).all(...compiled.params) as readonly Record<
    string,
    unknown
  >[];
}

function exec(db: Database.Database, query: SqlFragment): void {
  const compiled = renderSqlite(query);
  db.prepare(compiled.sql).run(...compiled.params);
}

function execAll(db: Database.Database, queries: readonly SqlFragment[]): void {
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

/** Builds a `node_id IN (...)` candidate subquery from an id list. */
function candidateIds(nodeIds: readonly string[]): SqlFragment {
  return sql.join(
    nodeIds.map((nodeId) => sql`SELECT ${nodeId}`),
    sql` UNION ALL `,
  );
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

  /** Runs an ANN `buildSearch` and returns the node ids in ranked order. */
  function pageIds(
    s: VectorSlot,
    overrides: Partial<VectorSearchParams>,
    candidates?: SqlFragment,
  ): string[] {
    const rows = run(
      db,
      sqliteVecStrategy.buildSearch(
        s,
        searchParams([1, 0, 0], { indexType: "hnsw", ...overrides }),
        candidates,
      ),
    );
    return rows.map((row) => row["node_id"] as string);
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
    const ids = rows.map((r) => r["node_id"] as string);
    expect(ids[0]).toBe("d1");
    expect(ids[1]).toBe("d3");
    expect(ids[2]).toBe("d2");
    expect(Number(rows[0]?.["score"])).toBeCloseTo(1, 5);
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
    expect(Number(rows[0]?.["score"])).toBeCloseTo(1, 5);
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
    expect(rows.map((r) => r["node_id"] as string)).toEqual(["d1"]);
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
    const ids = rows.map((r) => r["node_id"] as string);
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
    const ids = rows.map((r) => r["node_id"] as string);
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
    const ids = rows.map((r) => r["node_id"] as string);
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
    const ids = rows.map((r) => r["node_id"] as string);
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
    expect(rows[0]?.["node_id"]).toBe("d1");
    expect(Number(rows[0]?.["d"])).toBeCloseTo(0, 5);
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

  // ============================================================
  // Filtered KNN recall — the `"filter-pushdown"` capability, executed.
  //
  // The mirror of the libSQL suite's under-fill boundary test
  // (`libsql-vector-strategy.test.ts`). Same fixture, same filter, same
  // limit — vec0 pushes the candidate filter into the KNN and fills the page
  // where DiskANN's post-filter returns short.
  // ============================================================
  describe("filtered approximate search (capabilities.filteredApproximateSearch)", () => {
    const FAN_SIZE = 200;

    /** Cosine distance to `[1, 0, 0]` grows with the index: `dN` has rank N+1. */
    function seedRankedFan(s: VectorSlot): void {
      for (let index = 0; index < FAN_SIZE; index += 1) {
        upsert(s, `d${index}`, [1, index * 0.001, 0]);
      }
    }

    it("declares that a filtered KNN page is exact", () => {
      expect(sqliteVecStrategy.capabilities.filteredApproximateSearch).toEqual({
        mode: "filter-pushdown",
        guaranteesFullPage: true,
      });
    });

    it("fills the page even when the surviving candidates rank last", () => {
      const s = slot("hnsw");
      createStorage(s);
      seedRankedFan(s);

      // Ranks 199 and 200 of 200. libSQL's DiskANN returns nothing here (it
      // only ever looks at 4 × limit neighbors); vec0's KNN constrains its own
      // candidate set with the filter, so both live rows come back.
      const rows = run(
        db,
        sqliteVecStrategy.buildSearch(
          s,
          searchParams([1, 0, 0], { limit: 2, indexType: "hnsw" }),
          candidateIds(["d198", "d199"]),
        ),
      );
      expect(rows.map((row) => row["node_id"])).toEqual(["d198", "d199"]);
    });
  });

  // ============================================================
  // vec0 KNN paging with offset > 0 — the MATERIALIZED page wrapper.
  //
  // vec0's `MATCH … k = ?` query cannot carry a LIMIT, so for a paged
  // request buildSearch fetches `limit + offset` neighbors and pages them in
  // a `WITH knn_page AS MATERIALIZED (…)` wrapper. The MATERIALIZED fence is
  // load-bearing: without it SQLite flattens the subquery and pushes the
  // outer LIMIT into the vec0 MATCH, which rejects `k = ?` + LIMIT together.
  // These tests pin the paged ranking against a real connection.
  // ============================================================
  describe("vec0 KNN paging (offset > 0)", () => {
    // Six vectors fanned off [1,0,0] by a growing y-component: cosine
    // distance rises monotonically with the index, so d0…d5 is the exact
    // nearest-first ranking for the query [1,0,0].
    const RANKED_IDS = ["d0", "d1", "d2", "d3", "d4", "d5"] as const;

    function seedRanked(s: VectorSlot): void {
      for (const [index, id] of RANKED_IDS.entries()) {
        upsert(s, id, [1, index * 0.01, 0]);
      }
    }

    it("offset 0 and offset N return disjoint, correctly-ranked pages", () => {
      const s = slot("hnsw");
      createStorage(s);
      seedRanked(s);

      const page0 = pageIds(s, { limit: 2, offset: 0 });
      const page1 = pageIds(s, { limit: 2, offset: 2 });
      const page2 = pageIds(s, { limit: 2, offset: 4 });

      expect(page0).toEqual(["d0", "d1"]);
      expect(page1).toEqual(["d2", "d3"]);
      expect(page2).toEqual(["d4", "d5"]);
      // Pairwise disjoint: three 2-row pages, six distinct ids.
      expect(new Set([...page0, ...page1, ...page2]).size).toBe(6);
    });

    it("the union of two pages equals the unpaged top-(limit + offset)", () => {
      const s = slot("hnsw");
      createStorage(s);
      seedRanked(s);

      // Unpaged reference: the top-4 the two limit-2 pages must tile exactly.
      const unpaged = pageIds(s, { limit: 4, offset: 0 });
      expect(unpaged).toEqual(["d0", "d1", "d2", "d3"]);

      const firstPage = pageIds(s, { limit: 2, offset: 0 });
      const secondPage = pageIds(s, { limit: 2, offset: 2 });
      expect([...firstPage, ...secondPage]).toEqual(unpaged);
    });

    it("offset past the end returns empty", () => {
      const s = slot("hnsw");
      createStorage(s);
      seedRanked(s);

      // knnK = 2 + 10 = 12 > 6 rows, so the page wrapper skips past every row.
      expect(pageIds(s, { limit: 2, offset: 10 })).toEqual([]);
    });

    it("offset combines with minScore (the floor trims the KNN body first)", () => {
      const s = slot("hnsw");
      createStorage(s);
      // d0…d2 sit near the query (cosine similarity > 0.9); d3 is orthogonal
      // (similarity 0), below the 0.5 floor.
      upsert(s, "d0", [1, 0, 0]);
      upsert(s, "d1", [1, 0.05, 0]);
      upsert(s, "d2", [1, 0.1, 0]);
      upsert(s, "d3", [0, 1, 0]);

      // knnK = 3 + 1 = 4 pulls all four rows; minScore 0.5 drops d3 from the
      // KNN body, leaving [d0, d1, d2]; OFFSET 1 then skips d0.
      const page = pageIds(s, { limit: 3, offset: 1, minScore: 0.5 });
      expect(page).toEqual(["d1", "d2"]);
      expect(page).not.toContain("d3");
    });

    it("offset combines with a candidates filter (pushed into the KNN)", () => {
      const s = slot("hnsw");
      createStorage(s);
      seedRanked(s);

      // Restrict the KNN to {d0, d2, d4}: their nearest-first order is that
      // same subsequence. knnK = 2 + 1 = 3 pulls all three candidates; OFFSET
      // 1 then skips d0.
      const page = pageIds(
        s,
        { limit: 2, offset: 1 },
        candidateIds(["d0", "d2", "d4"]),
      );
      expect(page).toEqual(["d2", "d4"]);
      // Neither a non-candidate nor the paged-past candidate leaks in.
      for (const excluded of ["d0", "d1", "d3", "d5"]) {
        expect(page).not.toContain(excluded);
      }
    });
  });
});
