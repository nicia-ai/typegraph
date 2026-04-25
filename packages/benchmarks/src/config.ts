const BASE_BENCHMARK_CONFIG = {
  userCount: 1200,
  followsPerUser: 10,
  postsPerUser: 5,
  userBioBytes: 1024,
  postBodyBytes: 4096,
  batchSize: 250,
  warmupIterations: 2,
  sampleIterations: 15,
} as const;

/**
 * Active benchmark configuration.
 *
 * Mutable because `--scale=N` scales `userCount` at startup. All other
 * values are stable so per-user/per-post density doesn't drift with scale.
 */
export const BENCHMARK_CONFIG: {
  userCount: number;
  readonly followsPerUser: number;
  readonly postsPerUser: number;
  readonly userBioBytes: number;
  readonly postBodyBytes: number;
  readonly batchSize: number;
  readonly warmupIterations: number;
  readonly sampleIterations: number;
} = { ...BASE_BENCHMARK_CONFIG };

/**
 * Minimum scale supported by the benchmark. Smaller values would reduce
 * the graph below the 1000-hop recursive benchmark's required chain
 * length, causing those measurements to silently return empty results.
 * Tighten the recursive shapes and drop this if you need sub-1× scales.
 */
const MIN_SCALE = 1;

export function applyScale(scale: number): void {
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(
      `Invalid --scale value: ${scale}. Must be a positive number.`,
    );
  }
  if (scale < MIN_SCALE) {
    throw new Error(
      `--scale=${scale} would shrink the graph below the 1000-hop recursive ` +
        `benchmark's required chain length (1001 users). Minimum supported ` +
        `scale is ${MIN_SCALE}.`,
    );
  }
  BENCHMARK_CONFIG.userCount = Math.round(
    BASE_BENCHMARK_CONFIG.userCount * scale,
  );
}

const BASE_GUARDRAILS = {
  reverseToForwardRatioMax: 6,
  inverseTraversalMsMax: 500,
  inverseToForwardRatioMax: 10,
  threeHopMsMax: 500,
  threeHopToTwoHopRatioMax: 8,
  aggregateMsMax: 100,
  aggregateDistinctMsMax: 100,
  aggregateDistinctToAggregateRatioMax: 4,
  aggregateEdgesMsMax: 50,
  scopedAggregateMsMax: 50,
  indexedFilterMsMax: 50,
  temporalAsOfMsMax: 50,
  fulltextSearchMsMax: 100,
  vectorSearchMsMax: 200,
  hybridSearchMsMax: 300,
  cachedExecuteMsMax: 500,
  preparedExecuteMsMax: 500,
  preparedToCachedRatioMax: 2,
  tenHopMsMax: 250,
  recursiveHundredHopMsMax: 1000,
  recursiveHundredToTenHopRatioMax: 30,
  recursiveThousandHopMsMax: 5000,
  recursiveThousandToHundredRatioMax: 20,
} as const;

const BACKEND_GUARDRAIL_OVERRIDES = {
  sqlite: {
    // CI shared runners can be notably slower for deep recursive CTE scans.
    recursiveThousandHopMsMax: 7000,
  },
  postgres: {
    // PostgreSQL join planning/execution is slower than SQLite for this shape.
    threeHopMsMax: 1000,
    inverseTraversalMsMax: 1000,
    inverseToForwardRatioMax: 30,
    aggregateMsMax: 300,
    aggregateDistinctMsMax: 300,
    aggregateEdgesMsMax: 200,
    scopedAggregateMsMax: 200,
    indexedFilterMsMax: 200,
    temporalAsOfMsMax: 200,
    fulltextSearchMsMax: 300,
    vectorSearchMsMax: 500,
    hybridSearchMsMax: 800,
    preparedExecuteMsMax: 700,
  },
} as const;

export const DEFAULT_POSTGRES_URL =
  "postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test";

export type PerfBackend = "sqlite" | "postgres";

export type PerfCliOptions = Readonly<{
  runChecks: boolean;
  backend: PerfBackend;
  scale: number;
}>;

export type Guardrails = Readonly<{
  reverseToForwardRatioMax: number;
  inverseTraversalMsMax: number;
  inverseToForwardRatioMax: number;
  threeHopMsMax: number;
  threeHopToTwoHopRatioMax: number;
  aggregateMsMax: number;
  aggregateDistinctMsMax: number;
  aggregateDistinctToAggregateRatioMax: number;
  aggregateEdgesMsMax: number;
  scopedAggregateMsMax: number;
  indexedFilterMsMax: number;
  temporalAsOfMsMax: number;
  fulltextSearchMsMax: number;
  vectorSearchMsMax: number;
  hybridSearchMsMax: number;
  cachedExecuteMsMax: number;
  preparedExecuteMsMax: number;
  preparedToCachedRatioMax: number;
  tenHopMsMax: number;
  recursiveHundredHopMsMax: number;
  recursiveHundredToTenHopRatioMax: number;
  recursiveThousandHopMsMax: number;
  recursiveThousandToHundredRatioMax: number;
}>;

export function getGuardrails(backend: PerfBackend): Guardrails {
  return {
    ...BASE_GUARDRAILS,
    ...BACKEND_GUARDRAIL_OVERRIDES[backend],
  };
}

export type GuardrailViolation = Readonly<{
  label: string;
  actual: number;
  expectedMax: number;
}>;

export type QueryMetrics = Readonly<{
  forwardMs: number;
  reverseMs: number;
  inverseTraversalMs: number;
  twoHopMs: number;
  threeHopMs: number;
  aggregateMs: number;
  aggregateDistinctMs: number;
  aggregateEdgesMs: number;
  scopedAggregateMs: number;
  indexedFilterMs: number;
  temporalAsOfMs: number;
  fulltextSearchMs: number;
  /** `undefined` when vector search is unavailable at this backend. */
  vectorSearchMs: number | undefined;
  /** `undefined` when vector search is unavailable at this backend. */
  hybridSearchMs: number | undefined;
  cachedExecuteMs: number;
  preparedExecuteMs: number;
  subgraphFullMs: number;
  subgraphApplicationProjectionMs: number;
  subgraphSqlProjectionMs: number;
  subgraphStressFullMs: number;
  subgraphStressApplicationProjectionMs: number;
  subgraphStressSqlProjectionMs: number;
  tenHopMs: number;
  recursiveHundredHopMs: number;
  recursiveThousandHopMs: number;
}>;

export type UserSeed = Readonly<{
  id: string;
  name: string;
  city: string;
  bio: string;
}>;

export type PostSeed = Readonly<{
  id: string;
  authorId: string;
  title: string;
  body: string;
}>;

export type FollowSeed = Readonly<{
  fromId: string;
  toId: string;
}>;

export type NextSeed = Readonly<{
  fromId: string;
  toId: string;
}>;
