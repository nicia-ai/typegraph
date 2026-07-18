/**
 * Serial retry for parallel ANN index builds that exhaust shared memory.
 *
 * Parallel HNSW/IVFFlat builds stage the build graph in dynamic shared
 * memory; resource-constrained hosts reject the allocation with
 * SQLSTATE class 53 (observed: 53100 from dsm_impl_posix building a
 * 50k x 384-dim HNSW index in a container with the 64MB /dev/shm
 * default). `createVectorIndex` must then drop the INVALID leftover the
 * failed CONCURRENTLY build leaves behind (IF NOT EXISTS would mask the
 * retry), pin the strategy table to `parallel_workers = 0`, rebuild in
 * local memory, and restore the setting.
 *
 * The resource failure is induced deterministically through a pool-level
 * query spy that rejects the FIRST index build with a synthetic 53100.
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  embedding,
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";

const TEST_DATABASE_URL =
  process.env["POSTGRES_URL"] ??
  "postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test";

let pool: Pool | undefined;
let isPostgresAvailable = false;

function requirePostgres(ctx: { skip: () => void }): Pool {
  if (!isPostgresAvailable || pool === undefined) {
    ctx.skip();
    throw new Error("unreachable");
  }
  return pool;
}

beforeAll(async () => {
  if (!process.env["POSTGRES_URL"]) return;
  const candidate = new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  try {
    await candidate.query("SELECT 1");
    await candidate.query(generatePostgresMigrationSQL());
    pool = candidate;
    isPostgresAvailable = true;
  } catch {
    await candidate.end().catch(() => {
      // Unreachable Postgres degrades to "skip".
    });
  }
});

afterAll(async () => {
  if (pool !== undefined) await pool.end();
});

const Document = defineNode("Document", {
  schema: z.object({ title: z.string(), embedding: embedding(8) }),
});

function insufficientResources(): Error & { code: string } {
  const error = new Error(
    "could not resize shared memory segment: No space left on device",
  ) as Error & { code: string };
  error.code = "53100";
  return error;
}

describe("pgvector index build serial retry", () => {
  it("retries a shared-memory-exhausted build with parallel workers disabled", async (ctx) => {
    requirePostgres(ctx);
    const spyPool = new Pool({
      connectionString: TEST_DATABASE_URL,
      connectionTimeoutMillis: 5000,
    });
    try {
      const submitted: string[] = [];
      let failedOnce = false;
      const originalQuery = spyPool.query.bind(spyPool);
      (spyPool as { query: unknown }).query = (
        config: unknown,
        ...rest: unknown[]
      ) => {
        const text =
          typeof config === "string" ? config
          : typeof config === "object" && config !== null && "text" in config ?
            (config as { text: string }).text
          : "";
        submitted.push(text);
        if (
          /CREATE INDEX/i.test(text) &&
          /hnsw|ivfflat/i.test(text) &&
          !failedOnce
        ) {
          failedOnce = true;
          return Promise.reject(insufficientResources());
        }
        return (originalQuery as (...args: unknown[]) => unknown)(
          config,
          ...rest,
        );
      };

      const backend = createPostgresBackend(drizzle(spyPool));
      const graph = defineGraph({
        id: "vec_serial_retry",
        nodes: { Document: { type: Document } },
        edges: {},
      });
      const [store] = await createStoreWithSchema(graph, backend);
      await store.nodes.Document.create({
        title: "seed",
        embedding: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
      });

      submitted.length = 0;
      const result = await store.materializeIndexes();
      const vectorEntry = result.results.find(
        (entry) => entry.entity === "vector",
      );
      expect(vectorEntry?.status).toBe("created");
      expect(failedOnce).toBe(true);

      // The retry sequence: drop the leftover, pin to serial, rebuild,
      // restore. Order-pinned via first occurrence indexes.
      const indexOf = (pattern: RegExp) =>
        submitted.findIndex((text) => pattern.test(text));
      const dropIndex = indexOf(/DROP INDEX IF EXISTS/i);
      const pinSerial = indexOf(/SET \(parallel_workers = 0\)/i);
      const restore = indexOf(/RESET \(parallel_workers\)/i);
      expect(dropIndex).toBeGreaterThanOrEqual(0);
      expect(pinSerial).toBeGreaterThan(dropIndex);
      expect(restore).toBeGreaterThan(pinSerial);

      // The physical index exists and is valid.
      const strategyTable = backend.vectorStrategy?.tableName(
        "vec_serial_retry",
        "Document",
        "embedding",
      );
      expect(strategyTable).toBeDefined();
      const indexes = await spyPool.query<{
        indexname: string;
        indisvalid: boolean;
      }>(
        `SELECT i.indexname, x.indisvalid
         FROM pg_indexes i
         JOIN pg_class c ON c.relname = i.indexname
         JOIN pg_index x ON x.indexrelid = c.oid
         WHERE i.tablename = $1 AND i.indexdef ~* 'hnsw|ivfflat'`,
        [strategyTable],
      );
      expect(indexes.rows).toHaveLength(1);
      expect(indexes.rows[0]?.indisvalid).toBe(true);

      // The storage parameter was restored: no lingering reloptions.
      const options = await spyPool.query<{ reloptions: string[] | null }>(
        `SELECT reloptions FROM pg_class WHERE relname = $1`,
        [strategyTable],
      );
      const reloptions = options.rows[0]?.reloptions ?? undefined;
      expect(
        (reloptions ?? []).filter((entry) =>
          entry.includes("parallel_workers"),
        ),
      ).toHaveLength(0);
    } finally {
      await spyPool.end();
    }
  });

  it("does not retry non-resource failures", async (ctx) => {
    requirePostgres(ctx);
    const spyPool = new Pool({
      connectionString: TEST_DATABASE_URL,
      connectionTimeoutMillis: 5000,
    });
    try {
      const submitted: string[] = [];
      const originalQuery = spyPool.query.bind(spyPool);
      (spyPool as { query: unknown }).query = (
        config: unknown,
        ...rest: unknown[]
      ) => {
        const text =
          typeof config === "string" ? config
          : typeof config === "object" && config !== null && "text" in config ?
            (config as { text: string }).text
          : "";
        submitted.push(text);
        if (/CREATE INDEX/i.test(text) && /hnsw|ivfflat/i.test(text)) {
          const syntaxError = new Error("syntax error") as Error & {
            code: string;
          };
          syntaxError.code = "42601";
          return Promise.reject(syntaxError);
        }
        return (originalQuery as (...args: unknown[]) => unknown)(
          config,
          ...rest,
        );
      };

      const backend = createPostgresBackend(drizzle(spyPool));
      const graph = defineGraph({
        id: "vec_serial_noretry",
        nodes: { Document: { type: Document } },
        edges: {},
      });
      const [store] = await createStoreWithSchema(graph, backend);
      await store.nodes.Document.create({
        title: "seed",
        embedding: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
      });

      submitted.length = 0;
      const result = await store.materializeIndexes();
      const vectorEntry = result.results.find(
        (entry) => entry.entity === "vector",
      );
      expect(vectorEntry?.status).toBe("failed");
      expect(submitted.some((text) => /parallel_workers/i.test(text))).toBe(
        false,
      );
    } finally {
      await spyPool.end();
    }
  });
});
