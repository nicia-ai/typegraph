/**
 * Vector search at scale: latency AND recall on a corpus large enough
 * for approximate indexes to behave like production (50k embeddings by
 * default; the main perf suite's few hundred make every ANN index look
 * perfect). This lane exists so vector tuning decisions are made
 * against measured recall/latency trade-offs instead of tiny-corpus
 * parity.
 *
 * The lane runs in two phases around `materializeIndexes()`:
 *
 * PRE-INDEX (flat scans — the ground truth):
 * - `vector:exact` / `vector:exact-filtered` — true exact top-10; the
 *   filtered leg also captures the un-indexed candidates cost (the
 *   category predicate detoasts every row's props, which carry the
 *   embedding — measured ~375ms at 50k on Postgres).
 *
 * POST-INDEX (ANN index + the declared category node index):
 * - `vector:ann` / `vector:ann-filtered` — approximate legs, recall@10
 *   against the pre-index exact results.
 * - `vector:exact-postindex` — the NON-approximate query re-measured
 *   with the ANN index present, with recall against pre-index truth.
 *   On pgvector any `ORDER BY embedding <=> q LIMIT k` can be served
 *   by the HNSW index, so this leg detects the default path silently
 *   turning approximate (recall < 1.000 means it did).
 * - `vector:exact-filtered-postindex` — the filtered leg with the
 *   category node index materialized (the candidates predicate becomes
 *   an index lookup; measured 375ms -> 7.5ms at 50k on Postgres).
 *
 * Recall lands in history as `vector:*-recall` pseudo-latency rows
 * (median = recall) so trends are greppable.
 *
 * Runtime budget: ~1-2 min on SQLite, ~3-6 min on Postgres (HNSW build
 * dominates). Scale with --scale=0.1 for a quick smoke pass.
 *
 * Run:
 *   pnpm --filter @nicia-ai/typegraph-benchmarks bench:vector
 *   pnpm --filter @nicia-ai/typegraph-benchmarks bench:vector:file
 *   POSTGRES_URL=... pnpm --filter @nicia-ai/typegraph-benchmarks bench:vector:postgres
 */
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  embedding,
} from "@nicia-ai/typegraph";
import { defineNodeIndex } from "@nicia-ai/typegraph/indexes";
import { z } from "zod";

import { createBackendResources } from "./backend";
import { parseCliOptions } from "./cli";
import { EMBEDDING_DIMENSIONS } from "./graph";
import { writeHistoryEntry } from "./history";
import { type LatencyRecord } from "./measurements";
import { formatMs, median, nowMs, percentile } from "./utils";

const BASE_DOC_COUNT = 50_000;
const SEED_CHUNK_ROWS = 2000;
const QUERY_COUNT = 20;
const TOP_K = 10;
const WARMUP_QUERIES = 3;
const SAMPLE_ROUNDS = 3;
const CATEGORY_COUNT = 10;
const FILTER_CATEGORY = "cat-3";
const QUERY_PERTURBATION = 0.01;

/**
 * Dedicated graph: the lane owns its kind so it can declare the
 * category node index the filtered legs depend on without touching the
 * main perf suite's shapes or baselines.
 */
const VecDoc = defineNode("VecDoc", {
  schema: z.object({
    category: z.string(),
    embedding: embedding(EMBEDDING_DIMENSIONS),
  }),
});

const categoryIndex = defineNodeIndex(VecDoc, { fields: ["category"] });

const vectorBenchGraph = defineGraph({
  id: "vector_bench",
  nodes: { VecDoc: { type: VecDoc } },
  edges: {},
  indexes: [categoryIndex],
});

type VectorBenchStore = Awaited<
  ReturnType<typeof createStoreWithSchema<typeof vectorBenchGraph>>
>[0];

/** Deterministic RNG (xorshift32) so embeddings are stable across runs. */
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

const embeddingRng = createRng(42);

/**
 * Clustered corpus: a Gaussian-ish mixture around CLUSTER_COUNT centers.
 * Uniform-random vectors are pathological for ANN graphs (in high
 * dimensions everything is nearly equidistant, so recall collapses and
 * says nothing about real workloads); real embedding spaces are locally
 * clustered, which is the regime HNSW/IVFFlat are built for.
 */
const CLUSTER_COUNT = 100;
const CLUSTER_SPREAD = 0.05;

const clusterCenters: number[][] = Array.from({ length: CLUSTER_COUNT }, () =>
  Array.from({ length: EMBEDDING_DIMENSIONS }, () => embeddingRng()),
);

let embeddingCounter = 0;

function buildEmbedding(): number[] {
  embeddingCounter += 1;
  const center = clusterCenters[embeddingCounter % CLUSTER_COUNT]!;
  return center.map(
    (value) => value + (embeddingRng() - 0.5) * 2 * CLUSTER_SPREAD,
  );
}

/**
 * Query vectors are perturbed copies of seeded embeddings: near enough
 * that the true neighbors are non-trivial, deterministic across runs.
 */
function perturb(base: readonly number[], rng: () => number): number[] {
  return base.map((value) => value + (rng() - 0.5) * 2 * QUERY_PERTURBATION);
}

