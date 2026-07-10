/**
 * Cross-backend `l2` score-scale parity.
 *
 * `vectorScoreExpression` (src/query/dialect/vector-strategy.ts) maps a
 * distance to a score PER METRIC: cosine → `1 - distance`, but `l2` is
 * returned AS-IS — the raw Euclidean distance, lower = better, ordered
 * ascending. Each engine computes that distance with its own function
 * (`vec_distance_l2` / `<->` / `vector_distance_l2`), so nothing structurally
 * forces them to agree. This pins that the SAME embeddings and query yield the
 * SAME l2 scores and the SAME rank order on sqlite-vec, libSQL-native, and
 * pgvector — a squared-vs-Euclidean or scale divergence would surface here.
 *
 * A backend whose engine is unavailable (Postgres without POSTGRES_URL) is
 * skipped with a logged message; sqlite-vec and libSQL-native are always
 * present, so the assertion is never a silent no-op.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { type Client, createClient } from "@libsql/client";
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../../src";
import { generatePostgresMigrationSQL } from "../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../src/backend/postgres";
import { createLibsqlBackend } from "../../src/backend/sqlite/libsql";
import { createLocalSqliteBackend } from "../../src/backend/sqlite/local";
import { type GraphBackend } from "../../src/backend/types";
import { embedding } from "../../src/core/embedding";
import { createStoreWithSchema } from "../../src/store";

const GRAPH_ID = "l2_score_scale_parity";
const FIELD_PATH = "embedding";
const DIMENSIONS = 3;

// Query is the origin, so each doc's l2 score is the magnitude of its vector.
const QUERY_EMBEDDING: readonly number[] = [0, 0, 0];

// Magnitudes 1.732…, 2, 2.828…, 3, 4 — all distinct, so the ascending-distance
// rank order (n1, n2, n3, n4, n5) is unambiguous. The two irrationals catch a
// scale bug (e.g. squared vs Euclidean) that integers alone could hide.
const CORPUS = [
  { id: "n1", embedding: [1, 1, 1] },
  { id: "n2", embedding: [2, 0, 0] },
  { id: "n3", embedding: [2, 2, 0] },
  { id: "n4", embedding: [3, 0, 0] },
  { id: "n5", embedding: [0, 0, 4] },
] as const;

const EXPECTED_ORDER = ["n1", "n2", "n3", "n4", "n5"] as const;

// sqlite-vec and libSQL agree to the bit (float32 storage + compute); pgvector
// computes the sqrt in double, drifting ~1e-8. This ceiling is far tighter than
// any real squared-vs-Euclidean or scale divergence (which would be O(1)).
const SCORE_TOLERANCE = 1e-4;

const L2Document = defineNode("L2Doc", {
  schema: z.object({
    label: z.string(),
    embedding: embedding(DIMENSIONS, { metric: "l2" }),
  }),
});

function buildGraph() {
  return defineGraph({
    id: GRAPH_ID,
    nodes: { L2Doc: { type: L2Document } },
    edges: {},
  });
}

type BackendResult = Readonly<{
  label: string;
  order: readonly string[];
  scores: ReadonlyMap<string, number>;
}>;

type L2Ranking = Readonly<{
  order: readonly string[];
  scores: ReadonlyMap<string, number>;
}>;

async function runL2Search(backend: GraphBackend): Promise<L2Ranking> {
  const [store] = await createStoreWithSchema(buildGraph(), backend);
  for (const seed of CORPUS) {
    await store.nodes.L2Doc.create(
      { label: seed.id, embedding: seed.embedding },
      { id: seed.id },
    );
  }
  const hits = await store.search.vector("L2Doc", {
    fieldPath: FIELD_PATH,
    queryEmbedding: QUERY_EMBEDDING,
    metric: "l2",
    limit: CORPUS.length,
  });
  const order = hits.map((hit) => hit.node.id);
  const scores = new Map(hits.map((hit) => [hit.node.id, hit.score]));
  return { order, scores };
}

async function collectSqliteVec(): Promise<BackendResult> {
  const { backend } = createLocalSqliteBackend();
  try {
    const { order, scores } = await runL2Search(backend);
    return { label: "sqlite-vec", order, scores };
  } finally {
    await backend.close();
  }
}

describe("cross-backend l2 score-scale parity", () => {
  const temporaryDir = mkdtempSync(path.join(tmpdir(), "tg-l2-parity-"));

  const TEST_DATABASE_URL = process.env.POSTGRES_URL;
  let postgresPool: Pool | undefined;

  beforeAll(async () => {
    if (TEST_DATABASE_URL === undefined) return;
    const pool = new Pool({
      connectionString: TEST_DATABASE_URL,
      connectionTimeoutMillis: 5000,
    });
    try {
      await pool.query("SELECT 1");
      postgresPool = pool;
    } catch {
      await pool.end().catch(() => {
        // Unreachable Postgres degrades to a logged skip below.
      });
    }
  });

  afterAll(() => {
    rmSync(temporaryDir, { recursive: true, force: true });
    return postgresPool?.end();
  });

  async function collectLibsql(): Promise<BackendResult> {
    const client: Client = createClient({
      url: `file:${path.join(temporaryDir, "libsql-l2.db")}`,
    });
    const { backend } = await createLibsqlBackend(client);
    try {
      const { order, scores } = await runL2Search(backend);
      return { label: "libsql-native", order, scores };
    } finally {
      await backend.close();
      client.close();
    }
  }

  async function collectPostgres(pool: Pool): Promise<BackendResult> {
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
    const { order, scores } = await runL2Search(backend);
    return { label: "pgvector", order, scores };
  }

  it("returns identical l2 scores and rank order on every available backend", async () => {
    const results: BackendResult[] = [
      await collectSqliteVec(),
      await collectLibsql(),
    ];

    if (postgresPool === undefined) {
      console.warn(
        "[l2-score-scale-parity] Postgres/pgvector unavailable (set POSTGRES_URL) — comparing sqlite-vec vs libsql-native only.",
      );
    } else {
      results.push(await collectPostgres(postgresPool));
    }

    // Sanity: every backend must have ranked all docs before parity means
    // anything (a backend that returned nothing would trivially "agree").
    for (const result of results) {
      expect(result.order, `${result.label} rank order`).toEqual([
        ...EXPECTED_ORDER,
      ]);
    }

    const reference = results[0];
    if (reference === undefined) {
      throw new Error("no vector backends were available to compare");
    }
    for (const other of results.slice(1)) {
      expect(
        other.order,
        `${other.label} rank order must match ${reference.label}`,
      ).toEqual(reference.order);

      for (const id of reference.order) {
        const referenceScore = reference.scores.get(id)!;
        const otherScore = other.scores.get(id)!;
        expect(
          Math.abs(otherScore - referenceScore),
          `${other.label} l2 score for ${id} (${otherScore}) vs ${reference.label} (${referenceScore})`,
        ).toBeLessThan(SCORE_TOLERANCE);
      }
    }
  });
});
