import { performance } from "node:perf_hooks";

import {
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  type GraphBackend,
} from "@nicia-ai/typegraph";
import type { CompiledRowsSql } from "@nicia-ai/typegraph/backend";
import { z } from "zod";

import { deriveBackend } from "../../typegraph/src/backend/derive-backend";
import { createBackendResources } from "./backend";
import type { PerfBackend, PostgresDriver } from "./config";

const BenchNode = defineNode("SubgraphBenchNode", {
  schema: z.object({ label: z.string(), payload: z.string() }),
});
const benchLink = defineEdge("subgraphBenchLink", {
  schema: z.object({ payload: z.string() }),
});
const benchmarkGraph = defineGraph({
  id: "subgraph_batch_benchmark",
  nodes: { SubgraphBenchNode: { type: BenchNode } },
  edges: {
    subgraphBenchLink: {
      type: benchLink,
      from: [BenchNode],
      to: [BenchNode],
      cardinality: "many",
    },
  },
});

type ProjectionMode = "full" | "identity";
type Mode = "direct" | "batchOnceUnfused" | "batchOnceShared";
type BenchmarkStore = ReturnType<typeof createStore<typeof benchmarkGraph>>;
type BenchmarkNodeId = Parameters<BenchmarkStore["subgraph"]>[0];
type Options = Readonly<{
  backend: PerfBackend;
  postgresDriver: PostgresDriver;
  roots: number;
  depth: number;
  branching: number;
  overlap: number;
  projection: ProjectionMode;
  payloadBytes: number;
  iterations: number;
  warmup: number;
  simulatedRoundtripMs: number;
}>;
type Counters = {
  statements: number;
  backendExecuteMs: number;
  transferredRows: number;
  transferredBytes: number;
  simulatedDelayMsApplied: number;
};
type Sample = Readonly<Counters & { totalMs: number; heapDeltaBytes: number }>;

function numberOption(
  argv: readonly string[],
  name: string,
  fallback: number,
): number {
  const argument = argv.find((value) => value.startsWith(`--${name}=`));
  const value =
    argument === undefined ? fallback : Number(argument.slice(name.length + 3));
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value))
    throw new Error(`--${name} must be a non-negative integer`);
  return value;
}