async function seedCorpus(
  store: VectorBenchStore,
  docCount: number,
): Promise<readonly number[][]> {
  const queryBases: number[][] = [];
  // Spread the query bases evenly across the corpus.
  const queryBaseStride = Math.max(1, Math.floor(docCount / QUERY_COUNT));
  for (let start = 0; start < docCount; start += SEED_CHUNK_ROWS) {
    const rows = Array.from(
      { length: Math.min(SEED_CHUNK_ROWS, docCount - start) },
      (_, offset) => {
        const index = start + offset;
        const vector = buildEmbedding();
        if (index % queryBaseStride === 0 && queryBases.length < QUERY_COUNT)
          queryBases.push(vector);
        return {
          id: `vec-${index}`,
          props: {
            category: `cat-${index % CATEGORY_COUNT}`,
            embedding: vector,
          },
        };
      },
    );
    await store.nodes.VecDoc.bulkCreate(rows);
  }
  return queryBases;
}

type QueryLegOptions = Readonly<{
  approximate: boolean;
  filtered: boolean;
}>;

async function runQuery(
  store: VectorBenchStore,
  queryEmbedding: readonly number[],
  options: QueryLegOptions,
): Promise<readonly string[]> {
  const rows = await store
    .query()
    .from("VecDoc", "d")
    .whereNode("d", (doc) => {
      const similar = doc.embedding.similarTo([...queryEmbedding], TOP_K, {
        metric: "cosine",
        ...(options.approximate ? { approximate: true } : {}),
      });
      return options.filtered ?
          similar.and(doc.category.eq(FILTER_CATEGORY))
        : similar;
    })
    .select((ctx) => ({ id: ctx.d.id }))
    .execute();
  return rows.map((row) => (row as { id: string }).id);
}

type LegResult = Readonly<{
  medianMs: number;
  p95Ms: number;
  latencies: readonly number[];
  /** Result ids of the LAST round, per query index (for recall). */
  resultsByQuery: readonly (readonly string[])[];
}>;

async function measureLeg(
  store: VectorBenchStore,
  queries: readonly (readonly number[])[],
  options: QueryLegOptions,
): Promise<LegResult> {
  for (const query of queries.slice(0, WARMUP_QUERIES)) {
    await runQuery(store, query, options);
  }
  const latencies: number[] = [];
  let resultsByQuery: (readonly string[])[] = [];
  for (let round = 0; round < SAMPLE_ROUNDS; round++) {
    resultsByQuery = [];
    for (const query of queries) {
      const start = nowMs();
      const ids = await runQuery(store, query, options);
      latencies.push(nowMs() - start);
      resultsByQuery.push(ids);
    }
  }
  return {
    medianMs: median(latencies),
    p95Ms: percentile(latencies, 0.95),
    latencies,
    resultsByQuery,
  };
}

function meanRecall(
  exact: readonly (readonly string[])[],
  approximate: readonly (readonly string[])[],
): number {
  let total = 0;
  for (const [index, truth] of exact.entries()) {
    if (truth.length === 0) continue;
    const found = new Set(approximate[index] ?? []);
    let hits = 0;
    for (const id of truth) if (found.has(id)) hits += 1;
    total += hits / truth.length;
  }
  return total / exact.length;
}

function recordLeg(
  latencies: LatencyRecord,
  label: string,
  result: LegResult,
): void {
  latencies.set(label, {
    median: result.medianMs,
    p95: result.p95Ms,
    samples: result.latencies,
  });
  console.log(
    `${label.padEnd(34)} ${formatMs(result.medianMs).padStart(8)}  p95 ${formatMs(result.p95Ms).padStart(8)}  (${result.latencies.length} queries)`,
  );
}

function recordDuration(
  latencies: LatencyRecord,
  label: string,
  durationMs: number,
  detail: string,
): void {
  latencies.set(label, {
    median: durationMs,
    p95: durationMs,
    samples: [durationMs],
  });
  console.log(
    `${label.padEnd(34)} ${formatMs(durationMs).padStart(8)}  ${detail}`,
  );
}

function recordRecall(
  latencies: LatencyRecord,
  label: string,
  recall: number,
): void {
  // Pseudo-latency row: median carries the recall value so history
  // trend tooling picks it up without a second sink.
  latencies.set(label, { median: recall, p95: recall, samples: [recall] });
  console.log(`${label.padEnd(34)} ${recall.toFixed(3).padStart(8)}`);
}

