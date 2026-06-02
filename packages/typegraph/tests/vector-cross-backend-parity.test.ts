/**
 * Cross-backend vector + hybrid search PARITY.
 *
 * Drives one fixed scenario through the **public store API**
 * (`createStoreWithSchema` → `store.nodes.*.create` over an `embedding()`
 * field → `store.search.vector` / `store.search.hybrid` →
 * `store.materializeIndexes()`) on every vector-capable SQLite-family
 * backend available without Docker — local `sqlite-vec` and libSQL — and
 * asserts the two return **identical ranking and identity**.
 *
 * The point is integration-level confidence that the per-`(kind, field)`
 * `VectorStrategy` storage (vec0 vs `F32_BLOB(N)` + DiskANN) is
 * behaviorally interchangeable from a consumer's seat: same input data,
 * same query, same ordered node ids, and the same brute-force → ANN
 * ranking after materialization. Backend-internal SQL differences are
 * covered by each strategy's own suite (e.g.
 * `tests/backends/sqlite/libsql-vector-strategy.test.ts`); this suite
 * pins the contract the strategies are interchangeable *behind*.
 *
 * Backend selection is capability-gated, never hard-coded: a backend
 * participates only when `backend.capabilities.vector?.supported` is true
 * (so a missing optional `sqlite-vec` peer dep skips that leg cleanly
 * rather than failing). Postgres/pgvector is added to the matrix only
 * when `POSTGRES_URL` is set, exactly like the other Postgres suites.
 *
 * A dedicated partition-correctness assertion proves a near-identical
 * vector stored under a *different* node kind never leaks into another
 * kind's results — the property that justifies per-`(kind, field)`
 * storage over a single shared embeddings table.
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

// ============================================================
// Scenario graph & fixed corpus
// ============================================================

const GRAPH_ID = "vector_parity";
const FIELD_PATH = "embedding";
const EMBEDDING_DIMENSIONS = 3;

/**
 * `Document` carries both an `embedding()` field (vector leg) and a
 * `searchable()` field (fulltext leg) so the same node kind exercises
 * vector, hybrid, and the post-materialize ANN path.
 */
const Document = defineNode("Document", {
  schema: z.object({
    title: searchable({ language: "english" }),
    embedding: embedding(EMBEDDING_DIMENSIONS),
  }),
});

/**
 * A second kind with an *identical-dimension* embedding field. Used only
 * by the partition-correctness check: a `Tag` whose vector is identical
 * to the query must never surface in a `Document` search, proving the
 * two kinds live in separate per-`(kind, field)` storage.
 */
const Tag = defineNode("Tag", {
  schema: z.object({
    label: searchable({ language: "english" }),
    embedding: embedding(EMBEDDING_DIMENSIONS),
  }),
});

function buildGraph() {
  return defineGraph({
    id: GRAPH_ID,
    nodes: { Document: { type: Document }, Tag: { type: Tag } },
    edges: {},
  });
}

/**
 * Fixed corpus with an unambiguous cosine ordering against the query
 * `[1, 0, 0]`: `alpha` is an exact match (similarity 1), `beta` is close,
 * `gamma` is orthogonal (similarity 0). Distinct similarities keep the
 * expected ranking deterministic across engines — no ties to break.
 */
const QUERY_EMBEDDING: readonly number[] = [1, 0, 0];

type DocumentSeed = Readonly<{
  id: string;
  title: string;
  embedding: readonly number[];
}>;

const DOCUMENT_CORPUS: readonly DocumentSeed[] = [
  { id: "alpha", title: "alpha exact match document", embedding: [1, 0, 0] },
  {
    id: "beta",
    title: "beta closely related document",
    embedding: [0.9, 0.1, 0],
  },
  {
    id: "gamma",
    title: "gamma orthogonal unrelated note",
    embedding: [0, 1, 0],
  },
] as const;

