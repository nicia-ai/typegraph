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
import { requireDefined } from "../../../src/utils/presence";

const TEST_DATABASE_URL =
  process.env["POSTGRES_URL"] ??
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
  if (!process.env["POSTGRES_URL"]) return;
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
              typegraph_node_uniques,
              typegraph_nodes,
              typegraph_edges,
              typegraph_schema_versions CASCADE`,
  );
  // Drop the strategy's per-field vector tables from prior runs so each
  // test re-materializes its table + ANN index from scratch (the
  // contribution DDL is `CREATE ... IF NOT EXISTS`, so a leftover table
  // would mask a fresh materialization).
  const tables = await sharedPool.query<{ tablename: string }>(
    String.raw`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'tg_vec\_%'`,
  );
  for (const { tablename } of tables.rows) {
    await sharedPool.query(`DROP TABLE IF EXISTS "${tablename}" CASCADE`);
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

    // The physical pgvector HNSW index is now visible on the strategy's
    // per-(graphId, kind, field) table.
    const table = requireDefined(backend.vectorStrategy).tableName(
      "vector_pg_auto",
      "Document",
      "embedding",
    );
    const created = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = $1
       AND indexdef LIKE '%hnsw%'`,
      [table],
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

  it("two graphs sharing the same kind/field each get their own per-field table + index", async (ctx) => {
    // Regression for the cross-graph false-skip bug + the graph-scoping
    // guarantee. Two graphs declaring `Document.embedding` get SEPARATE
    // per-(graphId, kind, field) tables and ANN indexes, so divergent
    // dimensions can't collide and libSQL `vector_top_k` stays per-graph.
    // Each graph records its own materialization status row, so both report
    // `created` — neither falsely hits `alreadyMaterialized` from the other.
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
    const backendA = createPostgresBackend(drizzle(pool));
    const backendB = createPostgresBackend(drizzle(pool));
    const [storeA] = await createStoreWithSchema(graphA, backendA);
    const [storeB] = await createStoreWithSchema(graphB, backendB);

    const resultA = await storeA.materializeIndexes();
    const resultB = await storeB.materializeIndexes();

    expect(
      resultA.results.find((entry) => entry.entity === "vector")?.status,
    ).toBe("created");
    expect(
      resultB.results.find((entry) => entry.entity === "vector")?.status,
    ).toBe("created");

    // Each graph has its own per-field table, each with its own HNSW index —
    // distinct physical objects, no cross-graph sharing.
    const tableA = requireDefined(backendA.vectorStrategy).tableName(
      "vec_pg_xgraph_a",
      "Document",
      "embedding",
    );
    const tableB = requireDefined(backendB.vectorStrategy).tableName(
      "vec_pg_xgraph_b",
      "Document",
      "embedding",
    );
    expect(tableA).not.toBe(tableB);
    for (const table of [tableA, tableB]) {
      const indexes = await pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = $1
         AND indexdef LIKE '%hnsw%'`,
        [table],
      );
      expect(indexes.rows.length).toBe(1);
    }
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

  it("emits the field's declared HNSW tuning (m / ef_construction) in the index DDL", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    const TunedDocument = defineNode("TunedDoc", {
      schema: z.object({
        title: z.string(),
        embedding: embedding(8, { m: 32, efConstruction: 100 }),
      }),
    });
    const graph = defineGraph({
      id: "vector_pg_tuned",
      nodes: { TunedDoc: { type: TunedDocument } },
      edges: {},
    });
    const backend = createPostgresBackend(drizzle(pool));
    const [store] = await createStoreWithSchema(graph, backend);
    const tunedTable = requireDefined(backend.vectorStrategy).tableName(
      "vector_pg_tuned",
      "TunedDoc",
      "embedding",
    );

    const first = await store.materializeIndexes();
    expect(
      first.results.find((entry) => entry.entity === "vector")?.status,
    ).toBe("created");

    const indexdef = async (): Promise<string> => {
      const rows = await pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = $1
           AND indexdef LIKE '%hnsw%'`,
        [tunedTable],
      );
      expect(rows.rows.length).toBe(1);
      return requireDefined(rows.rows[0]).indexdef;
    };

    // The declared tuning must reach the emitted DDL, not pgvector defaults
    // (m = 16, ef_construction = 64).
    expect(await indexdef()).toMatch(/m\s*=\s*'?32'?/);
    expect(await indexdef()).toMatch(/ef_construction\s*=\s*'?100'?/);

    // #6: reembed rebuilds the index with the SAME declared tuning, and a
    // subsequent materializeIndexes sees a matching signature (no drift).
    await store.reembedVectorField("TunedDoc", "embedding");
    expect(await indexdef()).toMatch(/m\s*=\s*'?32'?/);
    const second = await store.materializeIndexes();
    expect(
      second.results.find((entry) => entry.entity === "vector")?.status,
    ).toBe("alreadyMaterialized");
  });
});
