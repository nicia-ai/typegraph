/**
 * Single-statement hybrid search: `backend.hybridSearch` composes both
 * sources, RRF fusion, liveness, and node hydration into ONE statement.
 *
 * Two contracts pinned here, across the backend matrix:
 *
 * 1. ROUND TRIPS — on the fast path the facade calls neither
 *    `backend.vectorSearch`, `backend.fulltextSearch`, nor the hydration
 *    fetch (`getNodes`). One backend call in, hits out.
 * 2. PARITY — the fused statement returns the same hits (ids, ranks,
 *    scores, sub-results, snippets) as the multi-statement JS-fusion
 *    path, for defaults, custom fusion weights/k, per-source minScore,
 *    snippets, a `where` filter, and offset pagination.
 *
 * The multi-statement reference runs through the same facade against a
 * shim backend whose `hybridSearch` is hidden — the fallback the store
 * keeps for kind expansions, custom backends, and profiles without
 * window functions.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { type Client, createClient } from "@libsql/client";
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode, searchable } from "../src";
import { generatePostgresMigrationSQL } from "../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../src/backend/postgres";
import { createLibsqlBackend } from "../src/backend/sqlite/libsql";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { type GraphBackend } from "../src/backend/types";
import { embedding } from "../src/core/embedding";
import { createStoreWithSchema } from "../src/store";
import { type HybridSearchHit } from "../src/store/search";

const GRAPH_ID = "hybrid_single_stmt";
const FIELD_PATH = "embedding";
const EMBEDDING_DIMENSIONS = 3;

const QUERY_EMBEDDING: readonly number[] = [1, 0, 0];
const FULLTEXT_QUERY = "signal";

const Document = defineNode("Document", {
  schema: z.object({
    title: searchable({ language: "english" }),
    category: z.string(),
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

/**
 * Vector and fulltext rankings deliberately DISAGREE (dense term matches
 * on the far vectors, sparse on the near ones) so RRF fusion has real
 * work to do and any rank-handling drift between the SQL and JS fusion
 * paths shows up as reordering.
 */
const CORPUS = [
  { id: "d1", title: "signal", category: "a", embedding: [1, 0, 0] },
  {
    id: "d2",
    title: "signal signal signal signal",
    category: "b",
    embedding: [0, 1, 0],
  },
  { id: "d3", title: "signal signal", category: "a", embedding: [0.9, 0.3, 0] },
  {
    id: "d4",
    title: "signal signal signal",
    category: "b",
    embedding: [0.2, 0.9, 0.1],
  },
  {
    id: "d5",
    title: "faint signal here",
    category: "a",
    embedding: [0.7, 0.7, 0],
  },
  {
    id: "d6",
    title: "signal boost relay",
    category: "b",
    embedding: [0.5, 0.8, 0.2],
  },
] as const;

type ScopedOptions = Readonly<{
  limit: number;
  offset?: number;
  fusion?: Readonly<{
    k?: number;
    weights?: Readonly<{ vector?: number; fulltext?: number }>;
  }>;
  vectorMinScore?: number;
  includeSnippets?: boolean;
  whereCategory?: string;
}>;

const OPTION_CASES: readonly Readonly<{
  label: string;
  options: ScopedOptions;
}>[] = [
  { label: "defaults", options: { limit: 4 } },
  {
    label: "custom fusion weights and k",
    options: {
      limit: 4,
      fusion: { k: 10, weights: { vector: 2, fulltext: 0.5 } },
    },
  },
  { label: "vector minScore", options: { limit: 4, vectorMinScore: 0.5 } },
  { label: "snippets", options: { limit: 4, includeSnippets: true } },
  { label: "where filter", options: { limit: 3, whereCategory: "a" } },
  { label: "offset page", options: { limit: 2, offset: 2 } },
];

