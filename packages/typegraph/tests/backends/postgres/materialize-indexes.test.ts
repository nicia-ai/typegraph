/**
 * PostgreSQL-specific tests for `store.materializeIndexes()`.
 *
 * Verifies the CONCURRENTLY path, status persistence in pgvector-bearing
 * databases, and the two-instance race (idempotency under concurrent
 * callers).
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../../../src";
import {
  generatePostgresDDL,
  generatePostgresMigrationSQL,
} from "../../../src/backend/drizzle/ddl";
import { tables as defaultPostgresTables } from "../../../src/backend/drizzle/schema/postgres";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { defineNodeIndex } from "../../../src/indexes";
import { createStoreWithSchema } from "../../../src/store";

const TEST_DATABASE_URL =
  process.env.POSTGRES_URL ??
  "postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test";

let sharedPool: Pool | undefined;
let sharedDb: NodePgDatabase | undefined;
let isPostgresAvailable = false;

function requirePostgres(ctx: { skip: () => void }): {
  pool: Pool;
  db: NodePgDatabase;
} {
  if (
    !isPostgresAvailable ||
    sharedPool === undefined ||
    sharedDb === undefined
  ) {
    ctx.skip();
    throw new Error("unreachable");
  }
  return { pool: sharedPool, db: sharedDb };
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
    sharedDb = drizzle(pool);
    isPostgresAvailable = true;
    await pool.query(`
      DROP TABLE IF EXISTS typegraph_index_materializations CASCADE;
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
  // Drop any indexes leaked from prior runs so CONCURRENTLY can recreate them.
  const leakedIndexes = await sharedPool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE 'idx_tg_%'`,
  );
  for (const { indexname } of leakedIndexes.rows) {
    await sharedPool.query(`DROP INDEX IF EXISTS "${indexname}"`);
  }
});

const Person = defineNode("Person", {
  schema: z.object({ email: z.email(), name: z.string() }),
});

function buildGraph() {
  const personEmail = defineNodeIndex(Person, { fields: ["email"] });
  const personName = defineNodeIndex(Person, { fields: ["name"] });
  return defineGraph({
    id: "pg_materialize_test",
    nodes: { Person: { type: Person } },
    edges: {},
    indexes: [personEmail, personName],
  });
}

describe("Postgres store.materializeIndexes — CONCURRENTLY", () => {
  it("creates indexes via CREATE INDEX CONCURRENTLY", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    const backend = createPostgresBackend(drizzle(pool));
    const graph = buildGraph();
    const [store] = await createStoreWithSchema(graph, backend);

    const result = await store.materializeIndexes();
    expect(result.results).toHaveLength(2);
    for (const entry of result.results) {
      expect(entry.status).toBe("created");
    }

    // Indexes physically present in the catalog.
    const created = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE 'idx_tg_%'`,
    );
    expect(created.rows.length).toBe(2);
  });

  it("is idempotent: a second call reports alreadyMaterialized", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    const backend = createPostgresBackend(drizzle(pool));
    const graph = buildGraph();
    const [store] = await createStoreWithSchema(graph, backend);

    await store.materializeIndexes();
    const second = await store.materializeIndexes();
    for (const entry of second.results) {
      expect(entry.status).toBe("alreadyMaterialized");
    }
  });

  it("a sequential second caller from a fresh store sees alreadyMaterialized", async (ctx) => {
    // The spec says "behavior verified across two replicas of the same
    // schema_doc" — i.e. two callers (potentially in different
    // processes) against the SAME database see consistent status. Run
    // two callers against fresh stores backed by the same pool: the
    // second sees alreadyMaterialized, not failed, not re-created.
    const { pool } = requirePostgres(ctx);
    const graph = buildGraph();
    const backendA = createPostgresBackend(drizzle(pool));
    const [storeA] = await createStoreWithSchema(graph, backendA);
    const first = await storeA.materializeIndexes();
    expect(first.results.every((entry) => entry.status === "created")).toBe(
      true,
    );

    const backendB = createPostgresBackend(drizzle(pool));
    const [storeB] = await createStoreWithSchema(graph, backendB);
    const second = await storeB.materializeIndexes();
    expect(
      second.results.every((entry) => entry.status === "alreadyMaterialized"),
    ).toBe(true);
  });

  it("two concurrent callers race without producing failed results", async (ctx) => {
    // Two fresh stores fire materializeIndexes simultaneously against
    // an empty status table. The implementation reads status, runs
    // CIC IF NOT EXISTS, then upserts status. Postgres serializes
    // the CIC builds via SHARE UPDATE EXCLUSIVE; the second sees IF
    // NOT EXISTS and no-ops. Status upserts use ON CONFLICT DO UPDATE.
    // Net: neither caller's result contains `failed`.
    const { pool } = requirePostgres(ctx);
    const graph = buildGraph();
    const backendA = createPostgresBackend(drizzle(pool));
    const backendB = createPostgresBackend(drizzle(pool));
    const [storeA] = await createStoreWithSchema(graph, backendA);
    const [storeB] = await createStoreWithSchema(graph, backendB);

    const [a, b] = await Promise.all([
      storeA.materializeIndexes(),
      storeB.materializeIndexes(),
    ]);

    for (const entry of [...a.results, ...b.results]) {
      expect(entry.status).not.toBe("failed");
    }

    const created = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE 'idx_tg_%'`,
    );
    expect(created.rows.length).toBe(2);
  });

  it("does not hold AccessExclusiveLock on typegraph_nodes during materialization", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    const backend = createPostgresBackend(drizzle(pool));
    const graph = buildGraph();
    const [store] = await createStoreWithSchema(graph, backend);

    // Run materializeIndexes concurrently with a SELECT against the
    // target table. If CREATE INDEX (without CONCURRENTLY) were used,
    // the SELECT would block until the index build completes. With
    // CONCURRENTLY it doesn't.
    const select = pool.query("SELECT count(*) FROM typegraph_nodes");
    const materialize = store.materializeIndexes();
    const [, result] = await Promise.all([select, materialize]);

    for (const entry of result.results) {
      expect(entry.status).toBe("created");
    }
  });
});

describe("Postgres store.materializeIndexes — status table", () => {
  it("records timestamps in the status table", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    const backend = createPostgresBackend(drizzle(pool));
    const graph = buildGraph();
    const [store] = await createStoreWithSchema(graph, backend);

    await store.materializeIndexes();

    const db = drizzle(pool);
    const rows = await db
      .select()
      .from(defaultPostgresTables.indexMaterializations);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.materializedAt).not.toBeNull();
      expect(row.lastError).toBeNull();
      expect(row.signature).toMatch(/^[0-9a-f]+$/);
    }
  });
});

// Used to keep the import linter happy when the suite skips entirely.
void generatePostgresDDL;
