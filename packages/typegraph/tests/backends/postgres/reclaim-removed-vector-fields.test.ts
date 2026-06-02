/**
 * Postgres-specific tests for removed-embedding-field table reclamation
 * (the #10 completeness fix). When an `embedding()` field is dropped from a
 * surviving kind, its per-`(graphId, kind, field)` `vector(N)` table (and the
 * HNSW index `buildDropStorage` drops via `CASCADE`) is orphaned;
 * `store.materializeRemovals()` reclaims it.
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { defineGraph } from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { defineGraphExtension } from "../../../src/graph-extension";
import { createStoreWithSchema } from "../../../src/store";

const TEST_DATABASE_URL =
  process.env.POSTGRES_URL ??
  "postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test";

const GRAPH_ID = "reclaim_vec_pg";

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
      DROP TABLE IF EXISTS typegraph_kind_removals CASCADE;
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
  const tables = await sharedPool.query<{ tablename: string }>(
    String.raw`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'tg_vec\_%'`,
  );
  for (const { tablename } of tables.rows) {
    await sharedPool.query(`DROP TABLE IF EXISTS "${tablename}" CASCADE`);
  }
});

const baseGraph = defineGraph({ id: GRAPH_ID, nodes: {}, edges: {} });

const addDocumentWithEmbedding = defineGraphExtension({
  nodes: {
    Document: {
      properties: {
        title: { type: "string" },
        embedding: {
          type: "array",
          items: { type: "number" },
          embedding: { dimensions: 3 },
        },
      },
    },
  },
});

const dropEmbeddingModifier = defineGraphExtension({
  nodes: {
    Document: {
      properties: {
        title: { type: "string" },
        embedding: { type: "array", items: { type: "number" } },
      },
    },
  },
});

async function tableExists(pool: Pool, name: string): Promise<boolean> {
  const result = await pool.query(
    "SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = $1",
    [name],
  );
  return result.rowCount !== null && result.rowCount > 0;
}

describe("Postgres reclaimRemovedVectorFieldTables", () => {
  it("drops the orphaned pgvector table when an embedding field is removed", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    const backend = createPostgresBackend(drizzle(pool));
    const table = backend.vectorStrategy!.tableName(
      GRAPH_ID,
      "Document",
      "embedding",
    );

    const [store] = await createStoreWithSchema(baseGraph, backend);
    const withField = await store.evolve(addDocumentWithEmbedding);
    await withField
      .getNodeCollectionOrThrow("Document")
      .create({ title: "a", embedding: [1, 0, 0] });
    expect(await tableExists(pool, table)).toBe(true);

    const evolved = await withField.evolve(dropEmbeddingModifier);
    const result = await evolved.materializeRemovals();

    expect(result.reclaimedVectorFields).toEqual([
      { kind: "Document", fieldPath: "embedding", status: "reclaimed" },
    ]);
    expect(await tableExists(pool, table)).toBe(false);
  });

  it("does NOT drop a removed-then-re-added field (active schema wins)", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    const backend = createPostgresBackend(drizzle(pool));
    const table = backend.vectorStrategy!.tableName(
      GRAPH_ID,
      "Document",
      "embedding",
    );

    const [store] = await createStoreWithSchema(baseGraph, backend);
    const withField = await store.evolve(addDocumentWithEmbedding);
    await withField
      .getNodeCollectionOrThrow("Document")
      .create({ title: "a", embedding: [1, 0, 0] });
    const withoutField = await withField.evolve(dropEmbeddingModifier);
    const readded = await withoutField.evolve(addDocumentWithEmbedding);
    await readded
      .getNodeCollectionOrThrow("Document")
      .create({ title: "b", embedding: [0, 1, 0] });

    const result = await readded.materializeRemovals();

    expect(result.reclaimedVectorFields).toEqual([]);
    expect(await tableExists(pool, table)).toBe(true);
  });
});