function parseOptions(argv: readonly string[]): Options {
  const backendValue =
    argv.find((value) => value.startsWith("--backend="))?.slice(10) ?? "sqlite";
  if (backendValue !== "sqlite" && backendValue !== "postgres")
    throw new Error("--backend must be sqlite or postgres");
  const driverValue =
    argv.find((value) => value.startsWith("--postgres-driver="))?.slice(18) ??
    "pg";
  if (driverValue !== "pg" && driverValue !== "postgres-js")
    throw new Error("--postgres-driver must be pg or postgres-js");
  const projectionValue =
    argv.find((value) => value.startsWith("--projection="))?.slice(13) ??
    "full";
  if (projectionValue !== "full" && projectionValue !== "identity")
    throw new Error("--projection must be full or identity");
  const overlap = numberOption(argv, "overlap", 50);
  if (overlap > 100) throw new Error("--overlap must be between 0 and 100");
  const roots = numberOption(argv, "roots", 8);
  const branching = numberOption(argv, "branching", 3);
  const iterations = numberOption(argv, "iterations", 8);
  if (roots === 0 || branching === 0 || iterations === 0)
    throw new Error("--roots, --branching, and --iterations must be positive");
  return {
    backend: backendValue,
    postgresDriver: driverValue,
    roots,
    depth: numberOption(argv, "depth", 2),
    branching,
    overlap,
    projection: projectionValue,
    payloadBytes: numberOption(argv, "payload-bytes", 256),
    iterations,
    warmup: numberOption(argv, "warmup", 2),
    simulatedRoundtripMs: numberOption(argv, "simulated-roundtrip-ms", 0),
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function instrumentBackend(
  backend: GraphBackend,
  counters: Counters,
  simulatedRoundtripMs: number,
): GraphBackend {
  return deriveBackend(backend, {
    async execute<Result>(query: CompiledRowsSql): Promise<readonly Result[]> {
      counters.statements += 1;
      if (simulatedRoundtripMs > 0) {
        await delay(simulatedRoundtripMs);
        counters.simulatedDelayMsApplied += simulatedRoundtripMs;
      }
      const started = performance.now();
      const rows = await backend.execute<Result>(query);
      counters.backendExecuteMs += performance.now() - started;
      counters.transferredRows += rows.length;
      counters.transferredBytes += Buffer.byteLength(JSON.stringify(rows));
      return rows;
    },
  });
}

async function seed(
  store: BenchmarkStore,
  options: Options,
): Promise<readonly BenchmarkNodeId[]> {
  const payload = "x".repeat(options.payloadBytes);
  const roots = await Promise.all(
    Array.from({ length: options.roots }, (_, index) =>
      store.nodes.SubgraphBenchNode.create({ label: `root-${index}`, payload }),
    ),
  );
  const sharedRootCount = Math.round((options.roots * options.overlap) / 100);
  for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
    let frontier = [roots[rootIndex]!];
    if (rootIndex > 0 && rootIndex < sharedRootCount) {
      await store.edges.subgraphBenchLink.create(frontier[0]!, roots[0]!, {
        payload,
      });
    } else {
      for (let level = 0; level < options.depth; level += 1) {
        const next = [];
        for (const parent of frontier) {
          for (let branch = 0; branch < options.branching; branch += 1) {
            const child = await store.nodes.SubgraphBenchNode.create({
              label: `${rootIndex}-${level}-${branch}-${parent.id}`,
              payload,
            });
            await store.edges.subgraphBenchLink.create(parent, child, {
              payload,
            });
            next.push(child);
          }
        }
        frontier = next;
      }
    }
  }
  return roots.map((root) => root.id);
}

async function executeMode(
  mode: Mode,
  store: BenchmarkStore,
  rootIds: readonly BenchmarkNodeId[],
  options: Options,
): Promise<void> {
  if (options.projection === "identity") {
    const queryOptions = {
      edges: ["subgraphBenchLink"],
      maxDepth: options.depth,
      project: {
        nodes: { SubgraphBenchNode: [] },
        edges: { subgraphBenchLink: [] },
      },
    } as const;
    if (mode === "direct") {
      await Promise.all(
        rootIds.map((rootId) => store.subgraph(rootId, queryOptions)),
      );
      return;
    }
    await store.batchOnce(
      (read) => rootIds.map((rootId) => read.subgraph(rootId, queryOptions)),
      { shareSubgraphs: mode === "batchOnceShared" },
    );
    return;
  }
  const queryOptions = {
    edges: ["subgraphBenchLink"],
    maxDepth: options.depth,
    project: {
      nodes: { SubgraphBenchNode: ["label", "payload"] },
      edges: { subgraphBenchLink: ["payload"] },
    },
  } as const;
  if (mode === "direct") {
    await Promise.all(
      rootIds.map((rootId) => store.subgraph(rootId, queryOptions)),
    );
    return;
  }
  await store.batchOnce(
    (read) => rootIds.map((rootId) => read.subgraph(rootId, queryOptions)),
    { shareSubgraphs: mode === "batchOnceShared" },
  );
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ?
      (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const resources = await createBackendResources(
    options.backend,
    options.postgresDriver,
  );
  const counters: Counters = {
    statements: 0,
    backendExecuteMs: 0,
    transferredRows: 0,
    transferredBytes: 0,
    simulatedDelayMsApplied: 0,
  };
  const backend = instrumentBackend(
    resources.backend,
    counters,
    options.simulatedRoundtripMs,
  );
  const store = createStore(benchmarkGraph, backend, {
    queryDefaults: { traversalExpansion: "none" },
  });
  try {
    const rootIds = await seed(store, options);
    const results: Record<Mode, Sample[]> = {
      direct: [],
      batchOnceUnfused: [],
      batchOnceShared: [],
    };
    for (const mode of [
      "direct",
      "batchOnceUnfused",
      "batchOnceShared",
    ] as const) {
      for (
        let index = 0;
        index < options.warmup + options.iterations;
        index += 1
      ) {
        Object.assign(counters, {
          statements: 0,
          backendExecuteMs: 0,
          transferredRows: 0,
          transferredBytes: 0,
          simulatedDelayMsApplied: 0,
        });
        const heapBefore = process.memoryUsage().heapUsed;
        const started = performance.now();
        await executeMode(mode, store, rootIds, options);
        const sample = {
          ...counters,
          totalMs: performance.now() - started,
          heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
        };
        if (index >= options.warmup) results[mode].push(sample);
      }
    }
    const output = Object.fromEntries(
      Object.entries(results).map(([mode, samples]) => [
        mode,
        {
          medianTotalMs: median(samples.map((sample) => sample.totalMs)),
          medianBackendExecuteMs: median(
            samples.map((sample) => sample.backendExecuteMs),
          ),
          medianStatements: median(samples.map((sample) => sample.statements)),
          medianTransferredRows: median(
            samples.map((sample) => sample.transferredRows),
          ),
          medianTransferredBytes: median(
            samples.map((sample) => sample.transferredBytes),
          ),
          medianHeapDeltaBytes: median(
            samples.map((sample) => sample.heapDeltaBytes),
          ),
          medianSimulatedDelayMsApplied: median(
            samples.map((sample) => sample.simulatedDelayMsApplied),
          ),
        },
      ]),
    );
    console.log(
      JSON.stringify(
        {
          configuration: options,
          modes: {
            direct: "independent subgraph() executions issued concurrently",
            batchOnceUnfused:
              "default one-statement batch with independent subgraph plans",
            batchOnceShared:
              "opt-in batchOnce({ shareSubgraphs: true }) production path",
          },
          metrics: output,
          observability: {
            backendExecuteMs:
              "sum of client-observed backend.execute durations; excludes configured simulated delay and can exceed total wall time when direct calls overlap",
            transferredRows: "raw rows returned across backend.execute calls",
            transferredBytes: "UTF-8 bytes of JSON-encoded raw returned rows",
            heapDeltaBytes:
              "process heap delta without forced GC; noisy and not retained-memory measurement",
            serverExecutionTime: "unobservable through GraphBackend",
            networkWireBytes: "unobservable through GraphBackend",
          },
        },
        undefined,
        2,
      ),
    );
  } finally {
    await resources.close();
  }
}

await main();
