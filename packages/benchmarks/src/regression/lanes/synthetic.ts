import { type RegressionLane } from "../lanes";

const RECALL_SEMANTICS = {
  direction: "higher-is-better",
  minAbsoluteDelta: 0.01,
  unit: "recall",
} as const;

/**
 * Regression lanes backed by the existing synthetic social-graph benchmark
 * suites (`src/main.ts`, `src/write-bench.ts`, `src/identity-bench.ts`,
 * `src/vector-bench.ts`). All four append to `reports/history.jsonl`.
 */
export const SYNTHETIC_LANES: readonly RegressionLane[] = [
  {
    id: "perf",
    description:
      "Synthetic social-graph query suite (traversals, aggregates, vector/hybrid search).",
    scripts: { sqlite: "perf", postgres: "perf:postgres" },
  },
  {
    id: "write",
    description: "Write-path latency per operation shape.",
    scripts: { sqlite: "bench:write", postgres: "bench:write:postgres" },
  },
  {
    id: "identity",
    description:
      "Operational-identity claim/assert/traversal latency (folding, closures, enablement scans).",
    scripts: { sqlite: "bench:identity", postgres: "bench:identity:postgres" },
  },
  {
    id: "vector",
    description: "Vector/ANN search latency and recall.",
    scripts: { sqlite: "bench:vector", postgres: "bench:vector:postgres" },
    requires: ["sqlite-vec"],
    measurementSemantics: {
      "vector:ann-recall": RECALL_SEMANTICS,
      "vector:ann-filtered-recall": RECALL_SEMANTICS,
      "vector:exact-postindex-recall": RECALL_SEMANTICS,
      "vector:exact-filtered-postindex-recall": RECALL_SEMANTICS,
    },
  },
  {
    id: "identity-frontier",
    description:
      "typegraph#396-shape current-coordinate identity-expanded hop, bounded fixture.",
    scripts: {
      sqlite: "bench:identity-frontier",
      postgres: "bench:identity-frontier:postgres",
    },
  },
];