function skipTest(ctx: { skip: () => void }): void {
  ctx.skip();
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
  const temporaryDir = mkdtempSync(path.join(tmpdir(), "tg-hybrid-stmt-"));
  let counter = 0;
  return {
    label: "libsql-file",
    tempDir: temporaryDir,
    async create() {
      const client: Client = createClient({
        url: `file:${path.join(temporaryDir, `hybrid-${counter++}.db`)}`,
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

async function seedStore(backend: GraphBackend) {
  const [store] = await createStoreWithSchema(buildGraph(), backend);
  for (const seed of CORPUS) {
    await store.nodes.Document.create(
      { title: seed.title, category: seed.category, embedding: seed.embedding },
      { id: seed.id },
    );
  }
  return store;
}

function runHybrid(
  store: Awaited<ReturnType<typeof seedStore>>,
  options: ScopedOptions,
) {
  return store.search.hybrid("Document", {
    vector: {
      fieldPath: FIELD_PATH,
      queryEmbedding: QUERY_EMBEDDING,
      ...(options.vectorMinScore === undefined ?
        {}
      : { minScore: options.vectorMinScore }),
    },
    fulltext: {
      query: FULLTEXT_QUERY,
      ...(options.includeSnippets === undefined ?
        {}
      : { includeSnippets: options.includeSnippets }),
    },
    limit: options.limit,
    ...(options.offset === undefined ? {} : { offset: options.offset }),
    ...(options.fusion === undefined ? {} : { fusion: options.fusion }),
    ...(options.whereCategory === undefined ?
      {}
    : {
        where: (document: { category: { eq: (v: string) => unknown } }) =>
          document.category.eq(options.whereCategory!),
      }),
  } as never);
}

/** The comparable projection of one hybrid hit. */
function projectHit(hit: HybridSearchHit) {
  return {
    id: hit.node.id,
    rank: hit.rank,
    score: Number(hit.score.toFixed(10)),
    vectorRank: hit.vector?.rank,
    vectorScore:
      hit.vector === undefined ?
        undefined
      : Number(hit.vector.score.toFixed(6)),
    fulltextRank: hit.fulltext?.rank,
    hasSnippet: hit.fulltext?.snippet !== undefined,
  };
}

describe("single-statement hybrid search", () => {
  const libsql = libsqlDescriptor();

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
        // Unreachable Postgres degrades to "skip".
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

  async function runScenario(descriptor: BackendDescriptor): Promise<void> {
    const { backend, cleanup } = await descriptor.create();
    try {
      if (backend.capabilities.vector?.supported !== true) return;
      expect(backend.hybridSearch).toBeDefined();
      const store = await seedStore(backend);

      // --- Round trips: the fast path must not touch the per-source
      //     searches or the hydration fetch. ---
      const vectorSpy = vi.spyOn(
        backend as { vectorSearch: NonNullable<GraphBackend["vectorSearch"]> },
        "vectorSearch",
      );
      const fulltextSpy = vi.spyOn(
        backend as {
          fulltextSearch: NonNullable<GraphBackend["fulltextSearch"]>;
        },
        "fulltextSearch",
      );
      const getNodesSpy = vi.spyOn(
        backend as { getNodes: NonNullable<GraphBackend["getNodes"]> },
        "getNodes",
      );
      const hits = await runHybrid(store, { limit: 4 });
      expect(hits.length).toBeGreaterThan(0);
      expect(vectorSpy).not.toHaveBeenCalled();
      expect(fulltextSpy).not.toHaveBeenCalled();
      expect(getNodesSpy).not.toHaveBeenCalled();
      vectorSpy.mockRestore();
      fulltextSpy.mockRestore();
      getNodesSpy.mockRestore();

      // --- Parity vs the multi-statement path, option case by case. ---
      // Hiding hybridSearch forces the store's fallback; both paths run
      // through the same facade on the same data.
      const fallbackBackend = new Proxy(backend, {
        get(target, property, receiver) {
          if (property === "hybridSearch") return;
          return Reflect.get(target, property, receiver) as unknown;
        },
      });
      const [fallbackStore] = await createStoreWithSchema(
        buildGraph(),
        fallbackBackend,
      );

      for (const { label, options } of OPTION_CASES) {
        const native = await runHybrid(store, options);
        const fallback = await runHybrid(fallbackStore, options);
        expect({
          case: label,
          hits: native.map((hit) => projectHit(hit)),
        }).toEqual({
          case: label,
          hits: fallback.map((hit) => projectHit(hit)),
        });
      }

      // Invalid source depths reject identically on both paths — the fast
      // path must not skip the boundary validation the fallback applies.
      const invalidDepth = {
        vector: {
          fieldPath: FIELD_PATH,
          queryEmbedding: QUERY_EMBEDDING,
          k: 0,
        },
        fulltext: { query: FULLTEXT_QUERY },
        limit: 3,
      } as const;
      await expect(
        store.search.hybrid("Document", invalidDepth),
        "native path must reject k: 0",
      ).rejects.toThrow(/positive integer/);
      await expect(
        fallbackStore.search.hybrid("Document", invalidDepth),
        "fallback path must reject k: 0",
      ).rejects.toThrow(/positive integer/);
    } finally {
      await cleanup();
    }
  }

  for (const descriptor of [localSqliteDescriptor, libsql]) {
    it(`[${descriptor.label}] fuses in one statement with multi-statement parity`, async () => {
      await runScenario(descriptor);
    });
  }

  it("[postgres-pgvector] fuses in one statement with multi-statement parity", async (ctx) => {
    if (postgresPool === undefined) {
      skipTest(ctx);
      return;
    }
    await runScenario(postgresDescriptor);
  });

  it("[postgres-pgvector] hides hybridSearch when window functions are disabled", async (ctx) => {
    if (postgresPool === undefined) {
      skipTest(ctx);
      return;
    }
    // A capability profile without window functions cannot run the
    // ROW_NUMBER() fusion statement; the member must be absent so the
    // store's multi-statement fallback engages.
    const { cleanup } = await postgresDescriptor.create();
    try {
      const noWindowBackend = createPostgresBackend(
        drizzleNodePostgres(postgresPool),
        { capabilities: { windowFunctions: false } },
      );
      expect(noWindowBackend.hybridSearch).toBeUndefined();

      const store = await seedStore(noWindowBackend);
      const vectorSpy = vi.spyOn(
        noWindowBackend as {
          vectorSearch: NonNullable<GraphBackend["vectorSearch"]>;
        },
        "vectorSearch",
      );
      const hits = await runHybrid(store, { limit: 4 });
      expect(hits.length).toBeGreaterThan(0);
      expect(vectorSpy).toHaveBeenCalled();
      vectorSpy.mockRestore();
    } finally {
      await cleanup();
    }
  });
});
