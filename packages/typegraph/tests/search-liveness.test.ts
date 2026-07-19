/**
 * Facade search LIVENESS: `store.search.{fulltext,vector,hybrid}` must
 * compute top-k over LIVE nodes only.
 *
 * The failure mode this pins: the search statement ranks rows from the
 * fulltext / embedding side tables alone, so index drift — a side-table row
 * whose node was tombstoned without the store pipeline's cleanup (direct
 * `backend.deleteNode` callers, external writers, crash windows) — occupies
 * top-k slots. Hydration then drops the tombstoned ids, silently returning
 * FEWER than `limit` hits even though enough live rows exist.
 *
 * Drift is created honestly: seed through the public store API, then
 * tombstone via `backend.deleteNode` directly, which (by design) does not
 * touch strategy-owned side tables. Drift rows are constructed to outrank
 * every live row (nearer embeddings, denser term matches), so a search that
 * ranks before filtering CANNOT return `limit` live hits.
 *
 * Matrix mirrors `vector-cross-backend-parity.test.ts`: local sqlite-vec and
 * libSQL always attempted (vector legs capability-gated), Postgres/pgvector
 * when `POSTGRES_URL` is set. Both the brute-force and post-materialize ANN
 * paths are asserted.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { type Client, createClient } from "@libsql/client";
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode, searchable } from "../src";
import { generatePostgresMigrationSQL } from "../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../src/backend/postgres";
import { createLibsqlBackend } from "../src/backend/sqlite/libsql";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { type GraphBackend } from "../src/backend/types";
import { embedding } from "../src/core/embedding";
import { createStoreWithSchema } from "../src/store";
import { requireDefined } from "../src/utils/presence";

const GRAPH_ID = "search_liveness";
const FIELD_PATH = "embedding";
const EMBEDDING_DIMENSIONS = 3;
const LIMIT = 3;

const QUERY_EMBEDDING: readonly number[] = [1, 0, 0];
const FULLTEXT_QUERY = "signal";

const Document = defineNode("Document", {
  schema: z.object({
    title: searchable({ language: "english" }),
    embedding: embedding(EMBEDDING_DIMENSIONS),
  }),
});

function buildGraph() {
  return defineGraph({
    id: GRAPH_ID,
    nodes: { Document: { type: Document } },
    edges: {},
  });
}

type DocumentSeed = Readonly<{
  id: string;
  title: string;
  embedding: readonly number[];
}>;

/**
 * Live rows: match the fulltext query once each, and sit progressively
 * FARTHER from the query vector than every drift row.
 */
const LIVE_CORPUS: readonly DocumentSeed[] = [
  { id: "live-1", title: "signal processing primer", embedding: [0.8, 0.6, 0] },
  { id: "live-2", title: "a signal in the noise", embedding: [0.6, 0.8, 0] },
  { id: "live-3", title: "weak signal detection", embedding: [0.4, 0.9, 0.2] },
] as const;

/**
 * Drift rows: strictly outrank every live row on BOTH legs — embeddings at
 * or near the query vector, titles with denser `signal` term frequency — so
 * rank-then-filter cannot fill `limit` live hits.
 */
const DRIFT_CORPUS: readonly DocumentSeed[] = [
  {
    id: "drift-1",
    title: "signal signal signal signal",
    embedding: [1, 0, 0],
  },
  {
    id: "drift-2",
    title: "signal signal signal boost",
    embedding: [0.99, 0.05, 0],
  },
  {
    id: "drift-3",
    title: "signal signal amplifier",
    embedding: [0.97, 0.1, 0],
  },
] as const;

const LIVE_IDS = new Set(LIVE_CORPUS.map((seed) => seed.id));

function skipTest(ctx: { skip: () => void }): void {
  ctx.skip();
}

// ============================================================
// Backend matrix (mirrors vector-cross-backend-parity.test.ts)
// ============================================================

type BackendCleanup = () => Promise<void> | void;

type CreatedBackend = Readonly<{
  backend: GraphBackend;
  cleanup: BackendCleanup;
}>;

type BackendDescriptor = Readonly<{
  label: string;
  create: () => Promise<CreatedBackend>;
}>;

const localSqliteDescriptor: BackendDescriptor = {
  label: "local-sqlite-vec",
  create() {
    const { backend } = createLocalSqliteBackend();
    return Promise.resolve({
      backend,
      cleanup: () => backend.close(),
    });
  },
};

