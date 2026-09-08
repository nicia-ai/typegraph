/**
 * Item D.2's benchmark gate (design note §13): prices the acyclicity
 * reachability probe against the `cardinality: "one"` fence baseline and
 * an unconstrained `many` baseline, on chain-append, chain-prepend, and
 * forest shapes.
 *
 * Run:
 *   pnpm --filter @nicia-ai/typegraph-benchmarks bench:acyclicity
 *   pnpm --filter @nicia-ai/typegraph-benchmarks bench:acyclicity:file
 *   POSTGRES_URL=... pnpm --filter @nicia-ai/typegraph-benchmarks bench:acyclicity:postgres
 *
 * Scope note: this lane runs the wide-DAG and diamond-lattice shapes from
 * the design note's §13.2 table are NOT implemented here — chain-append,
 * chain-prepend, and forest are, at 10^4 and 10^5 edges. Report-only, no
 * guardrails, matching write-bench's stance. The ship-criteria decision
 * (D-7) is the lead's, run against this lane's own PostgreSQL numbers.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type GraphBackend,
  type Store,
} from "@nicia-ai/typegraph";
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite/local";
import { createPostgresBackend } from "@nicia-ai/typegraph/adapters/drizzle/postgres";
import { z } from "zod";

import { getPostgresUrl, type PerfBackend, type SqliteStorage } from "./config";
import { writeHistoryEntry } from "./history";
import { type LatencyRecord } from "./measurements";
import { formatMs, median, nowMs, percentile } from "./utils";

const WARMUP_ITERATIONS = 1;
const SAMPLE_ITERATIONS = 7;
const SIZES = [10_000, 100_000] as const;

const Task = defineNode("Task", { schema: z.object({}) });
/** The unconstrained baseline: no probe, no fence. */
const plainMany = defineEdge("plainMany", { schema: z.object({}) });
/** The fence-only baseline: `checkCardinalityConstraint`, no reachability walk. */
const cardinalityOne = defineEdge("cardinalityOne", { schema: z.object({}) });
/** The subject: the fence plus the recursive reachability probe. */
const dependsOn = defineEdge("dependsOn", { schema: z.object({}) });

const graph = defineGraph({
  id: "acyclicity_bench",
  nodes: { Task: { type: Task } },
  edges: {
    plainMany: { type: plainMany, from: [Task], to: [Task] },
    cardinalityOne: {
      type: cardinalityOne,
      from: [Task],
      to: [Task],
      cardinality: "one",
    },
    dependsOn: {
      type: dependsOn,
      from: [Task],
      to: [Task],
      cardinality: "many",
      acyclic: true,
    },
  },
});

type BenchStore = Store<typeof graph>;

type BackendHandle = Readonly<{
  backend: GraphBackend;
  close: () => Promise<void>;
}>;

async function buildBackend(
  kind: PerfBackend,
  sqliteStorage: SqliteStorage,
): Promise<BackendHandle> {
  if (kind === "sqlite") {
    const tempDir =
      sqliteStorage === "file" ?
        mkdtempSync(join(tmpdir(), "typegraph-acyclicity-bench-"))
      : undefined;
    const { backend } = createLocalSqliteBackend(
      tempDir === undefined ? {} : { path: join(tempDir, "bench.db") },
    );
    return {
      backend,
      close: async () => {
        await backend.close();
        if (tempDir !== undefined)
          rmSync(tempDir, { recursive: true, force: true });
      },
    };
  }
  const pool = new Pool({ connectionString: getPostgresUrl() });
  const backend = createPostgresBackend(drizzleNodePostgres(pool));
  return { backend, close: () => pool.end() };
}

/**
 * Every `Task` id, in a chain: `task-0 -> task-1 -> ... -> task-{size-1}`.
 *
 * `dependsOn` (the acyclic kind) is seeded with one sequential `create` per
 * edge rather than the chunked `bulkCreate` the other two kinds use. A
 * `bulkCreate` batch runs `assertBatchEdgesRelationsAcyclic` ONCE across
 * every row in the chunk as simultaneous origins (§ design note 9.3): for a
 * chunk that is itself a contiguous run of a chain, origin `k`'s walk
 * traverses the rest of the SAME chunk's suffix, so a `CHUNK`-edge chunk
 * costs O(`CHUNK`^2) rather than O(`CHUNK`) — fine at the small chunk sizes
 * elsewhere in this file, but 2000^2 row-pairs is exactly the cliff this
 * shape hits. Appending one edge at a time never has this cost: the fresh
 * `to` endpoint has no outgoing edges yet, so each single-edge probe is O(1)
 * regardless of chain length (the same reason `benchChainAppend`'s measured
 * loop is cheap) — which is also the realistic way an application grows an
 * acyclic chain, so this is the representative seeding cost, not a
 * benchmark-only workaround.
 */
