/**
 * Tests for `migrateLegacyEmbeddings` — the one-time offline migration from
 * the legacy shared `typegraph_node_embeddings` table to the per-field
 * `VectorStrategy` storage (the #157 clean cut).
 *
 * Runs against a real `createLocalSqliteBackend` (better-sqlite3 + sqlite-vec)
 * so the whole round-trip is exercised end-to-end: the legacy `vec_f32` blob
 * is decoded via `vec_to_json`, re-inserted into the strategy's per-field
 * `vec0` virtual tables, and the migrated vectors are then searchable through
 * `backend.vectorSearch`. Idempotency, graph scoping, the metric resolver,
 * and the absent-table no-op are each covered.
 */
import { sql } from "drizzle-orm";
import { type BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateLegacyEmbeddings } from "../src/backend/migrate-vectors";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { type GraphBackend } from "../src/backend/types";
import { asCompiledRowsSql } from "../src/query/sql-intent";
import { isMissingTableError } from "../src/utils/sql-errors";

const LEGACY_TABLE = "typegraph_node_embeddings";
const TS = "2026-06-01T00:00:00.000Z";

type LegacySeed = Readonly<{
  graphId: string;
  nodeKind: string;
  nodeId: string;
  fieldPath: string;
  embedding: readonly number[];
}>;

