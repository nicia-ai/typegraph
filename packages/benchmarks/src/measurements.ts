import {
  count,
  countDistinct,
  countEdges,
  field,
  param,
} from "@nicia-ai/typegraph";

import { BENCHMARK_CONFIG, type QueryMetrics } from "./config";
import { type PerfStore } from "./graph";
import { TEMPORAL_ARCHIVE_ASOF } from "./seed";
import { formatMs, median, nowMs, percentile } from "./utils";

export type LatencySample = Readonly<{
  median: number;
  p95: number;
  samples: readonly number[];
}>;

export type LatencyRecord = Map<string, LatencySample>;

type SubgraphNode = Readonly<{ kind: string; id: string }>;
type SubgraphEdge = Readonly<{ id: string; fromId: string; toId: string }>;

type FullSubgraphResult = Readonly<{
  nodes: ReadonlyMap<
    string,
    | Readonly<{
        kind: "User";
        id: string;
        name: string;
        city: string;
        bio: string;
      }>
    | Readonly<{
        kind: "Post";
        id: string;
        title: string;
        body: string;
      }>
  >;
  adjacency: ReadonlyMap<string, ReadonlyMap<string, readonly SubgraphEdge[]>>;
}>;

type ProjectedSubgraphResult = Readonly<{
  nodes: ReadonlyMap<
    string,
    | Readonly<{ kind: "User"; id: string; name: string }>
    | Readonly<{ kind: "Post"; id: string; title: string }>
  >;
  adjacency: ReadonlyMap<string, ReadonlyMap<string, readonly SubgraphEdge[]>>;
}>;

type BenchmarkSubgraphOptions = Readonly<{
  edges: readonly ("follows" | "authored")[];
  maxDepth: number;
  includeKinds: readonly ("User" | "Post")[];
}>;

const SUBGRAPH_BASELINE_OPTIONS = {
  edges: ["follows", "authored"],
  maxDepth: 2,
  includeKinds: ["User", "Post"],
} as const satisfies BenchmarkSubgraphOptions;

const SUBGRAPH_STRESS_OPTIONS = {
  edges: ["follows", "authored"],
  maxDepth: 3,
  includeKinds: ["User", "Post"],
} as const satisfies BenchmarkSubgraphOptions;

async function benchmarkQuery(
  label: string,
  fn: () => Promise<void>,
  record: LatencyRecord,
): Promise<number> {
  for (
    let iteration = 0;
    iteration < BENCHMARK_CONFIG.warmupIterations;
    iteration += 1
  ) {
    await fn();
  }

  const samples: number[] = [];
  for (
    let iteration = 0;
    iteration < BENCHMARK_CONFIG.sampleIterations;
    iteration += 1
  ) {
    const startedAt = nowMs();
    await fn();
    samples.push(nowMs() - startedAt);
  }

  const medianResult = median(samples);
  const p95Result = percentile(samples, 0.95);
  record.set(label, { median: medianResult, p95: p95Result, samples });
  console.log(
    `${label}: ${formatMs(medianResult)} (p95 ${formatMs(p95Result)})`,
  );
  return medianResult;
}

function sumEdgeChecksum(
  adjacency: ReadonlyMap<string, ReadonlyMap<string, readonly SubgraphEdge[]>>,
): number {
  let checksum = 0;
  for (const kindMap of adjacency.values()) {
    for (const edges of kindMap.values()) {
      for (const edge of edges) {
        checksum += edge.id.length + edge.fromId.length + edge.toId.length;
      }
    }
  }
  return checksum;
}

function consumeSubgraphCounts(
  result: Readonly<{
    nodes: ReadonlyMap<string, SubgraphNode>;
    adjacency: ReadonlyMap<
      string,
      ReadonlyMap<string, readonly SubgraphEdge[]>
    >;
  }>,
): number {
  let checksum = 0;

  for (const node of result.nodes.values()) {
    checksum += node.id.length + node.kind.length;
  }

  checksum += sumEdgeChecksum(result.adjacency);
  return checksum;
}

