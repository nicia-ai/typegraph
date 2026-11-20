/**
 * Builds the fixed request sequence every engine executes for a given IS
 * query. Generating the sample ids ONCE (not per engine) and replaying the
 * identical sequence against each engine is what makes per-request parity
 * comparison — row count and value digest alike (see harness/parity.ts) —
 * meaningful: every engine sees the same person/message id at request
 * index N.
 */
import { type SnbIdPools } from "./dataset/ldbc-csv";
import { type MessageRef, type PersonPair } from "./engines/types";

/** xorshift32 PRNG, matching packages/benchmarks/src/seed.ts's generator. */
function createRng(seed_: number): () => number {
  let seed = seed_;
  return function next(): number {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4_294_967_295;
  };
}

function pick<T>(pool: readonly T[], random: () => number): T {
  if (pool.length === 0) {
    throw new Error("Cannot sample from an empty id pool.");
  }
  const index = Math.floor(random() * pool.length) % pool.length;
  return pool[index]!;
}

export type SnbRequestPlan = Readonly<{
  IS1: readonly string[];
  IS2: readonly string[];
  IS3: readonly string[];
  IS4: readonly MessageRef[];
  IS5: readonly MessageRef[];
  IS6: readonly MessageRef[];
  IS7: readonly MessageRef[];
  IC13: readonly PersonPair[];
  IC14: readonly PersonPair[];
  BFS3: readonly string[];
  IC2: readonly string[];
  IC8: readonly string[];
  IC9: readonly string[];
  GA_DEGREE: readonly string[];
  GA_WCC: readonly string[];
  GA_BFS: readonly string[];
  GA_SSSP: readonly string[];
}>;

export type BuildRequestPlanOptions = Readonly<{
  pools: SnbIdPools;
  /** Total requests per query (warmups + measured samples). */
  requestCount: number;
  seed?: number;
}>;

export function buildRequestPlan(
  options: BuildRequestPlanOptions,
): SnbRequestPlan {
  const { pools, requestCount } = options;
  const random = createRng(options.seed ?? 42);
  const messages: readonly MessageRef[] = [
    ...pools.posts.map((id) => ({ id, kind: "Post" as const })),
    ...pools.comments.map((id) => ({ id, kind: "Comment" as const })),
  ];

  const personRequests = (): readonly string[] =>
    Array.from({ length: requestCount }, () => pick(pools.persons, random));
  const messageRequests = (): readonly MessageRef[] =>
    Array.from({ length: requestCount }, () => pick(messages, random));
  // IC13's distance is only meaningful for two *different* persons (a
  // person's distance to itself is trivially 0), so each pair re-rolls its
  // target until it differs from the source. With more than one person in
  // the pool this terminates immediately in practice; the length guard keeps
  // a degenerate single-person pool from looping forever.
  const pairRequests = (): readonly PersonPair[] =>
    Array.from({ length: requestCount }, () => {
      const sourceId = pick(pools.persons, random);
      let targetId = pick(pools.persons, random);
      while (targetId === sourceId && pools.persons.length > 1) {
        targetId = pick(pools.persons, random);
      }
      return { sourceId, targetId };
    });

  return {
    IS1: personRequests(),
    IS2: personRequests(),
    IS3: personRequests(),
    IS4: messageRequests(),
    IS5: messageRequests(),
    IS6: messageRequests(),
    IS7: messageRequests(),
    IC13: pairRequests(),
    IC14: pairRequests(),
    BFS3: personRequests(),
    IC2: personRequests(),
    IC8: personRequests(),
    IC9: personRequests(),
    GA_DEGREE: personRequests(),
    GA_WCC: personRequests(),
    GA_BFS: personRequests(),
    GA_SSSP: personRequests(),
  };
}
