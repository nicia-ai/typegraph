/**
 * Opt-in approximate retrieval for the inline `.similarTo()` predicate:
 * `{ approximate: true }` compiles each declaring kind's relevance branch
 * to the engine's native ANN search form (vec0 `MATCH … k=`, libSQL
 * `vector_top_k`, pgvector's index-eligible scan), scoped to the alias's
 * candidate nodes through the same pushdown the search facade uses.
 *
 * Pinned here, across the backend matrix:
 * - PARITY: on a small corpus (where ANN recall is total) approximate
 *   results equal exact results — plain, composed with a property
 *   predicate, and fused with fulltext — so the opt-in changes retrieval
 *   strategy, not semantics, at this scale.
 * - COMPILE SHAPE: the approximate branch actually reaches the ANN form
 *   (`tg_ann_src` wrapper; vec0 `MATCH`; libSQL `vector_top_k`), and the
 *   default path never does.
 * - DEGRADATION: a slot declared `indexType: "none"` compiles the opt-in
 *   to the strategy's exact scan (no MATCH), with identical results.
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

const GRAPH_ID = "similar_to_ann";
const EMBEDDING_DIMENSIONS = 3;
const QUERY_EMBEDDING: readonly number[] = [1, 0, 0];

const Document = defineNode("AnnDoc", {
  schema: z.object({
    category: z.string(),
    title: searchable({ language: "english" }),
    embedding: embedding(EMBEDDING_DIMENSIONS),
  }),
});

/**
 * Cosine-declared kind with magnitude-skewed vectors: the cosine-nearest
 * doc to the query is NOT the l2-nearest, so ANN retrieval under the
 * declared metric followed by l2 re-scoring would return the wrong row —
 * the exact regression surface for a metric override + approximate.
 */
const MagDocument = defineNode("MagDoc", {
  schema: z.object({
    embedding: embedding(EMBEDDING_DIMENSIONS),
  }),
});

/** A second kind whose slot declares no ANN index. */
const FlatDocument = defineNode("FlatDoc", {
  schema: z.object({
    category: z.string(),
    embedding: embedding(EMBEDDING_DIMENSIONS, { indexType: "none" }),
  }),
});

function buildGraph() {
  return defineGraph({
    id: GRAPH_ID,
    nodes: {
      AnnDoc: { type: Document },
      FlatDoc: { type: FlatDocument },
      MagDoc: { type: MagDocument },
    },
    edges: {},
  });
}

const CORPUS = [
  { id: "d1", category: "a", embedding: [1, 0, 0] },
  { id: "d2", category: "b", embedding: [0.95, 0.2, 0] },
  { id: "d3", category: "a", embedding: [0.8, 0.6, 0] },
  { id: "d4", category: "b", embedding: [0.5, 0.8, 0.2] },
  { id: "d5", category: "a", embedding: [0.2, 0.9, 0.3] },
  { id: "d6", category: "b", embedding: [0, 1, 0] },
] as const;

function skipTest(ctx: { skip: () => void }): void {
  ctx.skip();
}

type BackendCleanup = () => Promise<void> | void;

type CreatedBackend = Readonly<{
  backend: GraphBackend;
  cleanup: BackendCleanup;
  /** Substring proving the engine-native ANN form was compiled. */
  annMarker: string;
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
      annMarker: "MATCH",
    });
  },
};

function libsqlDescriptor(): BackendDescriptor & { tempDir: string } {
  const temporaryDir = mkdtempSync(path.join(tmpdir(), "tg-similar-ann-"));
  let counter = 0;
  return {
    label: "libsql-file",
    tempDir: temporaryDir,
    async create() {
      const client: Client = createClient({
        url: `file:${path.join(temporaryDir, `ann-${counter++}.db`)}`,
      });
      const { backend } = await createLibsqlBackend(client);
      return {
        backend,
        cleanup: async () => {
          await backend.close();
          client.close();
        },
        annMarker: "vector_top_k",
      };
    },
  };
}

async function seedStore(backend: GraphBackend) {
  const [store] = await createStoreWithSchema(buildGraph(), backend);
  for (const seed of CORPUS) {
    await store.nodes.AnnDoc.create(
      {
        category: seed.category,
        title: `signal document ${seed.id}`,
        embedding: seed.embedding,
      },
      { id: seed.id },
    );
    await store.nodes.FlatDoc.create(
      { category: seed.category, embedding: seed.embedding },
      { id: `flat-${seed.id}` },
    );
  }
  // Magnitude-skewed corpus: query [1,0,0] — cosine ranks mag-far first
  // (collinear, huge magnitude), l2 ranks mag-near first.
  await store.nodes.MagDoc.create({ embedding: [10, 0, 0] }, { id: "mag-far" });
  await store.nodes.MagDoc.create(
    { embedding: [0.9, 0.1, 0] },
    { id: "mag-near" },
  );
  await store.nodes.MagDoc.create({ embedding: [0, 1, 0] }, { id: "mag-off" });
  await store.materializeIndexes();
  return store;
}

type Store = Awaited<ReturnType<typeof seedStore>>;

function documentQuery(
  store: Store,
  kind: "AnnDoc" | "FlatDoc",
  options: Readonly<{ approximate?: boolean; category?: string }>,
) {
  const query = store
    .query()
    .from(kind, "d")
    .whereNode("d", (document) => {
      const similar = document.embedding.similarTo(QUERY_EMBEDDING, 4, {
        ...(options.approximate === undefined ?
          {}
        : { approximate: options.approximate }),
      });
      return options.category === undefined ?
          similar
        : similar.and(document.category.eq(options.category));
    });
  return query.select((ctx) => ({ id: ctx.d.id }));
}

