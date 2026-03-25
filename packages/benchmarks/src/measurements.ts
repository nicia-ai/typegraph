import { count, countDistinct, field, param } from "@nicia-ai/typegraph";

import { BENCHMARK_CONFIG, type QueryMetrics } from "./config";
import { type PerfStore } from "./graph";
import { formatMs, median, nowMs } from "./utils";

type FullSubgraphResult = Readonly<{
  nodes: readonly (
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
  )[];
  edges: readonly Readonly<{
    id: string;
    kind: "follows" | "authored";
    fromId: string;
    toId: string;
  }>[];
}>;

type ProjectedSubgraphResult = Readonly<{
  nodes: readonly (
    | Readonly<{ kind: "User"; id: string; name: string }>
    | Readonly<{ kind: "Post"; id: string; title: string }>
  )[];
  edges: readonly Readonly<{
    id: string;
    kind: "follows" | "authored";
    fromId: string;
    toId: string;
  }>[];
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

  const result = median(samples);
  console.log(`${label}: ${formatMs(result)}`);
  return result;
}

function consumeSubgraphCounts(
  result: Readonly<{
    nodes: readonly Readonly<{ kind: string; id: string }>[];
    edges: readonly Readonly<{ id: string; fromId: string; toId: string }>[];
  }>,
): number {
  let checksum = 0;

  for (const node of result.nodes) {
    checksum += node.id.length + node.kind.length;
  }

  for (const edge of result.edges) {
    checksum += edge.id.length + edge.fromId.length + edge.toId.length;
  }

  return checksum;
}

function projectSubgraphInApplication(result: FullSubgraphResult): number {
  let checksum = 0;

  for (const node of result.nodes) {
    if (node.kind === "User") {
      checksum += node.id.length + node.name.length;
      continue;
    }

    if (node.kind === "Post") {
      checksum += node.id.length + node.title.length;
    }
  }

  for (const edge of result.edges) {
    checksum += edge.id.length + edge.fromId.length + edge.toId.length;
  }

  return checksum;
}

function consumeProjectedSubgraph(result: ProjectedSubgraphResult): number {
  let checksum = 0;

  for (const node of result.nodes) {
    if (node.kind === "User") {
      checksum += node.id.length + node.name.length;
      continue;
    }

    checksum += node.id.length + node.title.length;
  }

  for (const edge of result.edges) {
    checksum += edge.id.length + edge.fromId.length + edge.toId.length;
  }

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
  console.log(
    `${label}: ${result.nodes.length} nodes, ${result.edges.length} edges`,
  );
}

export async function measureQueries(store: PerfStore): Promise<QueryMetrics> {
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

  const forwardMs = await benchmarkQuery("forward traversal", async () => {
    await store
      .query()
      .from("User", "u")
      .whereNode("u", (user) => user.id.eq("user_0"))
      .traverse("follows", "e", { expand: "none" })
      .to("User", "friend")
      .select((context) => ({ friendName: context.friend.name }))
      .execute();
  });

  const cachedExecuteMs = await benchmarkQuery(
    "cached execute (same query instance)",
    async () => {
      await cachedExecuteQuery.execute();
    },
  );

  const preparedExecuteMs = await benchmarkQuery(
    "prepared execute",
    async () => {
      await preparedExecuteQuery.execute({ userId: "user_0" });
    },
  );

  await logSubgraphShape(
    store,
    "subgraph baseline shape (wide payload, depth 2)",
    SUBGRAPH_BASELINE_OPTIONS,
  );

  const subgraphFullMs = await benchmarkQuery(
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

  const subgraphApplicationProjectionMs = await benchmarkQuery(
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

  const subgraphSqlProjectionMs = await benchmarkQuery(
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

  const subgraphStressFullMs = await benchmarkQuery(
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

  const subgraphStressApplicationProjectionMs = await benchmarkQuery(
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

  const subgraphStressSqlProjectionMs = await benchmarkQuery(
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

  const reverseMs = await benchmarkQuery("reverse traversal", async () => {
    await store
      .query()
      .from("User", "follower")
      .traverse("follows", "e", { expand: "none" })
      .to("User", "target")
      .whereNode("target", (target) => target.id.eq("user_0"))
      .select((context) => ({ followerName: context.follower.name }))
      .execute();
  });

  const inverseTraversalMs = await benchmarkQuery(
    "inverse traversal (expand: inverse)",
    async () => {
      await store
        .query()
        .from("User", "u")
        .whereNode("u", (user) => user.id.eq("user_600"))
        .traverse("next", "e", { expand: "inverse" })
        .to("User", "neighbor")
        .select((context) => ({ neighborId: context.neighbor.id }))
        .limit(20)
        .execute();
    },
  );

  const twoHopMs = await benchmarkQuery("2-hop traversal", async () => {
    await store
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
  });

  const threeHopMs = await benchmarkQuery("3-hop traversal", async () => {
    await store
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
  });

  const aggregateMs = await benchmarkQuery(
    "aggregate follow count",
    async () => {
      await store
        .query()
        .from("User", "u")
        .optionalTraverse("follows", "e", { expand: "none" })
        .to("User", "target")
        .groupByNode("u")
        .aggregate({
          name: field("u", "name"),
          followCount: count("target"),
        })
        .limit(20)
        .execute();
    },
  );

  const aggregateDistinctMs = await benchmarkQuery(
    "aggregate distinct follow count",
    async () => {
      await store
        .query()
        .from("User", "u")
        .optionalTraverse("follows", "e", { expand: "none" })
        .to("User", "target")
        .groupByNode("u")
        .aggregate({
          name: field("u", "name"),
          followCount: countDistinct("target"),
        })
        .limit(20)
        .execute();
    },
  );

  const tenHopMs = await benchmarkQuery(
    "10-hop recursive traversal (linear next edges, cyclePolicy: allow)",
    async () => {
      await store
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
    },
  );

  const recursiveHundredHopMs = await benchmarkQuery(
    "100-hop recursive traversal (linear next edges, cyclePolicy: allow)",
    async () => {
      await store
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
    },
  );

  const recursiveThousandHopMs = await benchmarkQuery(
    "1000-hop recursive traversal (linear next edges, cyclePolicy: allow)",
    async () => {
      await store
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
    },
  );

  return {
    forwardMs,
    reverseMs,
    inverseTraversalMs,
    twoHopMs,
    threeHopMs,
    aggregateMs,
    aggregateDistinctMs,
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
}