function libsqlDescriptor(): BackendDescriptor & { tempDir: string } {
  const temporaryDir = mkdtempSync(path.join(tmpdir(), "tg-search-liveness-"));
  let counter = 0;
  return {
    label: "libsql-file",
    tempDir: temporaryDir,
    async create() {
      const client: Client = createClient({
        url: `file:${path.join(temporaryDir, `liveness-${counter++}.db`)}`,
      });
      const { backend } = await createLibsqlBackend(client);
      return {
        backend,
        cleanup: async () => {
          await backend.close();
          client.close();
        },
      };
    },
  };
}

// ============================================================
// Scenario
// ============================================================

/**
 * Seeds live + drift docs through the store, then tombstones the drift docs
 * via `backend.deleteNode` — the raw row operation, which deliberately does
 * NOT clean strategy-owned side tables. Every drift doc keeps its fulltext
 * and embedding rows: the exact index-drift state the facade must survive.
 */
async function seedWithDrift(backend: GraphBackend) {
  const [store] = await createStoreWithSchema(buildGraph(), backend);
  for (const seed of [...LIVE_CORPUS, ...DRIFT_CORPUS]) {
    await store.nodes.Document.create(
      { title: seed.title, embedding: seed.embedding },
      { id: seed.id },
    );
  }
  for (const seed of DRIFT_CORPUS) {
    await backend.deleteNode({
      graphId: GRAPH_ID,
      kind: "Document",
      id: seed.id,
    });
  }
  return store;
}

type LivenessChecks = Readonly<{
  fulltextIds: readonly string[];
  vectorIds?: readonly string[];
  hybridIds?: readonly string[];
  annVectorIds?: readonly string[];
}>;

async function runLivenessScenario(
  backend: GraphBackend,
): Promise<LivenessChecks> {
  const store = await seedWithDrift(backend);

  const fulltextHits = await store.search.fulltext("Document", {
    query: FULLTEXT_QUERY,
    limit: LIMIT,
  });
  const fulltextIds = fulltextHits.map((hit) => hit.node.id);

  if (backend.capabilities.vector?.supported !== true) {
    return { fulltextIds };
  }

  const vectorHits = await store.search.vector("Document", {
    fieldPath: FIELD_PATH,
    queryEmbedding: QUERY_EMBEDDING,
    limit: LIMIT,
  });
  const hybridHits = await store.search.hybrid("Document", {
    vector: { fieldPath: FIELD_PATH, queryEmbedding: QUERY_EMBEDDING },
    fulltext: { query: FULLTEXT_QUERY },
    limit: LIMIT,
  });

  await store.materializeIndexes();
  const annVectorHits = await store.search.vector("Document", {
    fieldPath: FIELD_PATH,
    queryEmbedding: QUERY_EMBEDDING,
    limit: LIMIT,
  });

  return {
    fulltextIds,
    vectorIds: vectorHits.map((hit) => hit.node.id),
    hybridIds: hybridHits.map((hit) => hit.node.id),
    annVectorIds: annVectorHits.map((hit) => hit.node.id),
  };
}

function expectFullLiveResults(
  ids: readonly string[] | undefined,
  leg: string,
): void {
  if (ids === undefined) return;
  const unexpected = ids.filter((id) => !LIVE_IDS.has(id));
  expect(unexpected, `${leg}: tombstoned ids surfaced`).toEqual([]);
  expect(ids, `${leg}: top-k shrank below limit`).toHaveLength(LIMIT);
}

// ============================================================
// Suite
// ============================================================

