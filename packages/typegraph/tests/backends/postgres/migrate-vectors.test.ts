/**
 * Postgres-specific tests for `migrateLegacyEmbeddings`.
 *
 * Exercises the pgvector decode path (`embedding::text` → JSON array) end to
 * end: a legacy shared `typegraph_node_embeddings` table holding native
 * `vector` rows is drained into the `pgvectorStrategy` per-field storage, and
 * the migrated vectors are then searchable through `backend.vectorSearch`.
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { migrateLegacyEmbeddings } from "../../../src/backend/migrate-vectors";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { type GraphBackend } from "../../../src/backend/types";
import { isMissingTableError } from "../../../src/utils/sql-errors";

const TEST_DATABASE_URL =
  process.env.POSTGRES_URL ??
  "postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test";

const LEGACY_TABLE = "typegraph_node_embeddings";

let sharedPool: Pool | undefined;
let isPostgresAvailable = false;

function requirePostgres(ctx: { skip: () => void }): { pool: Pool } {
  if (!isPostgresAvailable || sharedPool === undefined) {
    ctx.skip();
    throw new Error("unreachable");
  }
  return { pool: sharedPool };
}

beforeAll(async () => {
  if (!process.env.POSTGRES_URL) return;
  const pool = new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  try {
    await pool.query("SELECT 1");
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    sharedPool = pool;
    isPostgresAvailable = true;
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    await pool.end().catch(() => {});
  }
});

afterAll(async () => {
  if (sharedPool !== undefined) await sharedPool.end();
});

beforeEach(async () => {
  if (sharedPool === undefined) return;
  await sharedPool.query(`DROP TABLE IF EXISTS "${LEGACY_TABLE}" CASCADE`);
  const tables = await sharedPool.query<{ tablename: string }>(
    String.raw`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'tg_vec\_%'`,
  );
  for (const { tablename } of tables.rows) {
    await sharedPool.query(`DROP TABLE IF EXISTS "${tablename}" CASCADE`);
  }
  // Drop the durable contribution markers (#135) in lockstep with the per-
  // field tables above: `migrateLegacyEmbeddings` now provisions each slot via
  // `ensureVectorSlotContribution`, which trusts the marker and skips the
  // CREATE when one already exists. On this shared, long-lived database a
  // marker left over from a prior run would outlive the dropped table and the
  // migration's first write would hit a missing relation.
  await sharedPool.query(
    `DROP TABLE IF EXISTS "typegraph_contribution_materializations" CASCADE`,
  );
});

type LegacySeed = Readonly<{
  graphId: string;
  nodeKind: string;
  nodeId: string;
  fieldPath: string;
  embedding: readonly number[];
}>;

/**
 * Creates the legacy shared embeddings table with an unparameterized native
 * `vector` column (its pre-cutover shape) and seeds it.
 */
async function seedLegacy(
  pool: Pool,
  rows: readonly LegacySeed[],
): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "${LEGACY_TABLE}" (
      "graph_id" TEXT NOT NULL,
      "node_kind" TEXT NOT NULL,
      "node_id" TEXT NOT NULL,
      "field_path" TEXT NOT NULL,
      "embedding" vector NOT NULL,
      "dimensions" INTEGER NOT NULL,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY ("graph_id", "node_kind", "node_id", "field_path")
    );
  `);
  for (const row of rows) {
    await pool.query(
      `INSERT INTO "${LEGACY_TABLE}"
         ("graph_id", "node_kind", "node_id", "field_path", "embedding", "dimensions")
       VALUES ($1, $2, $3, $4, $5::vector, $6)`,
      [
        row.graphId,
        row.nodeKind,
        row.nodeId,
        row.fieldPath,
        `[${row.embedding.join(",")}]`,
        row.embedding.length,
      ],
    );
  }
}

async function countPerField(
  backend: GraphBackend,
  pool: Pool,
  nodeKind: string,
  fieldPath: string,
  graphId: string,
): Promise<number> {
  const table = backend.vectorStrategy!.tableName(graphId, nodeKind, fieldPath);
  try {
    const result = await pool.query<{ c: string }>(
      `SELECT COUNT(*) AS c FROM "${table}" WHERE "graph_id" = $1`,
      [graphId],
    );
    return Number(result.rows[0]?.c ?? 0);
  } catch (error) {
    // Graph-scoped storage: a graph with no migrated embeddings has no
    // per-field table at all — that is zero rows, not an error.
    if (isMissingTableError(error)) return 0;
    throw error;
  }
}

describe("migrateLegacyEmbeddings (pgvector, end-to-end)", () => {
  it("returns a clean no-op when the legacy table is absent", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    const backend = createPostgresBackend(drizzle(pool));
    const result = await migrateLegacyEmbeddings({ backend });
    expect(result).toEqual({
      migrated: 0,
      perField: {},
      skippedDimensionMismatch: {},
      skippedDecodeError: {},
      legacyTablePresent: false,
    });
  });

  it("migrates native vector rows into per-field storage and searches them", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    const backend = createPostgresBackend(drizzle(pool));
    await seedLegacy(pool, [
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
        graphId: "g2",
        nodeKind: "Document",
        nodeId: "d3",
        fieldPath: "embedding",
        embedding: [1, 0, 0],
      },
    ]);

    const result = await migrateLegacyEmbeddings({ backend });

    expect(result.legacyTablePresent).toBe(true);
    expect(result.migrated).toBe(3);
    expect(result.perField).toEqual({ "Document.embedding": 3 });
    expect(
      await countPerField(backend, pool, "Document", "embedding", "g1"),
    ).toBe(2);
    expect(
      await countPerField(backend, pool, "Document", "embedding", "g2"),
    ).toBe(1);

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

  it("is idempotent across re-runs", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    const backend = createPostgresBackend(drizzle(pool));
    await seedLegacy(pool, [
      {
        graphId: "g1",
        nodeKind: "Document",
        nodeId: "d1",
        fieldPath: "embedding",
        embedding: [1, 0, 0],
      },
    ]);

    await migrateLegacyEmbeddings({ backend });
    await migrateLegacyEmbeddings({ backend });

    expect(
      await countPerField(backend, pool, "Document", "embedding", "g1"),
    ).toBe(1);
  });

  it("scopes migration to a single graph when graphId is given", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    const backend = createPostgresBackend(drizzle(pool));
    await seedLegacy(pool, [
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

    const result = await migrateLegacyEmbeddings({ backend, graphId: "g2" });

    expect(result.migrated).toBe(1);
    expect(
      await countPerField(backend, pool, "Document", "embedding", "g1"),
    ).toBe(0);
    expect(
      await countPerField(backend, pool, "Document", "embedding", "g2"),
    ).toBe(1);
  });

  it("skips dimension-mismatched legacy rows instead of aborting (#11)", async (ctx) => {
    // pgvector's unparameterized legacy `vector` column allowed mixed
    // dimensions for one (kind, field). The per-field `vector(N)` table fixes
    // at the first migrated row's dimension; a differently-sized row makes
    // pgvector raise its "expected N dimensions, not M" error, which
    // parseDimensionMismatch must recognize end-to-end so the row is skipped +
    // reported rather than aborting the whole migration.
    const { pool } = requirePostgres(ctx);
    const backend = createPostgresBackend(drizzle(pool));
    await seedLegacy(pool, [
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
});