async function ids(
  query: Readonly<{ execute: () => Promise<readonly unknown[]> }>,
): Promise<readonly string[]> {
  const rows = await query.execute();
  return rows.map((row) => (row as { id: string }).id);
}

async function runScenario(created: CreatedBackend): Promise<void> {
  const { backend, cleanup, annMarker } = created;
  try {
    if (backend.capabilities.vector?.supported !== true) return;
    const store = await seedStore(backend);

    // --- Parity: plain, filtered, and on the unindexed slot. ---
    const exact = await ids(documentQuery(store, "AnnDoc", {}));
    const approximate = await ids(
      documentQuery(store, "AnnDoc", { approximate: true }),
    );
    expect(approximate).toEqual(exact);

    const exactFiltered = await ids(
      documentQuery(store, "AnnDoc", { category: "a" }),
    );
    const approximateFiltered = await ids(
      documentQuery(store, "AnnDoc", { approximate: true, category: "a" }),
    );
    expect(approximateFiltered).toEqual(exactFiltered);
    expect(exactFiltered.length).toBeGreaterThan(0);

    const flatExact = await ids(documentQuery(store, "FlatDoc", {}));
    const flatApproximate = await ids(
      documentQuery(store, "FlatDoc", { approximate: true }),
    );
    expect(flatApproximate).toEqual(flatExact);

    // --- Metric override + approximate: the ANN structure is built for
    //     the DECLARED metric, so an overridden metric must fall back to
    //     the exact scan. The corpus makes the failure observable: cosine
    //     top-1 is mag-far, l2 top-1 is mag-near — ANN-retrieval under
    //     cosine re-scored as l2 would return mag-far. ---
    function magQuery(options: Readonly<{ approximate?: boolean }>) {
      return store
        .query()
        .from("MagDoc", "d")
        .whereNode("d", (document) =>
          document.embedding.similarTo(QUERY_EMBEDDING, 1, {
            metric: "l2",
            ...(options.approximate === undefined ?
              {}
            : { approximate: options.approximate }),
          }),
        )
        .select((ctx) => ({ id: ctx.d.id }));
    }
    const l2Exact = await ids(magQuery({}));
    expect(l2Exact).toEqual(["mag-near"]);
    const l2Approximate = await ids(magQuery({ approximate: true }));
    expect(l2Approximate).toEqual(["mag-near"]);
    // The mismatched override compiled to the exact scan, not the ANN form.
    expect(magQuery({ approximate: true }).toSQL().sql).not.toContain(
      "tg_ann_src",
    );
    // Sanity: cosine ranking really does disagree on this corpus.
    const cosineTop = await ids(
      store
        .query()
        .from("MagDoc", "d")
        .whereNode("d", (document) =>
          document.embedding.similarTo(QUERY_EMBEDDING, 1),
        )
        .select((ctx) => ({ id: ctx.d.id })),
    );
    expect(cosineTop).toEqual(["mag-far"]);

    // --- Fusion composition: the approximate vector CTE feeds the same
    //     RRF machinery; fused rankings must match the exact path. ---
    function fusedQuery(approximate: boolean) {
      return store
        .query()
        .from("AnnDoc", "d")
        .whereNode("d", (document) =>
          document.$fulltext.matches("signal", 6).and(
            document.embedding.similarTo(QUERY_EMBEDDING, 6, {
              approximate,
            }),
          ),
        )
        .select((ctx) => ({ id: ctx.d.id }));
    }
    const fusedExact = await ids(fusedQuery(false));
    const fusedApproximate = await ids(fusedQuery(true));
    expect(fusedApproximate).toEqual(fusedExact);
    expect(fusedExact.length).toBeGreaterThan(0);

    // --- Compile shape. ---
    const approximateSql = documentQuery(store, "AnnDoc", {
      approximate: true,
    }).toSQL().sql;
    expect(approximateSql).toContain("tg_ann_src");
    expect(approximateSql).toContain(annMarker);

    const exactSql = documentQuery(store, "AnnDoc", {}).toSQL().sql;
    expect(exactSql).not.toContain("tg_ann_src");

    // The unindexed slot degrades to the strategy's exact scan even
    // with the opt-in: wrapper present, ANN form absent (pgvector's
    // scan shape is index-driven, so this only distinguishes on the
    // SQLite-family engines whose ANN form is syntactic).
    const flatSql = documentQuery(store, "FlatDoc", {
      approximate: true,
    }).toSQL().sql;
    expect(flatSql).toContain("tg_ann_src");
    if (annMarker !== "tg_ann_src") {
      expect(flatSql).not.toContain(annMarker);
    }
  } finally {
    await cleanup();
  }
}

describe("similarTo approximate opt-in", () => {
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
        // pgvector's ANN form is the same ORDER BY/LIMIT scan shape — the
        // approximate wrapper is the observable compile-level marker.
        annMarker: "tg_ann_src",
      };
    },
  };

  for (const descriptor of [localSqliteDescriptor, libsql]) {
    it(`[${descriptor.label}] approximate mode reaches the ANN form with small-corpus parity`, async () => {
      await runScenario(await descriptor.create());
    });
  }

  it("[postgres-pgvector] approximate mode reaches the ANN form with small-corpus parity", async (ctx) => {
    if (postgresPool === undefined) {
      skipTest(ctx);
      return;
    }
    await runScenario(await postgresDescriptor.create());
  });
});
