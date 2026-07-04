/**
 * Facade search FILTER PUSHDOWN: `store.search.{vector,fulltext,hybrid}`
 * accept a `where` predicate,
 * `offset` pagination, and `includeSubClasses` — all compiled into the
 * search statement's candidate set, not post-filtered.
 *
 * The pushdown is pinned BEHAVIORALLY: the corpus is built so the global
 * top-k for every leg is occupied by rows the filter excludes (`beta` docs
 * sit nearest the query vector and match the fulltext query densest). A
 * rank-then-filter implementation cannot return `limit` matching hits;
 * only computing top-k over the filtered candidate set can.
 *
 * Also pinned here: search follows the store's CURRENT-read semantics — a
 * node whose `validTo` has passed never ranks, matching `find()` (the
 * liveness phase only excluded tombstones).
 *
 * Matrix mirrors `search-liveness.test.ts`: local sqlite-vec and libSQL
 * always attempted (vector legs capability-gated), Postgres/pgvector when
 * `POSTGRES_URL` is set. Brute-force and post-materialize ANN paths both
 * asserted.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { type Client, createClient } from "@libsql/client";
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode, searchable, subClassOf } from "../src";
import { generatePostgresMigrationSQL } from "../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../src/backend/postgres";
import { createLibsqlBackend } from "../src/backend/sqlite/libsql";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { type GraphBackend } from "../src/backend/types";
import { embedding } from "../src/core/embedding";
import { createStoreWithSchema } from "../src/store";
import { type VectorSearchOptions } from "../src/store/search";

const GRAPH_ID = "search_pushdown";
const FIELD_PATH = "embedding";
const EMBEDDING_DIMENSIONS = 3;
const LIMIT = 3;

const QUERY_EMBEDDING: readonly number[] = [1, 0, 0];
const FULLTEXT_QUERY = "signal";

const Article = defineNode("Article", {
  schema: z.object({
    title: searchable({ language: "english" }),
    category: z.string(),
    embedding: embedding(EMBEDDING_DIMENSIONS),
  }),
});

const Note = defineNode("Note", {
  schema: z.object({
    title: searchable({ language: "english" }),
    category: z.string(),
    embedding: embedding(EMBEDDING_DIMENSIONS),
  }),
});

function buildGraph() {
  return defineGraph({
    id: GRAPH_ID,
    nodes: { Article: { type: Article }, Note: { type: Note } },
    edges: {},
    ontology: [subClassOf(Note, Article)],
  });
}

type Seed = Readonly<{
  id: string;
  title: string;
  category: string;
  embedding: readonly number[];
  validTo?: string;
}>;

/**
 * `beta` docs occupy the global top-3 on BOTH legs (nearest vectors,
 * densest term matches); `alpha` docs rank strictly below them. A filtered
 * search for `alpha` can only fill `limit` by pushing the filter into the
 * candidate set.
 */
const ARTICLES: readonly Seed[] = [
  // Global top-k occupants (filter excludes them).
  {
    id: "beta-1",
    title: "signal signal signal",
    category: "beta",
    embedding: [1, 0, 0],
  },
  {
    id: "beta-2",
    title: "signal signal boost",
    category: "beta",
    embedding: [0.99, 0.05, 0],
  },
  {
    id: "beta-3",
    title: "signal signal relay",
    category: "beta",
    embedding: [0.97, 0.1, 0],
  },
  // The filtered population, with a deterministic internal order.
  {
    id: "alpha-1",
    title: "signal processing",
    category: "alpha",
    embedding: [0.8, 0.6, 0],
  },
  {
    id: "alpha-2",
    title: "a signal apart",
    category: "alpha",
    embedding: [0.6, 0.8, 0],
  },
  {
    id: "alpha-3",
    title: "faint signal",
    category: "alpha",
    embedding: [0.4, 0.9, 0.2],
  },
] as const;

/**
 * Best-ranked on every leg AND matching the `alpha` filter — but its
 * validity ended in the past. Current-mode search must never return it.
 */
const EXPIRED_ARTICLE: Seed = {
  id: "alpha-expired",
  title: "signal signal signal signal expired",
  category: "alpha",
  embedding: [1, 0, 0],
  validTo: "2001-01-01T00:00:00.000Z",
};

/** Sub-kind rows: near the query, `alpha`, only visible via includeSubClasses. */
const NOTES: readonly Seed[] = [
  {
    id: "note-1",
    title: "signal note",
    category: "alpha",
    embedding: [0.95, 0.2, 0],
  },
  {
    id: "note-2",
    title: "another signal note",
    category: "alpha",
    embedding: [0.9, 0.3, 0],
  },
] as const;

