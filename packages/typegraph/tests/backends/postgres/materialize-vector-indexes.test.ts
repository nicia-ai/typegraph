/**
 * Postgres-specific tests for vector index unification — auto-derived
 * `VectorIndexDeclaration` entries flow through `materializeIndexes()`
 * and create real pgvector HNSW / IVFFlat indexes via the backend's
 * `createVectorIndex` primitive.
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { embedding } from "../../../src/core/embedding";
import { createStoreWithSchema } from "../../../src/store";

const TEST_DATABASE_URL =
  process.env.POSTGRES_URL ??
  "postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test";

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
    sharedPool = pool;
    isPostgresAvailable = true;
    await pool.query(`
      DROP TABLE IF EXISTS typegraph_index_materializations CASCADE;
      DROP TABLE IF EXISTS typegraph_node_embeddings CASCADE;
      DROP TABLE IF EXISTS typegraph_node_uniques CASCADE;
      DROP TABLE IF EXISTS typegraph_edges CASCADE;
      DROP TABLE IF EXISTS typegraph_nodes CASCADE;
      DROP TABLE IF EXISTS typegraph_schema_versions CASCADE;
    `);
    await pool.query(generatePostgresMigrationSQL());
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
  await sharedPool.query(
    `TRUNCATE typegraph_index_materializations,
              typegraph_node_embeddings,
              typegraph_node_uniques,
              typegraph_nodes,
              typegraph_edges,
              typegraph_schema_versions CASCADE`,
  );
  // Drop leaked physical indexes from prior runs.
  const leaked = await sharedPool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE 'tg_vec_%'`,
  );
  for (const { indexname } of leaked.rows) {
    await sharedPool.query(`DROP INDEX IF EXISTS "${indexname}"`);
  }
});

const Document = defineNode("Document", {
  schema: z.object({
    title: z.string(),
    embedding: embedding(384),
  }),
});

describe("Postgres store.materializeIndexes — vector dispatch", () => {
  it("auto-derived vector index materializes as a real pgvector HNSW index", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    const backend = createPostgresBackend(drizzle(pool));
    const graph = defineGraph({
      id: "vector_pg_auto",
      nodes: { Document: { type: Document } },
      edges: {},
    });
    const [store] = await createStoreWithSchema(graph, backend);

    const result = await store.materializeIndexes();
    const vectorEntry = result.results.find(
      (entry) => entry.entity === "vector",
    );
    expect(vectorEntry?.status).toBe("created");

    // The physical pgvector index is now visible in pg_indexes. The
    // bundled vector-index helper names HNSW indexes with `_hnsw_` in
    // them; the higher-level VectorIndexDeclaration name uses `tg_vec_`
    // and is what we record in the materialization status table.
    const created = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'typegraph_node_embeddings'
       AND indexdef LIKE '%hnsw%'`,
    );
    expect(created.rows.length).toBeGreaterThan(0);
  });

  it("is idempotent: a second call reports alreadyMaterialized", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    const backend = createPostgresBackend(drizzle(pool));
    const graph = defineGraph({
      id: "vector_pg_idem",
      nodes: { Document: { type: Document } },
      edges: {},
    });
    const [store] = await createStoreWithSchema(graph, backend);

    await store.materializeIndexes();
    const second = await store.materializeIndexes();
    const vectorEntry = second.results.find(
      (entry) => entry.entity === "vector",
    );
    expect(vectorEntry?.status).toBe("alreadyMaterialized");
  });

  it("two graphs sharing the same kind/field each create their own physical pgvector index", async (ctx) => {
    // Regression for the cross-graph false-skip bug. Two graphs
    // declaring an embedding on `Document.embedding` should each
    // produce their own physical pgvector index (which is partial-
    // by-graph_id) and each report `created` — neither should hit
    // `alreadyMaterialized` from the other graph's status row.
    const { pool } = requirePostgres(ctx);
    const graphA = defineGraph({
      id: "vec_pg_xgraph_a",
      nodes: { Document: { type: Document } },
      edges: {},
    });
    const graphB = defineGraph({
      id: "vec_pg_xgraph_b",
      nodes: { Document: { type: Document } },
      edges: {},
    });
    const [storeA] = await createStoreWithSchema(
      graphA,
      createPostgresBackend(drizzle(pool)),
    );
    const [storeB] = await createStoreWithSchema(
      graphB,
      createPostgresBackend(drizzle(pool)),
    );

    const resultA = await storeA.materializeIndexes();
    const resultB = await storeB.materializeIndexes();

    expect(
      resultA.results.find((entry) => entry.entity === "vector")?.status,
    ).toBe("created");
    expect(
      resultB.results.find((entry) => entry.entity === "vector")?.status,
    ).toBe("created");

    // Two physical pgvector indexes exist — one per graph.
    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'typegraph_node_embeddings'
       AND indexdef LIKE '%hnsw%'
       AND (indexname LIKE 'idx_emb_vec_pg_xgraph_a_%'
         OR indexname LIKE 'idx_emb_vec_pg_xgraph_b_%')`,
    );
    expect(indexes.rows.length).toBe(2);
  });

  it("indexType: 'none' opts out of physical materialization", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    const NoIndex = defineNode("NoIndex", {
      schema: z.object({
        title: z.string(),
        embedding: embedding(384, { indexType: "none" }),
      }),
    });
    const backend = createPostgresBackend(drizzle(pool));
    const graph = defineGraph({
      id: "vector_pg_none",
      nodes: { NoIndex: { type: NoIndex } },
      edges: {},
    });
    const [store] = await createStoreWithSchema(graph, backend);

    const result = await store.materializeIndexes();
    const vectorEntry = result.results.find(
      (entry) => entry.entity === "vector",
    );
    expect(vectorEntry?.status).toBe("skipped");
    expect(vectorEntry?.reason).toContain("'none'");
  });
});