/** Expected vector ranking: closest cosine neighbor first. */
const EXPECTED_VECTOR_ORDER: readonly string[] = ["alpha", "beta", "gamma"];

/**
 * A `Tag` whose embedding is *identical* to the query vector. If
 * per-kind partitioning is wrong it would outrank every `Document`; the
 * partition assertion proves it never appears in `Document` results.
 */
const PARTITION_TAG: Readonly<{
  id: string;
  label: string;
  embedding: readonly number[];
}> = {
  id: "tag-decoy",
  label: "decoy tag exact match",
  embedding: [1, 0, 0],
} as const;

/**
 * Skips the current test through the runtime context. Wrapped in a helper
 * (mirroring the Postgres suites' `requirePostgres`) so the capability /
 * `POSTGRES_URL` gates read as guards, not as statically-disabled tests.
 */
function skipTest(ctx: { skip: () => void }): void {
  ctx.skip();
}

// ============================================================
// Normalized parity snapshot
// ============================================================

/**
 * The backend-agnostic projection compared across backends. Scores are
 * rounded so cosine math that differs only in the last float ULP between
 * engines doesn't produce spurious inequality; identity (ordered ids) is
 * compared exactly.
 */
type ParitySnapshot = Readonly<{
  /** Ordered node ids from `store.search.vector` (brute-force pre-ANN). */
  vectorIds: readonly string[];
  /** Rounded scores aligned to `vectorIds`. */
  vectorScores: readonly number[];
  /** Ordered node ids from `store.search.hybrid`. */
  hybridIds: readonly string[];
  /** Ordered node ids from `store.search.vector` after materializeIndexes(). */
  annVectorIds: readonly string[];
  /** Node ids returned for the Tag-kind decoy search (must be exactly its own id). */
  partitionTagIds: readonly string[];
  /** Node ids returned for the Document search alongside the decoy (must exclude the Tag). */
  partitionDocumentIds: readonly string[];
}>;

const SCORE_PRECISION = 4;

function roundScore(score: number): number {
  return Number(score.toFixed(SCORE_PRECISION));
}

// ============================================================
// Backend matrix
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

/**
 * Local better-sqlite3 + sqlite-vec. The factory always succeeds, but the
 * `vector` strategy is wired only when the optional `sqlite-vec` peer dep
 * loads — so the descriptor self-reports support via `capabilities`.
 */
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

/**
 * libSQL over a temp file. A temp file (not `file::memory:`) is required:
 * each new connection to `file::memory:` opens an isolated database, so
 * the DDL bootstrap and later queries can land on different empty
 * in-memory DBs. A file path gives one shared database (across the
 * connection's queries) with libSQL's native vector engine compiled in.
 *
 * Each `create()` gets a *fresh* file inside one temp dir so repeated
 * scenario runs never inherit the prior run's persisted rows; the whole
 * dir is removed in `afterAll`.
 */