async function seedChain(
  store: BenchStore,
  edgeKind: "plainMany" | "cardinalityOne" | "dependsOn",
  size: number,
): Promise<readonly string[]> {
  const nodes = await store.nodes.Task.bulkCreate(
    Array.from({ length: size }, () => ({ props: {} })),
  );
  const ids = nodes.map((node) => node.id);
  if (edgeKind === "dependsOn") {
    for (let index = 0; index < nodes.length - 1; index += 1) {
      await store.edges[edgeKind].create(nodes[index]!, nodes[index + 1]!);
    }
    return ids;
  }
  // Chunked so one bulkCreate statement never exceeds a reasonable bind
  // budget at 10^5 edges.
  const CHUNK = 2000;
  for (let start = 0; start < ids.length - 1; start += CHUNK) {
    const end = Math.min(start + CHUNK, ids.length - 1);
    await store.edges[edgeKind].bulkCreate(
      Array.from({ length: end - start }, (_unused, offset) => {
        const index = start + offset;
        return { from: nodes[index]!, to: nodes[index + 1]! };
      }),
    );
  }
  return ids;
}

/**
 * `count` disjoint 4-node trees, each with a `root` this function returns:
 * a branching root with two children for `plainMany`/`dependsOn`, or (since
 * `cardinality: "one"` permits at most one outgoing edge per source, ruling
 * out a branching root) a 4-node linear chain for `cardinalityOne` — same
 * node count and walk depth, the only shape that edge kind's fence allows.
 */
async function seedForest(
  store: BenchStore,
  edgeKind: "plainMany" | "cardinalityOne" | "dependsOn",
  treeCount: number,
): Promise<readonly string[]> {
  const nodesPerTree = 4;
  const nodes = await store.nodes.Task.bulkCreate(
    Array.from({ length: treeCount * nodesPerTree }, () => ({ props: {} })),
  );
  const edges: { from: (typeof nodes)[number]; to: (typeof nodes)[number] }[] =
    [];
  const roots: string[] = [];
  for (let tree = 0; tree < treeCount; tree += 1) {
    const base = tree * nodesPerTree;
    const root = nodes[base]!;
    roots.push(root.id);
    if (edgeKind === "cardinalityOne") {
      edges.push({ from: root, to: nodes[base + 1]! });
      edges.push({ from: nodes[base + 1]!, to: nodes[base + 2]! });
      edges.push({ from: nodes[base + 2]!, to: nodes[base + 3]! });
    } else {
      edges.push({ from: root, to: nodes[base + 1]! });
      edges.push({ from: root, to: nodes[base + 2]! });
      edges.push({ from: nodes[base + 1]!, to: nodes[base + 3]! });
    }
  }
  const CHUNK = 2000;
  for (let start = 0; start < edges.length; start += CHUNK) {
    await store.edges[edgeKind].bulkCreate(edges.slice(start, start + CHUNK));
  }
  return roots;
}

async function measureInsert(
  run: () => Promise<void>,
): Promise<
  Readonly<{ median: number; p95: number; samples: readonly number[] }>
> {
  for (let index = 0; index < WARMUP_ITERATIONS; index += 1) await run();
  const samples: number[] = [];
  for (let index = 0; index < SAMPLE_ITERATIONS; index += 1) {
    const start = nowMs();
    await run();
    samples.push(nowMs() - start);
  }
  return { median: median(samples), p95: percentile(samples, 0.95), samples };
}

async function benchChainAppend(
  backendHandle: BackendHandle,
  size: number,
  edgeKind: "plainMany" | "cardinalityOne" | "dependsOn",
  latencies: LatencyRecord,
): Promise<void> {
  const [store] = await createStoreWithSchema(graph, backendHandle.backend);
  const ids = await seedChain(store, edgeKind, size);
  // Rolls forward each iteration: a `cardinality: "one"` edge allows only
  // one outgoing edge per source, so re-appending from the SAME tail on
  // every sample would refuse from the second iteration on.
  let tail = { kind: "Task" as const, id: ids[ids.length - 1]! };
  const label = `acyclicity:${edgeKind}:chain-append:${String(size)}`;
  const {
    median: medianMs,
    p95,
    samples,
  } = await measureInsert(async () => {
    const fresh = await store.nodes.Task.create({});
    await store.edges[edgeKind].create(tail, fresh);
    tail = { kind: "Task", id: fresh.id };
  });
  latencies.set(label, { median: medianMs, p95, samples });
  console.log(
    `${label.padEnd(48)} ${formatMs(medianMs).padStart(8)}  p95 ${formatMs(p95).padStart(8)}`,
  );
}

