export const BENCHMARK_CONFIG = {
  userCount: 1200,
  followsPerUser: 10,
  postsPerUser: 5,
  batchSize: 250,
  warmupIterations: 2,
  sampleIterations: 15,
} as const;

const BASE_GUARDRAILS = {
  reverseToForwardRatioMax: 6,
  inverseTraversalMsMax: 500,
  inverseToForwardRatioMax: 10,
  threeHopMsMax: 500,
  threeHopToTwoHopRatioMax: 8,
  aggregateMsMax: 500,
  aggregateDistinctMsMax: 700,
  aggregateDistinctToAggregateRatioMax: 4,
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
    aggregateDistinctMsMax: 1200,
    preparedExecuteMsMax: 700,
  },
} as const;

export const DEFAULT_POSTGRES_URL =
  "postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test";

export type PerfBackend = "sqlite" | "postgres";

export type PerfCliOptions = Readonly<{
  runChecks: boolean;
  backend: PerfBackend;
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
  cachedExecuteMs: number;
  preparedExecuteMs: number;
  tenHopMs: number;
  recursiveHundredHopMs: number;
  recursiveThousandHopMs: number;
}>;

export type UserSeed = Readonly<{
  id: string;
  name: string;
  city: string;
}>;

export type PostSeed = Readonly<{
  id: string;
  authorId: string;
  title: string;
}>;

export type FollowSeed = Readonly<{
  fromId: string;
  toId: string;
}>;

export type NextSeed = Readonly<{
  fromId: string;
  toId: string;
}>;
