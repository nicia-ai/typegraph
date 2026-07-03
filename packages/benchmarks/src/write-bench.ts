/**
 * Write-throughput bench: the cost of getting data INTO TypeGraph.
 *
 * Measures the write shapes the read-oriented perf suite never touches —
 * per-op creates, transaction-amortized creates, multi-row bulkCreate,
 * search-indexed (fulltext + vector) creates, and interchange import — on
 * the same lane matrix as the main suite (sqlite memory/file, postgres).
 *
 * Run:
 *   pnpm --filter @nicia-ai/typegraph-benchmarks bench:write
 *   pnpm --filter @nicia-ai/typegraph-benchmarks bench:write:file
 *   POSTGRES_URL=... pnpm --filter @nicia-ai/typegraph-benchmarks bench:write:postgres
 *
 * Results append to reports/history.jsonl as `write:*` labels, normalized
 * to milliseconds per operation so lanes and dataset sizes stay comparable.
 * Report-only: no guardrails yet — write latency is dominated by fsync
 * behavior on the file lane and needs per-machine calibration first.
 */
import {
  FORMAT_VERSION,
  type GraphData,
  importGraph,
  type ImportOptions,
} from "@nicia-ai/typegraph/interchange";

import { createBackendResources } from "./backend";
import { parseCliOptions } from "./cli";
import { EMBEDDING_DIMENSIONS, type PerfStore } from "./graph";
import { writeHistoryEntry } from "./history";
import { type LatencyRecord } from "./measurements";
import { formatMs, median, nowMs, percentile } from "./utils";

const WARMUP_ITERATIONS = 1;
const SAMPLE_ITERATIONS = 7;

const SINGLE_CREATE_OPS = 200;
const TXN_CREATE_OPS = 200;
const BULK_CREATE_ROWS = 1000;
const DOC_CREATE_OPS = 100;
const IMPORT_NODE_COUNT = 500;
const IMPORT_EDGE_COUNT = 500;

const USER_BIO_BYTES = 1024;
const DOC_BODY_BYTES = 4096;

const USER_BIO = "x".repeat(USER_BIO_BYTES);
const DOC_BODY = "search corpus text ".repeat(
  Math.ceil(DOC_BODY_BYTES / "search corpus text ".length),
);

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

function buildEmbedding(): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, () => embeddingRng());
}

/** Monotonic id source so every warmup/sample writes fresh rows. */
let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

const IMPORT_OPTIONS: ImportOptions = {
  onConflict: "error",
  onUnknownProperty: "error",
  validateReferences: true,
  batchSize: 250,
  // The default post-import ANALYZE is skipped here: its cost grows with
  // total database size, which would drift across samples and swamp the
  // per-row import signal this bench isolates.
  refreshStatistics: false,
};

function buildImportPayload(): GraphData {
  const userIds = Array.from({ length: IMPORT_NODE_COUNT }, () =>
    nextId("import-user"),
  );
  return {
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    source: { type: "external", description: "write-bench synthetic" },
    nodes: userIds.map((id, index) => ({
      kind: "User",
      id,
      properties: {
        name: `import-${id}`,
        city: index % 3 === 0 ? "San Francisco" : "New York",
        bio: USER_BIO,
      },
    })),
    edges: Array.from({ length: IMPORT_EDGE_COUNT }, (_, index) => ({
      kind: "follows",
      id: nextId("import-follow"),
      from: { kind: "User", id: userIds[index % userIds.length]! },
      to: { kind: "User", id: userIds[(index + 1) % userIds.length]! },
      properties: {},
    })),
  };
}

type WriteShape = Readonly<{
  label: string;
  ops: number;
  /** Prepares inputs OUTSIDE the timed region; returns the timed run. */
  prepare: (store: PerfStore) => () => Promise<void>;
}>;