describe("facade search liveness under index drift", () => {
  const libsql = libsqlDescriptor();

  const TEST_DATABASE_URL =
    process.env["POSTGRES_URL"] ??
    "postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test";
  let postgresPool: Pool | undefined;

  beforeAll(async () => {
    if (!process.env["POSTGRES_URL"]) return;
    const pool = new Pool({
      connectionString: TEST_DATABASE_URL,
      connectionTimeoutMillis: 5000,
    });
    try {
      await pool.query("SELECT 1");
      postgresPool = pool;
    } catch {
      await pool.end().catch(() => {
        // Pool never connected; unreachable Postgres degrades to "skip".
      });
    }
  });

  afterAll(async () => {
    rmSync(libsql.tempDir, { recursive: true, force: true });
    if (postgresPool !== undefined) await postgresPool.end();
  });

  const postgresDescriptor: BackendDescriptor = {
    label: "postgres-pgvector",
    async create() {
      const pool = requireDefined(postgresPool);
      await pool.query(`
        DROP TABLE IF EXISTS typegraph_index_materializations CASCADE;
        DROP TABLE IF EXISTS typegraph_node_embeddings CASCADE;
        DROP TABLE IF EXISTS typegraph_node_uniques CASCADE;
        DROP TABLE IF EXISTS typegraph_node_fulltext CASCADE;
        DROP TABLE IF EXISTS typegraph_edges CASCADE;
        DROP TABLE IF EXISTS typegraph_nodes CASCADE;
        DROP TABLE IF EXISTS typegraph_schema_versions CASCADE;
      `);
      const perField = await pool.query<{ tablename: string }>(
        String.raw`SELECT tablename FROM pg_tables
          WHERE schemaname = 'public' AND tablename LIKE 'tg_vec\_%'`,
      );
      for (const { tablename } of perField.rows) {
        await pool.query(`DROP TABLE IF EXISTS "${tablename}" CASCADE`);
      }
      await pool.query(generatePostgresMigrationSQL());

      const backend = createPostgresBackend(drizzleNodePostgres(pool));
      return {
        backend,
        cleanup: () => {
          // Shared pool, closed once in afterAll.
        },
      };
    },
  };

  for (const descriptor of [localSqliteDescriptor, libsql]) {
    it(`[${descriptor.label}] returns limit live hits on every search leg`, async () => {
      const { backend, cleanup } = await descriptor.create();
      try {
        const checks = await runLivenessScenario(backend);
        expectFullLiveResults(checks.fulltextIds, "fulltext");
        expectFullLiveResults(checks.vectorIds, "vector");
        expectFullLiveResults(checks.hybridIds, "hybrid");
        expectFullLiveResults(checks.annVectorIds, "vector (ANN)");
      } finally {
        await cleanup();
      }
    });
  }

  it("[postgres-pgvector] returns limit live hits on every search leg", async (ctx) => {
    if (postgresPool === undefined) {
      skipTest(ctx);
      return;
    }
    const { backend, cleanup } = await postgresDescriptor.create();
    try {
      const checks = await runLivenessScenario(backend);
      expectFullLiveResults(checks.fulltextIds, "fulltext");
      expectFullLiveResults(checks.vectorIds, "vector");
      expectFullLiveResults(checks.hybridIds, "hybrid");
      expectFullLiveResults(checks.annVectorIds, "vector (ANN)");
    } finally {
      await cleanup();
    }
  });

  it("[postgres-pgvector] IVFFlat: filtered top-k stays full and ordered under drift", async (ctx) => {
    if (postgresPool === undefined) {
      skipTest(ctx);
      return;
    }
    // IVFFlat has no strict_order iterative scan — its liveness pushdown
    // pairs `ivfflat.iterative_scan = relaxed_order` with a MATERIALIZED
    // re-sort in the strategy SQL. This drift regression proves the pair:
    // full `limit` live hits AND exact ranking on a materialized IVFFlat
    // slot.
    const IvfDocument = defineNode("IvfDocument", {
      schema: z.object({
        title: searchable({ language: "english" }),
        embedding: embedding(EMBEDDING_DIMENSIONS, { indexType: "ivfflat" }),
      }),
    });
    const graph = defineGraph({
      id: "search_liveness_ivfflat",
      nodes: { IvfDocument: { type: IvfDocument } },
      edges: {},
    });
    const { backend, cleanup } = await postgresDescriptor.create();
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      for (const seed of [...LIVE_CORPUS, ...DRIFT_CORPUS]) {
        await store.nodes.IvfDocument.create(
          { title: seed.title, embedding: seed.embedding },
          { id: seed.id },
        );
      }
      for (const seed of DRIFT_CORPUS) {
        await backend.deleteNode({
          graphId: "search_liveness_ivfflat",
          kind: "IvfDocument",
          id: seed.id,
        });
      }
      await store.materializeIndexes();

      const hits = await store.search.vector("IvfDocument", {
        fieldPath: FIELD_PATH,
        queryEmbedding: QUERY_EMBEDDING,
        limit: LIMIT,
      });
      // Full page of live hits, in exact similarity order (live-1 is the
      // nearest live vector, live-3 the farthest).
      expect(hits.map((hit) => hit.node.id)).toEqual([
        "live-1",
        "live-2",
        "live-3",
      ]);
    } finally {
      await cleanup();
    }
  });
});