async function main(argv: readonly string[]): Promise<void> {
  const options = parseCliOptions(argv);
  const docCount = Math.round(BASE_DOC_COUNT * options.scale);
  const storageSuffix =
    options.backend === "sqlite" ? `, storage=${options.sqliteStorage}` : "";
  const driverSuffix =
    options.backend === "postgres" ? `, driver=${options.postgresDriver}` : "";
  console.log(
    `TypeGraph vector bench (backend=${options.backend}${driverSuffix}${storageSuffix}, docs=${docCount}, dims=${EMBEDDING_DIMENSIONS}, k=${TOP_K})`,
  );

  const resources = await createBackendResources(
    options.backend,
    options.postgresDriver,
    options.sqliteStorage,
  );
  try {
    if (!resources.hasVectorPredicate) {
      console.log(
        "(no vector strategy on this backend — vector bench skipped)",
      );
      return;
    }
    // A schema-committed store over the lane's own graph (so
    // `materializeIndexes()` works and the declared category node index
    // belongs to this lane alone); same backend, same tables.
    const [store] = await createStoreWithSchema(
      vectorBenchGraph,
      resources.backend,
      { queryDefaults: { traversalExpansion: "none" } },
    );
    const latencies: LatencyRecord = new Map();

    const seedStart = nowMs();
    const queryBases = await seedCorpus(store, docCount);
    await store.refreshStatistics();
    recordDuration(
      latencies,
      "vector:seed",
      nowMs() - seedStart,
      `${docCount} docs (incl. embedding sync + refresh)`,
    );
    if (queryBases.length < QUERY_COUNT) {
      throw new Error(
        `query base drift: expected ${QUERY_COUNT} bases, got ${queryBases.length}`,
      );
    }

    const queryRng = createRng(7);
    const queries = queryBases.map((base) => perturb(base, queryRng));

    // --- PRE-INDEX: flat scans are the ground truth. ---
    const exact = await measureLeg(store, queries, {
      approximate: false,
      filtered: false,
    });
    recordLeg(latencies, "vector:exact", exact);

    const exactFiltered = await measureLeg(store, queries, {
      approximate: false,
      filtered: true,
    });
    recordLeg(latencies, "vector:exact-filtered", exactFiltered);

    // --- Materialize: the ANN index AND the category node index. ---
    const materializeStart = nowMs();
    const materialized = await store.materializeIndexes();
    const statuses = materialized.results.map(
      (entry) => `${entry.indexName}:${entry.status}`,
    );
    recordDuration(
      latencies,
      "vector:materialize",
      nowMs() - materializeStart,
      `[${statuses.join(", ")}]`,
    );
    const vectorEntries = materialized.results.filter(
      (entry) => entry.entity === "vector",
    );
    if (vectorEntries.length === 0) {
      throw new Error(
        "vector bench drift: materializeIndexes reported no vector index",
      );
    }
    // materializeIndexes is best-effort: a failed build is a status, not
    // a throw. Measuring "ANN" against a missing index is exactly the
    // bad signal this lane exists to prevent, so any failed entry
    // (vector or the category node index) aborts the run.
    const failedBuilds = materialized.results.filter(
      (entry) => entry.status === "failed",
    );
    if (failedBuilds.length > 0) {
      throw new Error(
        `vector bench: index build failed for ${failedBuilds
          .map((entry) => entry.indexName)
          .join(", ")} — refusing to measure without it`,
      );
    }

    // --- POST-INDEX legs, recall against pre-index truth. ---
    const ann = await measureLeg(store, queries, {
      approximate: true,
      filtered: false,
    });
    recordLeg(latencies, "vector:ann", ann);
    recordRecall(
      latencies,
      "vector:ann-recall",
      meanRecall(exact.resultsByQuery, ann.resultsByQuery),
    );

    const annFiltered = await measureLeg(store, queries, {
      approximate: true,
      filtered: true,
    });
    recordLeg(latencies, "vector:ann-filtered", annFiltered);
    recordRecall(
      latencies,
      "vector:ann-filtered-recall",
      meanRecall(exactFiltered.resultsByQuery, annFiltered.resultsByQuery),
    );

    // The NON-approximate query with the ANN index present: on pgvector
    // any `ORDER BY embedding <=> q LIMIT k` can be served by HNSW, so
    // recall < 1.000 here means the default path silently turned
    // approximate.
    const exactPostIndex = await measureLeg(store, queries, {
      approximate: false,
      filtered: false,
    });
    recordLeg(latencies, "vector:exact-postindex", exactPostIndex);
    recordRecall(
      latencies,
      "vector:exact-postindex-recall",
      meanRecall(exact.resultsByQuery, exactPostIndex.resultsByQuery),
    );

    // The filtered leg with the category node index in place: the
    // candidates predicate becomes an index lookup instead of a
    // detoast-everything scan.
    const exactFilteredPostIndex = await measureLeg(store, queries, {
      approximate: false,
      filtered: true,
    });
    recordLeg(
      latencies,
      "vector:exact-filtered-postindex",
      exactFilteredPostIndex,
    );
    recordRecall(
      latencies,
      "vector:exact-filtered-postindex-recall",
      meanRecall(
        exactFiltered.resultsByQuery,
        exactFilteredPostIndex.resultsByQuery,
      ),
    );

    const historyPath = writeHistoryEntry({
      backend: options.backend,
      ...(options.backend === "postgres" ?
        { postgresDriver: options.postgresDriver }
      : { sqliteStorage: options.sqliteStorage }),
      scale: options.scale,
      userCount: 0,
      latencies,
    });
    console.log(`\nappended run to ${historyPath}`);
  } finally {
    await resources.close();
  }
}

await main(process.argv.slice(2));