describe("migrateLegacyEmbeddings (sqlite-vec, end-to-end)", () => {
  let backend: GraphBackend;
  // The raw Drizzle handle seeds the legacy table directly — `db.run` is the
  // no-row write path for the sync better-sqlite3 driver (`backend.execute`
  // is read-only on this driver and throws on a no-row statement).
  let db: BaseSQLiteDatabase<"sync", unknown>;

  beforeEach(() => {
    const created = createLocalSqliteBackend();
    backend = created.backend;
    db = created.db;
    if (backend.vectorStrategy === undefined) {
      throw new Error(
        "sqlite-vec must be loaded for this suite (vectorStrategy missing)",
      );
    }
  });

  afterEach(async () => {
    await backend.close();
  });

  /**
   * Creates the legacy shared embeddings table and seeds it the way the
   * pre-cutover SQLite write path did — `vec_f32('[…]')` blobs in one
   * variable-dimension column.
   */
  function seedLegacy(rows: readonly LegacySeed[]): void {
    db.run(sql`
      CREATE TABLE IF NOT EXISTS ${sql.raw(`"${LEGACY_TABLE}"`)} (
        "graph_id" TEXT NOT NULL,
        "node_kind" TEXT NOT NULL,
        "node_id" TEXT NOT NULL,
        "field_path" TEXT NOT NULL,
        "embedding" BLOB NOT NULL,
        "dimensions" INTEGER NOT NULL,
        "created_at" TEXT NOT NULL,
        "updated_at" TEXT NOT NULL,
        PRIMARY KEY ("graph_id", "node_kind", "node_id", "field_path")
      );
    `);
    for (const row of rows) {
      db.run(sql`
        INSERT INTO ${sql.raw(`"${LEGACY_TABLE}"`)}
          ("graph_id", "node_kind", "node_id", "field_path", "embedding", "dimensions", "created_at", "updated_at")
        VALUES (
          ${row.graphId}, ${row.nodeKind}, ${row.nodeId}, ${row.fieldPath},
          vec_f32(${JSON.stringify(row.embedding)}), ${row.embedding.length}, ${TS}, ${TS}
        )
      `);
    }
  }

  /** Counts rows in a strategy-owned per-field table for a graph. */
  async function countPerField(
    nodeKind: string,
    fieldPath: string,
    graphId: string,
  ): Promise<number> {
    const table = backend.vectorStrategy!.tableName(
      graphId,
      nodeKind,
      fieldPath,
    );
    try {
      const rows = await backend.execute<{ c: number }>(
        asCompiledRowsSql(sql`
          SELECT COUNT(*) AS c
          FROM ${sql.raw(`"${table}"`)}
          WHERE "graph_id" = ${graphId}
        `),
      );
      return rows[0]?.c ?? 0;
    } catch (error) {
      // Graph-scoped storage: a graph with no migrated embeddings has no
      // per-field table at all — that is zero rows, not an error.
      if (isMissingTableError(error)) return 0;
      throw error;
    }
  }

  it("returns a clean no-op when the legacy table is absent", async () => {
    const result = await migrateLegacyEmbeddings({ backend });
    expect(result).toEqual({
      migrated: 0,
      perField: {},
      skippedDimensionMismatch: {},
      skippedDecodeError: {},
      legacyTablePresent: false,
    });
  });

  it("migrates legacy rows into per-field storage and makes them searchable", async () => {
    seedLegacy([
      {
        graphId: "g1",
        nodeKind: "Document",
        nodeId: "d1",
        fieldPath: "embedding",
        embedding: [1, 0, 0],
      },
      {
        graphId: "g1",
        nodeKind: "Document",
        nodeId: "d2",
        fieldPath: "embedding",
        embedding: [0, 1, 0],
      },
      {
        graphId: "g1",
        nodeKind: "Sentence",
        nodeId: "s1",
        fieldPath: "vector",
        embedding: [0, 0, 1],
      },
    ]);

    const result = await migrateLegacyEmbeddings({ backend });

    expect(result.legacyTablePresent).toBe(true);
    expect(result.migrated).toBe(3);
    expect(result.perField).toEqual({
      "Document.embedding": 2,
      "Sentence.vector": 1,
    });

    expect(await countPerField("Document", "embedding", "g1")).toBe(2);
    expect(await countPerField("Sentence", "vector", "g1")).toBe(1);

    // The migrated vectors rank correctly through the real search path.
    const hits = await backend.vectorSearch!({
      graphId: "g1",
      nodeKind: "Document",
      fieldPath: "embedding",
      queryEmbedding: [1, 0, 0],
      metric: "cosine",
      dimensions: 3,
      indexType: "none",
      limit: 10,
    });
    expect(hits[0]?.nodeId).toBe("d1");
    expect(hits.map((hit) => hit.nodeId)).toEqual(["d1", "d2"]);
  });

  it("is idempotent — re-running converges and does not double-insert", async () => {
    seedLegacy([
      {
        graphId: "g1",
        nodeKind: "Document",
        nodeId: "d1",
        fieldPath: "embedding",
        embedding: [1, 0, 0],
      },
    ]);

    const first = await migrateLegacyEmbeddings({ backend });
    const second = await migrateLegacyEmbeddings({ backend });

    expect(first.migrated).toBe(1);
    expect(second.migrated).toBe(1); // re-reads the same legacy row
    // But the per-field table still holds exactly one row (upsert, not append).
    expect(await countPerField("Document", "embedding", "g1")).toBe(1);
  });

  it("batches across many rows via keyset pagination", async () => {
    const rows: LegacySeed[] = [];
    for (let index = 0; index < 25; index++) {
      rows.push({
        graphId: "g1",
        nodeKind: "Document",
        nodeId: `d${index.toString().padStart(3, "0")}`,
        fieldPath: "embedding",
        embedding: [index, 1, 0],
      });
    }
    seedLegacy(rows);

    const result = await migrateLegacyEmbeddings({ backend, batchSize: 7 });

    expect(result.migrated).toBe(25);
    expect(await countPerField("Document", "embedding", "g1")).toBe(25);
  });

  it("scopes migration to a single graph when graphId is given", async () => {
    seedLegacy([
      {
        graphId: "g1",
        nodeKind: "Document",
        nodeId: "d1",
        fieldPath: "embedding",
        embedding: [1, 0, 0],
      },
      {
        graphId: "g2",
        nodeKind: "Document",
        nodeId: "d2",
        fieldPath: "embedding",
        embedding: [0, 1, 0],
      },
    ]);

    const result = await migrateLegacyEmbeddings({ backend, graphId: "g1" });

    expect(result.migrated).toBe(1);
    expect(await countPerField("Document", "embedding", "g1")).toBe(1);
    expect(await countPerField("Document", "embedding", "g2")).toBe(0);
  });

  it("honors resolveSlotConfig for non-default metric / index type", async () => {
    seedLegacy([
      {
        graphId: "g1",
        nodeKind: "Image",
        nodeId: "i1",
        fieldPath: "embedding",
        embedding: [3, 4, 0],
      },
    ]);

    const seen: (readonly [string, string])[] = [];
    const result = await migrateLegacyEmbeddings({
      backend,
      resolveSlotConfig: (nodeKind, fieldPath) => {
        seen.push([nodeKind, fieldPath]);
        return { metric: "l2", indexType: "none" };
      },
    });

    expect(result.migrated).toBe(1);
    expect(seen).toEqual([["Image", "embedding"]]);

    // The l2-shaped vec0 table scores by raw distance.
    const hits = await backend.vectorSearch!({
      graphId: "g1",
      nodeKind: "Image",
      fieldPath: "embedding",
      queryEmbedding: [3, 4, 0],
      metric: "l2",
      dimensions: 3,
      indexType: "none",
      limit: 10,
    });
    expect(hits[0]?.nodeId).toBe("i1");
    expect(hits[0]?.score).toBeCloseTo(0, 4);
  });

  it("throws when the backend has no vectorStrategy", async () => {
    const strategyless: GraphBackend = {
      ...backend,
      vectorStrategy: undefined,
    };
    await expect(
      migrateLegacyEmbeddings({ backend: strategyless }),
    ).rejects.toThrow(/requires a backend wired with a vectorStrategy/u);
  });

  it("rejects a non-positive batchSize", async () => {
    await expect(
      migrateLegacyEmbeddings({ backend, batchSize: 0 }),
    ).rejects.toThrow(/batchSize must be a positive integer/u);
  });

  it("skips dimension-mismatched legacy rows instead of aborting (#11)", async () => {
    // The legacy shared column allowed mixed dimensions for one (kind, field);
    // the per-field table fixes at the first row's dimension and later
    // differently-sized rows are skipped + reported, not fatal.
    seedLegacy([
      {
        graphId: "g1",
        nodeKind: "Document",
        nodeId: "d1",
        fieldPath: "embedding",
        embedding: [1, 0, 0],
      },
      {
        graphId: "g1",
        nodeKind: "Document",
        nodeId: "d2",
        fieldPath: "embedding",
        embedding: [1, 0, 0, 0], // 4-dim — mismatches the 3-dim table
      },
    ]);

    const result = await migrateLegacyEmbeddings({ backend });

    expect(result.migrated).toBe(1);
    expect(result.perField).toEqual({ "Document.embedding": 1 });
    expect(result.skippedDimensionMismatch).toEqual({
      "Document.embedding": 1,
    });
  });

  it("skips a row whose embedding can't be decoded instead of aborting (#4)", async () => {
    // A corrupt legacy value (e.g. an older pgvector that stored NaN, rendered
    // as the non-JSON literal `[1,NaN,3]`) must be skipped + reported, not abort
    // the whole migration. Inject one by intercepting the legacy batch read.
    const malformedBatch = [
      {
        graph_id: "g1",
        node_kind: "Document",
        node_id: "bad",
        field_path: "embedding",
        embedding_json: "[1,NaN,3]",
      },
      {
        graph_id: "g1",
        node_kind: "Document",
        node_id: "good",
        field_path: "embedding",
        embedding_json: "[1,2,3]",
      },
    ];
    let reads = 0;
    const wrapped: GraphBackend = {
      ...backend,
      execute: (() => {
        reads += 1;
        return Promise.resolve(reads === 1 ? malformedBatch : []);
      }) as GraphBackend["execute"],
    };

    const result = await migrateLegacyEmbeddings({ backend: wrapped });

    expect(result.migrated).toBe(1);
    expect(result.perField).toEqual({ "Document.embedding": 1 });
    expect(result.skippedDecodeError).toEqual({ "Document.embedding": 1 });
  });
});