function libsqlDescriptor(): BackendDescriptor & { tempDir: string } {
  const temporaryDir = mkdtempSync(path.join(tmpdir(), "tg-vector-parity-"));
  let counter = 0;
  return {
    label: "libsql-file",
    tempDir: temporaryDir,
    async create() {
      const client: Client = createClient({
        url: `file:${path.join(temporaryDir, `parity-${counter++}.db`)}`,
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
// Scenario runner (drives the public store API end to end)
// ============================================================

async function runParityScenario(
  backend: GraphBackend,
): Promise<ParitySnapshot> {
  const [store] = await createStoreWithSchema(buildGraph(), backend);

  // The `id` is a create *option*, not a prop — passing stable,
  // human-readable ids makes cross-backend identity comparison
  // deterministic and the partition assertion legible.
  for (const seed of DOCUMENT_CORPUS) {
    await store.nodes.Document.create(
      { title: seed.title, embedding: seed.embedding },
      { id: seed.id },
    );
  }
  await store.nodes.Tag.create(
    { label: PARTITION_TAG.label, embedding: PARTITION_TAG.embedding },
    { id: PARTITION_TAG.id },
  );

  // --- Vector leg (brute-force, pre-materialization) ---
  const vectorHits = await store.search.vector("Document", {
    fieldPath: FIELD_PATH,
    queryEmbedding: QUERY_EMBEDDING,
    limit: DOCUMENT_CORPUS.length,
  });

  // --- Hybrid leg (RRF over vector + fulltext) ---
  const hybridHits = await store.search.hybrid("Document", {
    vector: { fieldPath: FIELD_PATH, queryEmbedding: QUERY_EMBEDDING },
    fulltext: { query: "document" },
    limit: DOCUMENT_CORPUS.length,
  });

  // --- Partition correctness: a decoy Tag identical to the query must
  //     stay inside the Tag partition and out of Document results. ---
  const partitionTagHits = await store.search.vector("Tag", {
    fieldPath: FIELD_PATH,
    queryEmbedding: QUERY_EMBEDDING,
    limit: DOCUMENT_CORPUS.length + 1,
  });
  const partitionDocumentHits = await store.search.vector("Document", {
    fieldPath: FIELD_PATH,
    queryEmbedding: QUERY_EMBEDDING,
    limit: DOCUMENT_CORPUS.length + 1,
  });

  // --- ANN leg: materialize the per-(kind, field) ANN index, then the
  //     same search exercises the accelerated path. ---
  await store.materializeIndexes();
  const annVectorHits = await store.search.vector("Document", {
    fieldPath: FIELD_PATH,
    queryEmbedding: QUERY_EMBEDDING,
    limit: DOCUMENT_CORPUS.length,
  });

  return {
    vectorIds: vectorHits.map((hit) => hit.node.id),
    vectorScores: vectorHits.map((hit) => roundScore(hit.score)),
    hybridIds: hybridHits.map((hit) => hit.node.id),
    annVectorIds: annVectorHits.map((hit) => hit.node.id),
    partitionTagIds: partitionTagHits.map((hit) => hit.node.id),
    partitionDocumentIds: partitionDocumentHits.map((hit) => hit.node.id),
  };
}

// ============================================================
// Suite
// ============================================================

describe("cross-backend vector + hybrid parity", () => {
  const libsql = libsqlDescriptor();

  // Postgres joins the matrix only when POSTGRES_URL is set, mirroring
  // the other Postgres suites. The pool is opened once and the
  // descriptor's create() resets schema + per-field tables per use.
  const TEST_DATABASE_URL =
    process.env.POSTGRES_URL ??
    "postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test";
  let postgresPool: Pool | undefined;

  beforeAll(async () => {
    if (!process.env.POSTGRES_URL) return;
    const pool = new Pool({
      connectionString: TEST_DATABASE_URL,
      connectionTimeoutMillis: 5000,
    });
    try {
      await pool.query("SELECT 1");
      postgresPool = pool;
    } catch {
      await pool.end().catch(() => {
        // Pool never connected; swallow the close error so an
        // unreachable Postgres degrades to "skip", not a suite failure.
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
      const pool = postgresPool!;
      // Fresh schema each run: drop base + strategy-owned per-field
      // vector tables so the scenario materializes its ANN index from
      // scratch and no embedding rows leak across reuse of the slot.
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
          // The pool is shared across runs and closed once in afterAll;
          // a per-run close would break later descriptors reusing it.
        },
      };
    },
  };

  /**
   * Runs a backend's full scenario, skipping cleanly when the backend
   * reports no vector capability (e.g. sqlite-vec not installed). Returns
   * the snapshot, or `undefined` when skipped.
   */
  async function snapshotFor(
    descriptor: BackendDescriptor,
  ): Promise<ParitySnapshot | undefined> {
    const { backend, cleanup } = await descriptor.create();
    try {
      if (backend.capabilities.vector?.supported !== true) return undefined;
      return await runParityScenario(backend);
    } finally {
      await cleanup();
    }
  }

  // ----------------------------------------------------------
  // Per-backend correctness (each engine, on its own terms)
  // ----------------------------------------------------------

  for (const descriptor of [localSqliteDescriptor, libsql]) {
    it(`[${descriptor.label}] ranks, fuses, partitions, and accelerates via the public store API`, async (ctx) => {
      const snapshot = await snapshotFor(descriptor);
      if (snapshot === undefined) {
        skipTest(ctx);
        return;
      }

      // Vector ranking: exact-match first, orthogonal last.
      expect(snapshot.vectorIds).toEqual(EXPECTED_VECTOR_ORDER);
      // Exact cosine match scores ~1; orthogonal ~0.
      expect(snapshot.vectorScores[0]).toBeCloseTo(1, SCORE_PRECISION);
      expect(snapshot.vectorScores.at(-1)).toBeCloseTo(0, SCORE_PRECISION);

      // Hybrid returns the same population (RRF over vector + fulltext);
      // every result is a Document and the exact match leads.
      expect(new Set(snapshot.hybridIds)).toEqual(
        new Set(EXPECTED_VECTOR_ORDER),
      );
      expect(snapshot.hybridIds[0]).toBe("alpha");

      // Post-materialize ANN agrees with the brute-force ranking on this
      // small, well-separated corpus.
      expect(snapshot.annVectorIds).toEqual(EXPECTED_VECTOR_ORDER);

      // Partition correctness: the decoy Tag (identical to the query)
      // is the only Tag result and never leaks into Document results.
      expect(snapshot.partitionTagIds).toEqual([PARTITION_TAG.id]);
      expect(snapshot.partitionDocumentIds).not.toContain(PARTITION_TAG.id);
      expect(snapshot.partitionDocumentIds).toEqual(EXPECTED_VECTOR_ORDER);
    });
  }

  // ----------------------------------------------------------
  // Cross-backend equality (the parity contract)
  // ----------------------------------------------------------

  it("local sqlite-vec and libSQL return byte-identical ranking and identity", async (ctx) => {
    const [local, libsqlSnapshot] = await Promise.all([
      snapshotFor(localSqliteDescriptor),
      snapshotFor(libsql),
    ]);
    if (local === undefined || libsqlSnapshot === undefined) {
      skipTest(ctx);
      return;
    }
    expect(libsqlSnapshot).toEqual(local);
  });

  it("Postgres/pgvector matches the SQLite-family ranking (POSTGRES_URL only)", async (ctx) => {
    if (postgresPool === undefined) {
      skipTest(ctx);
      return;
    }
    const reference = await snapshotFor(localSqliteDescriptor);
    if (reference === undefined) {
      skipTest(ctx);
      return;
    }
    const postgres = await snapshotFor(postgresDescriptor);
    expect(postgres).toBeDefined();

    // Identity is the parity contract; assert ordered ids exactly. Scores
    // are metric-identical (cosine similarity) but pgvector's HNSW recall
    // and float path can differ from sqlite-vec in the last ULP, so the
    // numeric vector is compared close, id-by-id.
    expect(postgres!.vectorIds).toEqual(reference.vectorIds);
    expect(postgres!.annVectorIds).toEqual(reference.annVectorIds);
    expect(new Set(postgres!.hybridIds)).toEqual(new Set(reference.hybridIds));
    expect(postgres!.hybridIds[0]).toBe(reference.hybridIds[0]);
    expect(postgres!.partitionTagIds).toEqual(reference.partitionTagIds);
    expect(postgres!.partitionDocumentIds).toEqual(
      reference.partitionDocumentIds,
    );
    for (const [index, score] of postgres!.vectorScores.entries()) {
      expect(score).toBeCloseTo(
        reference.vectorScores[index]!,
        SCORE_PRECISION,
      );
    }
  });
});