function projectSubgraphInApplication(result: FullSubgraphResult): number {
  let checksum = 0;

  for (const node of result.nodes.values()) {
    if (node.kind === "User") {
      checksum += node.id.length + node.name.length;
      continue;
    }

    if (node.kind === "Post") {
      checksum += node.id.length + node.title.length;
    }
  }

  checksum += sumEdgeChecksum(result.adjacency);
  return checksum;
}

function consumeProjectedSubgraph(result: ProjectedSubgraphResult): number {
  let checksum = 0;

  for (const node of result.nodes.values()) {
    if (node.kind === "User") {
      checksum += node.id.length + node.name.length;
      continue;
    }

    checksum += node.id.length + node.title.length;
  }

  checksum += sumEdgeChecksum(result.adjacency);
  return checksum;
}

function assertNonEmptyChecksum(label: string, checksum: number): void {
  if (checksum <= 0) {
    throw new Error(`${label} produced an empty checksum`);
  }
}

async function logSubgraphShape(
  store: PerfStore,
  label: string,
  options: BenchmarkSubgraphOptions,
): Promise<void> {
  const result = await store.subgraph("user_0" as never, options);
  let edgeCount = 0;
  for (const kindMap of result.adjacency.values()) {
    for (const edges of kindMap.values()) {
      edgeCount += edges.length;
    }
  }
  console.log(`${label}: ${result.nodes.size} nodes, ${edgeCount} edges`);
}

type MeasurementContext = Readonly<{
  hasVectorPredicate: boolean;
  hasHybridFacade: boolean;
  docs: readonly { id: string; embedding: readonly number[] }[] | undefined;
}>;

