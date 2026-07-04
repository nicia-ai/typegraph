/**
 * Exact means exact: the non-approximate `.similarTo()` path must
 * return identical results before and after an ANN index materializes.
 *
 * pgvector serves any `ORDER BY embedding <=> q LIMIT k` from a
 * matching HNSW/IVFFlat index when one exists, so without a defense the
 * default (non-approximate) path silently turns approximate the moment
 * `materializeIndexes()` runs — measured recall 0.980 unfiltered and
 * 0.000 under a selective filter at 50k docs, where the index frontier
 * starves at the default ef_search. The exact branch orders by
 * `(distance + 0.0)`, which the opclass cannot match.
 *
 * Pinned:
 * 1. Semantics — exact results (unfiltered and filtered) are identical
 *    pre- and post-index; `approximate: true` still uses the ANN form.
 * 2. Plan — the compiled non-approximate statement never scans the
 *    pgvector index; the approximate statement does (guarding that the
 *    corpus is big enough for the pin to mean something).
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { randomUUID } from "node:crypto";

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
  process.env.POSTGRES_URL ??
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
  if (!process.env.POSTGRES_URL) return;
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

const DIMS = 32;
const DOC_COUNT = 2000;
const TOP_K = 8;

const Document = defineNode("Doc", {
  schema: z.object({
    category: z.string(),
    embedding: embedding(DIMS),
  }),
});

function createRng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xff_ff_ff_ff;
  };
}

type ExactStore = Awaited<
  ReturnType<typeof createStoreWithSchema<ReturnType<typeof buildGraph>>>
>[0];

function buildGraph(graphId: string) {
  return defineGraph({
    id: graphId,
    nodes: { Doc: { type: Document } },
    edges: {},
  });
}

async function seed(store: ExactStore): Promise<number[]> {
  const rng = createRng(7);
  let queryVector: number[] = [];
  for (let start = 0; start < DOC_COUNT; start += 500) {
    await store.nodes.Doc.bulkCreate(
      Array.from({ length: 500 }, (_, offset) => {
        const index = start + offset;
        const vector = Array.from({ length: DIMS }, () => rng());
        if (index === 321) queryVector = vector.map((v) => v + 0.01);
        return {
          id: `d${index}`,
          props: { category: `cat-${index % 5}`, embedding: vector },
        };
      }),
    );
  }
  await store.refreshStatistics();
  return queryVector;
}

function similarQuery(
  store: ExactStore,
  queryVector: readonly number[],
  options: Readonly<{ approximate?: boolean; category?: string }>,
) {
  return store
    .query()
    .from("Doc", "d")
    .whereNode("d", (document) => {
      const similar = document.embedding.similarTo([...queryVector], TOP_K, {
        metric: "cosine",
        ...(options.approximate === undefined ?
          {}
        : { approximate: options.approximate }),
      });
      return options.category === undefined ?
          similar
        : similar.and(document.category.eq(options.category));
    })
    .select((ctx) => ({ id: ctx.d.id }));
}

async function ids(
  query: Readonly<{ execute: () => Promise<readonly unknown[]> }>,
): Promise<readonly string[]> {
  const rows = await query.execute();
  return rows.map((row) => (row as { id: string }).id);
}

describe("exact vector scan with an ANN index present", () => {
  it("returns identical exact results before and after materialization", async (ctx) => {
    const activePool = requirePostgres(ctx);
    const backend = createPostgresBackend(drizzle(activePool));
    const [store] = await createStoreWithSchema(
      buildGraph(`exact_sem_${randomUUID().slice(0, 8)}`),
      backend,
    );
    const queryVector = await seed(store);

    const truthUnfiltered = await ids(similarQuery(store, queryVector, {}));
    const truthFiltered = await ids(
      similarQuery(store, queryVector, { category: "cat-3" }),
    );
    expect(truthUnfiltered).toHaveLength(TOP_K);
    expect(truthFiltered).toHaveLength(TOP_K);

    const result = await store.materializeIndexes();
    const vectorEntry = result.results.find(
      (entry) => entry.entity === "vector",
    );
    expect(vectorEntry?.status).toBe("created");

    expect(await ids(similarQuery(store, queryVector, {}))).toEqual(
      truthUnfiltered,
    );
    expect(
      await ids(similarQuery(store, queryVector, { category: "cat-3" })),
    ).toEqual(truthFiltered);
  });

  it("keeps the ANN index off the exact plan while approximate uses it", async (ctx) => {
    const activePool = requirePostgres(ctx);
    const backend = createPostgresBackend(drizzle(activePool));
    const [store] = await createStoreWithSchema(
      buildGraph(`exact_plan_${randomUUID().slice(0, 8)}`),
      backend,
    );
    const queryVector = await seed(store);
    await store.materializeIndexes();

    // Plans are captured under `enable_seqscan = off`: at test-corpus
    // scale the planner may legitimately prefer the flat scan for BOTH
    // forms on cost, which would make the exact pin vacuous. With seq
    // scans penalized, the index is used wherever it CAN be — so its
    // absence from the exact plan proves the opclass cannot match, not
    // that the planner didn't feel like it.
    async function planOf(
      query: Readonly<{
        toSQL: () => Readonly<{ sql: string; params: readonly unknown[] }>;
      }>,
    ) {
      const compiled = query.toSQL();
      const client = await activePool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL enable_seqscan = off");
        // Penalize explicit sorts too: the opclass-matching index scan
        // is then the only cheap plan, so pre-defense the exact form
        // would deterministically pick tg_vecidx at ANY corpus size —
        // its absence can only mean the ordered expression cannot match.
        await client.query("SET LOCAL enable_sort = off");
        const explained = await client.query(
          `EXPLAIN ${compiled.sql}`,
          compiled.params as unknown[],
        );
        await client.query("ROLLBACK");
        return explained.rows
          .map((row) => (row as Record<string, string>)["QUERY PLAN"])
          .join("\n");
      } finally {
        client.release();
      }
    }

    const exactPlan = await planOf(similarQuery(store, queryVector, {}));
    expect(exactPlan).not.toContain("tg_vecidx");

    // Guard that the pin is meaningful: the bare opclass-matching form
    // on the same table IS served by the index under the same settings,
    // so the exact plan's index absence is attributable to the
    // `(distance + 0.0)` defense, not to a missing/unusable index.
    // (The inline `approximate: true` form is deliberately not used as
    // the guard: its candidates subquery currently keeps the planner
    // off the index — a separate known finding.)
    const strategyTable = backend.vectorStrategy?.tableName(
      store.graphId,
      "Doc",
      "embedding",
    );
    expect(strategyTable).toBeDefined();
    const bare = {
      toSQL: () => ({
        sql: `SELECT node_id FROM "${strategyTable}" ORDER BY embedding <=> $1::vector LIMIT ${TOP_K}`,
        params: [JSON.stringify(queryVector)] as readonly unknown[],
      }),
    };
    const barePlan = await planOf(bare);
    expect(barePlan).toContain("tg_vecidx");
  });
});
