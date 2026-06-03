/**
 * `createPostgresBackend(db, { vector: false })` — disabling the vector stack.
 *
 * The Postgres backend wires `pgvectorStrategy` by default, on the assumption
 * that a standalone Postgres server has the pgvector extension installed. An
 * in-process Postgres (PGlite) built without that extension can't honor it:
 * the default strategy's `vector(N)` DDL would hard-fail. `vector: false`
 * turns the stack off, mirroring a SQLite connection without sqlite-vec — the
 * backend advertises no `capabilities.vector` and omits the embedding/search
 * methods, so the store never routes vector work to it.
 *
 * These assertions inspect the constructed backend's shape only and issue no
 * SQL, so they run in plain `pnpm test` without a database. See
 * `postgres-backend.test.ts` for the Docker-gated end-to-end check that
 * non-vector CRUD works under `vector: false`.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { createPostgresBackend } from "../../../src/backend/postgres";

// A pool is lazy — it opens no connection until the first query — and
// `createPostgresBackend` issues none at construction, so this never touches a
// real database.
const PLACEHOLDER_URL = "postgresql://placeholder@127.0.0.1:5432/placeholder";

describe("createPostgresBackend({ vector: false })", () => {
  let pool: Pool | undefined;

  function backendWith(disableVector = false) {
    pool = new Pool({ connectionString: PLACEHOLDER_URL });
    const db = drizzle(pool);
    return createPostgresBackend(db, disableVector ? { vector: false } : {});
  }

  afterEach(async () => {
    await pool?.end();
    pool = undefined;
  });

  it("advertises no vector capability and omits embedding methods", () => {
    const backend = backendWith(true);

    expect(backend.capabilities.vector).toBeUndefined();
    expect(backend.upsertEmbedding).toBeUndefined();
    expect(backend.deleteEmbedding).toBeUndefined();
    expect(backend.vectorSearch).toBeUndefined();
  });

  it("advertises pgvector capability by default (no override)", () => {
    const backend = backendWith();

    expect(backend.capabilities.vector?.supported).toBe(true);
    expect(backend.capabilities.vector?.metrics).toContain("cosine");
    expect(backend.capabilities.vector?.indexTypes).toContain("hnsw");
    expect(backend.capabilities.vector?.maxDimensions).toBeGreaterThan(0);
    expect(backend.upsertEmbedding).toBeDefined();
    expect(backend.vectorSearch).toBeDefined();
  });

  it("retains non-vector capabilities when vector is disabled", () => {
    const backend = backendWith(true);

    // Disabling vector must not disturb the rest of the capability surface.
    expect(backend.capabilities.transactions).toBe(true);
    expect(backend.capabilities.fulltext?.supported).toBe(true);
  });
});