export async function measureQueries(
  store: PerfStore,
  context: MeasurementContext,
): Promise<{ metrics: QueryMetrics; latencies: LatencyRecord }> {
  const latencies: LatencyRecord = new Map();
  const bench = (label: string, fn: () => Promise<void>): Promise<number> =>
    benchmarkQuery(label, fn, latencies);
  const cachedExecuteQuery = store
    .query()
    .from("User", "u")
    .whereNode("u", (user) => user.id.eq("user_0"))
    .traverse("follows", "e", { expand: "none" })
    .to("User", "friend")
    .select((context) => ({ friendName: context.friend.name }));

  const preparedExecuteQuery = store
    .query()
    .from("User", "u")
    .whereNode("u", (user) => user.id.eq(param("userId")))
    .traverse("follows", "e", { expand: "none" })
    .to("User", "friend")
    .select((context) => ({ friendName: context.friend.name }))
    .prepare();

  // Every User in the seed has exactly followsPerUser (10) outgoing
  // follows, so user_0's forward-traversal cardinality is an invariant.
  const expectedForwardCount = BENCHMARK_CONFIG.followsPerUser;
  const forwardMs = await bench("forward traversal", async () => {
    const rows = await store
      .query()
      .from("User", "u")
      .whereNode("u", (user) => user.id.eq("user_0"))
      .traverse("follows", "e", { expand: "none" })
      .to("User", "friend")
      .select((context) => ({ friendName: context.friend.name }))
      .execute();
    if (rows.length !== expectedForwardCount) {
      throw new Error(
        `forward traversal drift: expected ${expectedForwardCount} rows, got ${rows.length}`,
      );
    }
  });

  const cachedExecuteMs = await bench(
    "cached execute (same query instance)",
    async () => {
      const rows = await cachedExecuteQuery.execute();
      if (rows.length !== expectedForwardCount) {
        throw new Error(
          `cached execute drift: expected ${expectedForwardCount} rows, got ${rows.length}`,
        );
      }
    },
  );

  const preparedExecuteMs = await bench("prepared execute", async () => {
    const rows = await preparedExecuteQuery.execute({ userId: "user_0" });
    if (rows.length !== expectedForwardCount) {
      throw new Error(
        `prepared execute drift: expected ${expectedForwardCount} rows, got ${rows.length}`,
      );
    }
  });

  await logSubgraphShape(
    store,
    "subgraph baseline shape (wide payload, depth 2)",
    SUBGRAPH_BASELINE_OPTIONS,
  );

  const subgraphFullMs = await bench(
    "subgraph full hydration (wide payload, depth 2)",
    async () => {
      const result = await store.subgraph(
        "user_0" as never,
        SUBGRAPH_BASELINE_OPTIONS,
      );

      assertNonEmptyChecksum(
        "subgraph full hydration",
        consumeSubgraphCounts(result),
      );
    },
  );

  const subgraphApplicationProjectionMs = await bench(
    "subgraph full hydration + app projection (wide payload, depth 2)",
    async () => {
      const result = await store.subgraph(
        "user_0" as never,
        SUBGRAPH_BASELINE_OPTIONS,
      );

      assertNonEmptyChecksum(
        "subgraph app projection",
        projectSubgraphInApplication(result),
      );
    },
  );

  const subgraphSqlProjectionMs = await bench(
    "subgraph SQL projection (wide payload, depth 2)",
    async () => {
      const result = await store.subgraph("user_0" as never, {
        ...SUBGRAPH_BASELINE_OPTIONS,
        project: {
          nodes: {
            User: ["name"],
            Post: ["title"],
          },
          edges: {
            follows: [],
            authored: [],
          },
        },
      });

      assertNonEmptyChecksum(
        "subgraph SQL projection",
        consumeProjectedSubgraph(result),
      );
    },
  );

  await logSubgraphShape(
    store,
    "subgraph stress shape (wide payload, depth 3)",
    SUBGRAPH_STRESS_OPTIONS,
  );

  const subgraphStressFullMs = await bench(
    "subgraph full hydration (wide payload, depth 3 stress)",
    async () => {
      const result = await store.subgraph(
        "user_0" as never,
        SUBGRAPH_STRESS_OPTIONS,
      );

      assertNonEmptyChecksum(
        "subgraph stress full hydration",
        consumeSubgraphCounts(result),
      );
    },
  );

  const subgraphStressApplicationProjectionMs = await bench(
    "subgraph full hydration + app projection (wide payload, depth 3 stress)",
    async () => {
      const result = await store.subgraph(
        "user_0" as never,
        SUBGRAPH_STRESS_OPTIONS,
      );

      assertNonEmptyChecksum(
        "subgraph stress app projection",
        projectSubgraphInApplication(result),
      );
    },
  );

  const subgraphStressSqlProjectionMs = await bench(
    "subgraph SQL projection (wide payload, depth 3 stress)",
    async () => {
      const result = await store.subgraph("user_0" as never, {
        ...SUBGRAPH_STRESS_OPTIONS,
        project: {
          nodes: {
            User: ["name"],
            Post: ["title"],
          },
          edges: {
            follows: [],
            authored: [],
          },
        },
      });

      assertNonEmptyChecksum(
        "subgraph stress SQL projection",
        consumeProjectedSubgraph(result),
      );
    },
  );

  // Reverse follow counts depend on the seeded random follow graph and
  // can vary per-user. Pin it to a non-empty result to catch empty-plan
  // regressions without baking in a brittle exact count.
  const reverseMs = await bench("reverse traversal", async () => {
    const rows = await store
      .query()
      .from("User", "follower")
      .traverse("follows", "e", { expand: "none" })
      .to("User", "target")
      .whereNode("target", (target) => target.id.eq("user_0"))
      .select((context) => ({ followerName: context.follower.name }))
      .execute();
    if (rows.length === 0) {
      throw new Error("reverse traversal drift: expected non-empty result set");
    }
  });

  // user_600 sits in the middle of the :next chain, so inverse expansion
  // (follow + its inverse) should return the two neighbors (user_599, user_601).
  const inverseTraversalMs = await bench(
    "inverse traversal (expand: inverse)",
    async () => {
      const rows = await store
        .query()
        .from("User", "u")
        .whereNode("u", (user) => user.id.eq("user_600"))
        .traverse("next", "e", { expand: "inverse" })
        .to("User", "neighbor")
        .select((context) => ({ neighborId: context.neighbor.id }))
        .limit(20)
        .execute();
      if (rows.length !== 2) {
        throw new Error(
          `inverse traversal drift: expected 2 neighbors, got ${rows.length}`,
        );
      }
    },
  );

  // LIMIT 50 over follows * authored should saturate — every user has
  // followsPerUser (10) follows and postsPerUser (5) posts each.
  const twoHopMs = await bench("2-hop traversal", async () => {
    const rows = await store
      .query()
      .from("User", "u")
      .whereNode("u", (user) => user.id.eq("user_0"))
      .traverse("follows", "e1", { expand: "none" })
      .to("User", "friend")
      .traverse("authored", "e2", { expand: "none" })
      .to("Post", "post")
      .select((context) => ({
        friendName: context.friend.name,
        title: context.post.title,
      }))
      .limit(50)
      .execute();
    if (rows.length !== 50) {
      throw new Error(
        `2-hop drift: expected 50 rows (limit), got ${rows.length}`,
      );
    }
  });

  const threeHopMs = await bench("3-hop traversal", async () => {
    const rows = await store
      .query()
      .from("User", "u")
      .whereNode("u", (user) => user.id.eq("user_500"))
      .traverse("follows", "e1", { expand: "none" })
      .to("User", "f1")
      .traverse("follows", "e2", { expand: "none" })
      .to("User", "f2")
      .traverse("authored", "e3", { expand: "none" })
      .to("Post", "post")
      .select((context) => ({
        f1Name: context.f1.name,
        f2Name: context.f2.name,
        title: context.post.title,
      }))
      .limit(20)
      .execute();
    if (rows.length !== 20) {
      throw new Error(
        `3-hop drift: expected 20 rows (limit), got ${rows.length}`,
      );
    }
  });

  // Full-graph aggregate: COUNT follows per user across every user. This
  // is the worst case for graph-over-SQL backends because the GROUP BY
  // runs over the full start set. Intentionally has NO `.limit()` so the
  // measurement reflects the claimed 1,200-group GROUP BY rather than
  // 20-row LIMIT push-down.
  const aggregateMs = await bench("aggregate follow count", async () => {
    const rows = await store
      .query()
      .from("User", "u")
      .optionalTraverse("follows", "e", { expand: "none" })
      .to("User", "target")
      .groupByNode("u")
      .aggregate({
        name: field("u", "name"),
        followCount: count("target"),
      })
      .execute();
    if (rows.length !== BENCHMARK_CONFIG.userCount) {
      throw new Error(
        `aggregate cardinality drift: expected ${BENCHMARK_CONFIG.userCount} rows, got ${rows.length}`,
      );
    }
  });

  const aggregateDistinctMs = await bench(
    "aggregate distinct follow count",
    async () => {
      const rows = await store
        .query()
        .from("User", "u")
        .optionalTraverse("follows", "e", { expand: "none" })
        .to("User", "target")
        .groupByNode("u")
        .aggregate({
          name: field("u", "name"),
          followCount: countDistinct("target"),
        })
        .execute();
      if (rows.length !== BENCHMARK_CONFIG.userCount) {
        throw new Error(
          `aggregate distinct cardinality drift: expected ${BENCHMARK_CONFIG.userCount} rows, got ${rows.length}`,
        );
      }
    },
  );

  // countEdges variant — counts live edges directly without joining to the
  // target node table. Same graph-level semantics as the `aggregate follow
  // count` shape above in a graph where no target nodes are validTo-expired
  // (the benchmark seed only expires archived User rows that have no
  // incident edges). This benchmark isolates the cost of the target-node
  // join from the GROUP BY work.
  const aggregateEdgesMs = await bench(
    "aggregate follow count (countEdges)",
    async () => {
      const rows = await store
        .query()
        .from("User", "u")
        .optionalTraverse("follows", "e", { expand: "none" })
        .to("User", "target")
        .groupByNode("u")
        .aggregate({
          name: field("u", "name"),
          followCount: countEdges("e"),
        })
        .execute();
      if (rows.length !== BENCHMARK_CONFIG.userCount) {
        throw new Error(
          `aggregate edges cardinality drift: expected ${BENCHMARK_CONFIG.userCount} rows, got ${rows.length}`,
        );
      }
    },
  );

  // Scoped aggregate: "how many people does user_0 follow?" — the typical
  // OLTP shape (count relative to a filtered starting point). Contrasts with
  // the unscoped aggregate above which groups across every user.
  const scopedAggregateMs = await bench(
    "scoped aggregate (follow count for single user)",
    async () => {
      const rows = await store
        .query()
        .from("User", "u")
        .whereNode("u", (user) => user.id.eq("user_0"))
        .optionalTraverse("follows", "e", { expand: "none" })
        .to("User", "target")
        .groupByNode("u")
        .aggregate({
          name: field("u", "name"),
          followCount: count("target"),
        })
        .execute();
      if (
        rows.length !== 1 ||
        rows[0]!.followCount !== BENCHMARK_CONFIG.followsPerUser
      ) {
        throw new Error(
          `scoped aggregate drift: expected 1 row with followCount=${BENCHMARK_CONFIG.followsPerUser}, got ${JSON.stringify(rows)}`,
        );
      }
    },
  );

  // Indexed property filter: exercises the expression index defined in
  // graph.ts (`userCityIndex` covers `city` with `name`). Smart select
  // picks up only the indexed fields, so with a properly configured
  // covering index the query is satisfied index-only. Regressions here
  // catch breakage in smart-select or the indexes pipeline.
  //
  // Seed splits users 1/3 San Francisco, 2/3 New York; LIMIT 100 saturates
  // because there are ~400 San Francisco users in the default scale.
  const indexedFilterMs = await bench(
    "indexed filter (User.city with covering name)",
    async () => {
      const rows = await store
        .query()
        .from("User", "u")
        .whereNode("u", (user) => user.city.eq("San Francisco"))
        .select((context) => ({
          id: context.u.id,
          name: context.u.name,
        }))
        .limit(100)
        .execute();
      if (rows.length !== 100) {
        throw new Error(
          `indexed filter drift: expected 100 rows (limit), got ${rows.length}`,
        );
      }
    },
  );

  // Temporal `asOf` query: the seed creates an "archived" cohort of users
  // whose validFrom/validTo bracket a past timestamp. Querying at that
  // timestamp should surface them (they don't appear in `current`). This
  // exercises the temporal filter compilation and is a regression canary
  // for the asOf code path.
  const expectedArchivedCount = Math.max(
    50,
    Math.round(BENCHMARK_CONFIG.userCount * 0.1),
  );
  const temporalAsOfMs = await bench(
    "temporal asOf (archived user cohort)",
    async () => {
      const rows = await store
        .query()
        .from("User", "u")
        .temporal("asOf", TEMPORAL_ARCHIVE_ASOF)
        .whereNode("u", (user) => user.city.eq("Boston"))
        .select((context) => ({
          id: context.u.id,
          name: context.u.name,
        }))
        .limit(expectedArchivedCount + 50)
        .execute();
      if (rows.length !== expectedArchivedCount) {
        throw new Error(
          `temporal asOf drift: expected ${expectedArchivedCount} archived rows, got ${rows.length}`,
        );
      }
    },
  );

  // Fulltext match: BM25-ranked search over the seeded Doc bodies. SQLite
  // FTS5 is native; Postgres uses tsvector + GIN. Works regardless of
  // vector extension availability.
  const fulltextSearchMs = await bench(
    "fulltext search (Doc body match)",
    async () => {
      const rows = await store
        .query()
        .from("Doc", "d")
        .whereNode("d", (doc) =>
          doc.$fulltext.matches("climate adaptation", 20),
        )
        .select((ctx) => ({
          id: ctx.d.id,
          title: ctx.d.title,
        }))
        .execute();
      if (rows.length === 0) {
        throw new Error("fulltext search drift: expected non-empty result set");
      }
    },
  );

  const sampleEmbedding = context.docs?.[0]?.embedding;

  const vectorSearchMs =
    context.hasVectorPredicate && sampleEmbedding !== undefined ?
      await bench("vector search (Doc cosine top-20)", async () => {
        const rows = await store
          .query()
          .from("Doc", "d")
          .whereNode("d", (doc) =>
            doc.embedding.similarTo(sampleEmbedding, 20, {
              metric: "cosine",
            }),
          )
          .select((ctx) => ({
            id: ctx.d.id,
            title: ctx.d.title,
          }))
          .execute();
        if (rows.length !== 20) {
          throw new Error(
            `vector search drift: expected 20 rows (top-k), got ${rows.length}`,
          );
        }
      })
    : undefined;

  const hybridSearchMs =
    context.hasHybridFacade && sampleEmbedding !== undefined ?
      await bench("hybrid search (RRF)", async () => {
        const hits = await store.search.hybrid("Doc", {
          limit: 10,
          vector: {
            fieldPath: "embedding",
            queryEmbedding: sampleEmbedding,
            metric: "cosine",
            k: 30,
          },
          fulltext: {
            query: "climate adaptation",
            k: 30,
          },
        });
        if (hits.length !== 10) {
          throw new Error(
            `hybrid search drift: expected 10 fused hits (limit), got ${hits.length}`,
          );
        }
      })
    : undefined;

  if (!context.hasVectorPredicate) {
    console.log("vector search: skipped (backend does not persist embeddings)");
  }
  if (!context.hasHybridFacade) {
    console.log(
      "hybrid search: skipped (backend does not implement hybrid facade)",
    );
  }

  // Recursive traversals walk the :next linear chain (user_0 -> user_1 -> ...).
  // At depth N, the single reachable target is user_N. Asserting the target
  // ID catches both empty-result regressions and off-by-one depth bugs.
  async function assertRecursiveHit(
    label: string,
    rows: readonly { id: string }[],
    expectedDepth: number,
  ): Promise<void> {
    if (rows.length !== 1) {
      throw new Error(
        `${label} drift: expected 1 row at depth ${expectedDepth}, got ${rows.length}`,
      );
    }
    if (rows[0]!.id !== `user_${expectedDepth}`) {
      throw new Error(
        `${label} drift: expected target user_${expectedDepth}, got ${rows[0]!.id}`,
      );
    }
  }

  const tenHopMs = await bench(
    "10-hop recursive traversal (linear next edges, cyclePolicy: allow)",
    async () => {
      const rows = await store
        .query()
        .from("User", "u")
        .whereNode("u", (user) => user.id.eq("user_0"))
        .traverse("next", "e", { expand: "none" })
        .recursive({ cyclePolicy: "allow", minHops: 10, maxHops: 10 })
        .to("User", "target")
        .select((context) => ({
          id: context.target.id,
          name: context.target.name,
        }))
        .limit(1)
        .execute();
      await assertRecursiveHit("10-hop recursive", rows, 10);
    },
  );

  const recursiveHundredHopMs = await bench(
    "100-hop recursive traversal (linear next edges, cyclePolicy: allow)",
    async () => {
      const rows = await store
        .query()
        .from("User", "u")
        .whereNode("u", (user) => user.id.eq("user_0"))
        .traverse("next", "e", { expand: "none" })
        .recursive({ cyclePolicy: "allow", minHops: 100, maxHops: 100 })
        .to("User", "target")
        .select((context) => ({
          id: context.target.id,
        }))
        .limit(1)
        .execute();
      await assertRecursiveHit("100-hop recursive", rows, 100);
    },
  );

  const recursiveThousandHopMs = await bench(
    "1000-hop recursive traversal (linear next edges, cyclePolicy: allow)",
    async () => {
      const rows = await store
        .query()
        .from("User", "u")
        .whereNode("u", (user) => user.id.eq("user_0"))
        .traverse("next", "e", { expand: "none" })
        .recursive({ cyclePolicy: "allow", minHops: 1000, maxHops: 1000 })
        .to("User", "target")
        .select((context) => ({
          id: context.target.id,
        }))
        .limit(1)
        .execute();
      await assertRecursiveHit("1000-hop recursive", rows, 1000);
    },
  );

  const metrics: QueryMetrics = {
    forwardMs,
    reverseMs,
    inverseTraversalMs,
    twoHopMs,
    threeHopMs,
    aggregateMs,
    aggregateDistinctMs,
    aggregateEdgesMs,
    scopedAggregateMs,
    indexedFilterMs,
    temporalAsOfMs,
    fulltextSearchMs,
    vectorSearchMs,
    hybridSearchMs,
    cachedExecuteMs,
    preparedExecuteMs,
    subgraphFullMs,
    subgraphApplicationProjectionMs,
    subgraphSqlProjectionMs,
    subgraphStressFullMs,
    subgraphStressApplicationProjectionMs,
    subgraphStressSqlProjectionMs,
    tenHopMs,
    recursiveHundredHopMs,
    recursiveThousandHopMs,
  };
  return { metrics, latencies };
}