const SHAPES: readonly WriteShape[] = [
  {
    label: "write:single-create",
    ops: SINGLE_CREATE_OPS,
    prepare: (store) => {
      const inputs = Array.from({ length: SINGLE_CREATE_OPS }, () => ({
        name: nextId("single"),
        city: "New York",
        bio: USER_BIO,
      }));
      return async () => {
        for (const input of inputs) {
          await store.nodes.User.create(input);
        }
      };
    },
  },
  {
    label: "write:txn-create",
    ops: TXN_CREATE_OPS,
    prepare: (store) => {
      const inputs = Array.from({ length: TXN_CREATE_OPS }, () => ({
        name: nextId("txn"),
        city: "New York",
        bio: USER_BIO,
      }));
      return async () => {
        await store.transaction(async (tx) => {
          for (const input of inputs) {
            await tx.nodes.User.create(input);
          }
        });
      };
    },
  },
  {
    label: "write:bulk-create",
    ops: BULK_CREATE_ROWS,
    prepare: (store) => {
      const inputs = Array.from({ length: BULK_CREATE_ROWS }, () => ({
        props: {
          name: nextId("bulk"),
          city: "San Francisco",
          bio: USER_BIO,
        },
      }));
      return async () => {
        await store.nodes.User.bulkCreate(inputs);
      };
    },
  },
  {
    label: "write:doc-create",
    ops: DOC_CREATE_OPS,
    prepare: (store) => {
      const inputs = Array.from({ length: DOC_CREATE_OPS }, () => ({
        title: nextId("doc"),
        body: DOC_BODY,
        category: "bench",
        embedding: buildEmbedding(),
      }));
      return async () => {
        for (const input of inputs) {
          await store.nodes.Doc.create(input);
        }
      };
    },
  },
  {
    label: "write:import",
    ops: IMPORT_NODE_COUNT + IMPORT_EDGE_COUNT,
    prepare: (store) => {
      const payload = buildImportPayload();
      return async () => {
        const result = await importGraph(store, payload, IMPORT_OPTIONS);
        if (!result.success) {
          throw new Error(
            `write:import failed: ${JSON.stringify(result.errors[0])}`,
          );
        }
      };
    },
  },
];

async function measureShape(
  store: PerfStore,
  shape: WriteShape,
): Promise<
  Readonly<{
    perOpMedian: number;
    perOpP95: number;
    samples: readonly number[];
  }>
> {
  for (let index = 0; index < WARMUP_ITERATIONS; index++) {
    await shape.prepare(store)();
  }
  const samples: number[] = [];
  for (let index = 0; index < SAMPLE_ITERATIONS; index++) {
    const run = shape.prepare(store);
    const start = nowMs();
    await run();
    samples.push((nowMs() - start) / shape.ops);
  }
  return {
    perOpMedian: median(samples),
    perOpP95: percentile(samples, 0.95),
    samples,
  };
}

async function main(argv: readonly string[]): Promise<void> {
  const options = parseCliOptions(argv);
  const storageSuffix =
    options.backend === "sqlite" ? `, storage=${options.sqliteStorage}` : "";
  const driverSuffix =
    options.backend === "postgres" ? `, driver=${options.postgresDriver}` : "";
  console.log(
    `TypeGraph write bench (backend=${options.backend}${driverSuffix}${storageSuffix}, warmup=${WARMUP_ITERATIONS}, samples=${SAMPLE_ITERATIONS})`,
  );
  if (options.runChecks) {
    console.log(
      "(--check has no write guardrails yet — running in report mode)",
    );
  }

  const resources = await createBackendResources(
    options.backend,
    options.postgresDriver,
    options.sqliteStorage,
  );
  if (!resources.hasVectorPredicate) {
    console.log(
      "(no vector strategy on this backend — write:doc-create measures fulltext sync only)",
    );
  }

  try {
    const latencies: LatencyRecord = new Map();
    for (const shape of SHAPES) {
      const { perOpMedian, perOpP95, samples } = await measureShape(
        resources.store,
        shape,
      );
      latencies.set(shape.label, {
        median: perOpMedian,
        p95: perOpP95,
        samples,
      });
      const opsPerSecond = perOpMedian > 0 ? Math.round(1000 / perOpMedian) : 0;
      console.log(
        `${shape.label.padEnd(22)} ${formatMs(perOpMedian).padStart(8)}/op  p95 ${formatMs(perOpP95).padStart(8)}/op  (~${opsPerSecond} ops/s, ${shape.ops} ops/sample)`,
      );
    }

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