async function benchChainPrepend(
  backendHandle: BackendHandle,
  size: number,
  edgeKind: "plainMany" | "cardinalityOne" | "dependsOn",
  latencies: LatencyRecord,
): Promise<void> {
  const [store] = await createStoreWithSchema(graph, backendHandle.backend);
  const ids = await seedChain(store, edgeKind, size);
  const head = { kind: "Task" as const, id: ids[0]! };
  const label = `acyclicity:${edgeKind}:chain-prepend:${String(size)}`;
  const {
    median: medianMs,
    p95,
    samples,
  } = await measureInsert(async () => {
    const fresh = await store.nodes.Task.create({});
    await store.edges[edgeKind].create(fresh, head);
  });
  latencies.set(label, { median: medianMs, p95, samples });
  console.log(
    `${label.padEnd(48)} ${formatMs(medianMs).padStart(8)}  p95 ${formatMs(p95).padStart(8)}`,
  );
}

async function benchForest(
  backendHandle: BackendHandle,
  size: number,
  edgeKind: "plainMany" | "cardinalityOne" | "dependsOn",
  latencies: LatencyRecord,
): Promise<void> {
  const treeCount = Math.max(1, Math.floor(size / 4));
  const [store] = await createStoreWithSchema(graph, backendHandle.backend);
  const roots = await seedForest(store, edgeKind, treeCount);
  // A fresh node above an EXISTING tree's root: the walk from that root
  // must traverse the whole (small, ~4-node) tree before concluding "not
  // found", and — this is the point of the shape — must not touch any of
  // the other disjoint trees to do it. `from` is always a brand-new node,
  // so cardinality: "one" never refuses a repeat.
  const label = `acyclicity:${edgeKind}:forest:${String(size)}`;
  const {
    median: medianMs,
    p95,
    samples,
  } = await measureInsert(async () => {
    const fresh = await store.nodes.Task.create({});
    const root = { kind: "Task" as const, id: roots[0]! };
    await store.edges[edgeKind].create(fresh, root);
  });
  latencies.set(label, { median: medianMs, p95, samples });
  console.log(
    `${label.padEnd(48)} ${formatMs(medianMs).padStart(8)}  p95 ${formatMs(p95).padStart(8)}`,
  );
}

async function main(argv: readonly string[]): Promise<void> {
  const backendKind: PerfBackend =
    argv.includes("--backend=postgres") ? "postgres" : "sqlite";
  const sqliteStorage: SqliteStorage =
    argv.includes("--storage=file") ? "file" : "memory";
  console.log(
    `TypeGraph acyclicity bench (backend=${backendKind}${backendKind === "sqlite" ? `, storage=${sqliteStorage}` : ""}, warmup=${WARMUP_ITERATIONS}, samples=${SAMPLE_ITERATIONS})`,
  );

  const latencies: LatencyRecord = new Map();
  for (const size of SIZES) {
    for (const edgeKind of [
      "plainMany",
      "cardinalityOne",
      "dependsOn",
    ] as const) {
      for (const shape of [benchChainAppend, benchChainPrepend, benchForest]) {
        const handle = await buildBackend(backendKind, sqliteStorage);
        try {
          await shape(handle, size, edgeKind, latencies);
        } finally {
          await handle.close();
        }
      }
    }
  }

  const historyPath = writeHistoryEntry({
    backend: backendKind,
    ...(backendKind === "sqlite" ? { sqliteStorage } : {}),
    scale: 1,
    userCount: 0,
    latencies,
  });
  console.log(`\nappended run to ${historyPath}`);

  console.log(
    "\nD-7 ship criteria (read manually against the numbers above):" +
      '\n  - acyclic insert p95 within ~3x the cardinality:"one" insert p95 at 10^5 edges on the forest shape, on both engines.' +
      '\n  - 8-writer PostgreSQL contention run keeps aggregate throughput within ~30% of the cardinality:"one" run (not measured by this lane).' +
      "\nFail either => the maintained ancestor set needs to be designed before D.2 ships. This lane does not decide it — the lead does, from PostgreSQL numbers this script does not produce.",
  );
}

await main(process.argv.slice(2));