const ALPHA_ARTICLE_IDS = ["alpha-1", "alpha-2", "alpha-3"] as const;

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
  const temporaryDir = mkdtempSync(path.join(tmpdir(), "tg-search-pushdown-"));
  let counter = 0;
  return {
    label: "libsql-file",
    tempDir: temporaryDir,
    async create() {
      const client: Client = createClient({
        url: `file:${path.join(temporaryDir, `pushdown-${counter++}.db`)}`,
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

async function seedCorpus(backend: GraphBackend) {
  const [store] = await createStoreWithSchema(buildGraph(), backend);
  for (const seed of [...ARTICLES, EXPIRED_ARTICLE]) {
    await store.nodes.Article.create(
      { title: seed.title, category: seed.category, embedding: seed.embedding },
      seed.validTo === undefined ?
        { id: seed.id }
      : { id: seed.id, validTo: seed.validTo },
    );
  }
  for (const seed of NOTES) {
    await store.nodes.Note.create(
      { title: seed.title, category: seed.category, embedding: seed.embedding },
      { id: seed.id },
    );
  }
  return store;
}

type Store = Awaited<ReturnType<typeof seedCorpus>>;

function vectorIds(
  hits: readonly Readonly<{ node: { id: string } }>[],
): string[] {
  return hits.map((hit) => hit.node.id);
}

async function assertFilteredLegs(store: Store): Promise<void> {
  // Vector: the global top-3 is beta + the expired doc; only pushdown fills 3 alphas.
  const vector = await store.search.vector("Article", {
    fieldPath: FIELD_PATH,
    queryEmbedding: QUERY_EMBEDDING,
    limit: LIMIT,
    where: (article) => article.category.eq("alpha"),
  });
  expect(vectorIds(vector), "vector filtered").toEqual([...ALPHA_ARTICLE_IDS]);

  // Fulltext: beta docs match densest; only pushdown fills 3 alphas.
  const fulltext = await store.search.fulltext("Article", {
    query: FULLTEXT_QUERY,
    limit: LIMIT,
    where: (article) => article.category.eq("alpha"),
  });
  expect(new Set(vectorIds(fulltext)), "fulltext filtered").toEqual(
    new Set(ALPHA_ARTICLE_IDS),
  );

  // Hybrid inherits the filter on both legs.
  const hybrid = await store.search.hybrid("Article", {
    vector: { fieldPath: FIELD_PATH, queryEmbedding: QUERY_EMBEDDING },
    fulltext: { query: FULLTEXT_QUERY },
    limit: LIMIT,
    where: (article) => article.category.eq("alpha"),
  });
  expect(new Set(vectorIds(hybrid)), "hybrid filtered").toEqual(
    new Set(ALPHA_ARTICLE_IDS),
  );
}

// ============================================================
// Suite
// ============================================================

describe("facade search filter pushdown", () => {
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
      const store = await seedCorpus(backend);

      // Fulltext legs run on every backend.
      const fulltextFiltered = await store.search.fulltext("Article", {
        query: FULLTEXT_QUERY,
        limit: LIMIT,
        where: (article) => article.category.eq("alpha"),
      });
      expect(new Set(vectorIds(fulltextFiltered))).toEqual(
        new Set(ALPHA_ARTICLE_IDS),
      );

      // Fulltext pagination: two disjoint pages spanning the filtered set.
      const page1 = await store.search.fulltext("Article", {
        query: FULLTEXT_QUERY,
        limit: 2,
        where: (article) => article.category.eq("alpha"),
      });
      const page2 = await store.search.fulltext("Article", {
        query: FULLTEXT_QUERY,
        limit: 2,
        offset: 2,
        where: (article) => article.category.eq("alpha"),
      });
      const pagedIds = [...vectorIds(page1), ...vectorIds(page2)];
      expect(new Set(pagedIds)).toEqual(new Set(ALPHA_ARTICLE_IDS));
      expect(pagedIds).toHaveLength(3);

      // The expired-validity doc never ranks, on any leg, despite being the
      // best match for both query and filter.
      const unfiltered = await store.search.fulltext("Article", {
        query: FULLTEXT_QUERY,
        limit: 10,
      });
      expect(vectorIds(unfiltered)).not.toContain(EXPIRED_ARTICLE.id);

      if (backend.capabilities.vector?.supported !== true) return;

      await assertFilteredLegs(store);

      // Vector pagination (unfiltered): pages tile the full ranking.
      const fullOrder = await store.search.vector("Article", {
        fieldPath: FIELD_PATH,
        queryEmbedding: QUERY_EMBEDDING,
        limit: 6,
      });
      expect(vectorIds(fullOrder)).toHaveLength(6);
      expect(vectorIds(fullOrder)).not.toContain(EXPIRED_ARTICLE.id);
      const vecPage1 = await store.search.vector("Article", {
        fieldPath: FIELD_PATH,
        queryEmbedding: QUERY_EMBEDDING,
        limit: 3,
      });
      const vecPage2 = await store.search.vector("Article", {
        fieldPath: FIELD_PATH,
        queryEmbedding: QUERY_EMBEDDING,
        limit: 3,
        offset: 3,
      });
      expect([...vectorIds(vecPage1), ...vectorIds(vecPage2)]).toEqual(
        vectorIds(fullOrder),
      );

      // Sub-kind rows only participate with includeSubClasses.
      const baseOnly = await store.search.vector("Article", {
        fieldPath: FIELD_PATH,
        queryEmbedding: QUERY_EMBEDDING,
        limit: 10,
      });
      expect(vectorIds(baseOnly)).not.toContain("note-1");
      const withSubs = await store.search.vector("Article", {
        fieldPath: FIELD_PATH,
        queryEmbedding: QUERY_EMBEDDING,
        limit: 10,
        includeSubClasses: true,
      });
      expect(vectorIds(withSubs)).toEqual(
        expect.arrayContaining(["note-1", "note-2"]),
      );
      // Merged ranking is globally ordered: note-1 ([0.95, .2, 0]) sits
      // between beta-3 (0.97) and alpha-1 (0.8).
      const withSubsIds = vectorIds(withSubs);
      expect(withSubsIds.indexOf("note-1")).toBeGreaterThan(
        withSubsIds.indexOf("beta-3"),
      );
      expect(withSubsIds.indexOf("note-1")).toBeLessThan(
        withSubsIds.indexOf("alpha-1"),
      );

      // Filter + subclasses compose.
      const alphaWithSubs = await store.search.vector("Article", {
        fieldPath: FIELD_PATH,
        queryEmbedding: QUERY_EMBEDDING,
        limit: 10,
        includeSubClasses: true,
        where: (article) => article.category.eq("alpha"),
      });
      expect(new Set(vectorIds(alphaWithSubs))).toEqual(
        new Set([...ALPHA_ARTICLE_IDS, "note-1", "note-2"]),
      );

      // ANN path: materialize, then the filtered legs must still be exact.
      await store.materializeIndexes();
      await assertFilteredLegs(store);
    } finally {
      await cleanup();
    }
  }

  for (const descriptor of [localSqliteDescriptor, libsql]) {
    it(`[${descriptor.label}] pushes filters, pagination, and subclasses into search`, async () => {
      await runScenario(descriptor);
    });
  }

  it("[postgres-pgvector] pushes filters, pagination, and subclasses into search", async (ctx) => {
    if (postgresPool === undefined) {
      skipTest(ctx);
      return;
    }
    await runScenario(postgresDescriptor);
  });

  it("rejects mixed declared metrics across a subclass expansion", async () => {
    // No per-call metric can bridge mixed declared metrics: each kind's
    // storage is validated against its declared metric, so the expansion
    // is unsupported outright.
    const L2Note = defineNode("L2Note", {
      schema: z.object({
        title: searchable({ language: "english" }),
        category: z.string(),
        embedding: embedding(EMBEDDING_DIMENSIONS, { metric: "l2" }),
      }),
    });
    const graph = defineGraph({
      id: "search_pushdown_mixed",
      nodes: { Article: { type: Article }, L2Note: { type: L2Note } },
      edges: {},
      ontology: [subClassOf(L2Note, Article)],
    });
    const { backend, cleanup } = await localSqliteDescriptor.create();
    try {
      if (backend.capabilities.vector?.supported !== true) return;
      const [store] = await createStoreWithSchema(graph, backend);
      await expect(
        store.search.vector("Article", {
          fieldPath: FIELD_PATH,
          queryEmbedding: QUERY_EMBEDDING,
          limit: 3,
          includeSubClasses: true,
        }),
      ).rejects.toThrow(
        /declare different metrics.*search the kinds separately/s,
      );
    } finally {
      await cleanup();
    }
  });

  it("keeps standalone option values typed (where usable off the facade)", () => {
    // Compile-time pin for the exported generic option types: a standalone
    // options value can carry a where predicate against the base accessor.
    const standalone: VectorSearchOptions = {
      fieldPath: FIELD_PATH,
      queryEmbedding: QUERY_EMBEDDING,
      limit: 3,
      where: (node) => node.kind.eq("Article"),
    };
    expect(standalone.limit).toBe(3);
  });
});
