import { count, countDistinct, field, param } from "@nicia-ai/typegraph";

import { BENCHMARK_CONFIG, type QueryMetrics } from "./config";
import { type PerfStore } from "./graph";
import { formatMs, median, nowMs } from "./utils";

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

export async function measureQueries(store: PerfStore): Promise<QueryMetrics> {
  const cachedExecuteQuery = store
    .query()
    .from("User", "u")
    .whereNode("u", (user) => user.id.eq("user_0"))
    .traverse("follows", "e")
    .to("User", "friend")
    .select((context) => ({ friendName: context.friend.name }));

  const preparedExecuteQuery = store
    .query()
    .from("User", "u")
    .whereNode("u", (user) => user.id.eq(param("userId")))
    .traverse("follows", "e")
    .to("User", "friend")
    .select((context) => ({ friendName: context.friend.name }))
    .prepare();

  const forwardMs = await benchmarkQuery("forward traversal", async () => {
    await store
      .query()
      .from("User", "u")
      .whereNode("u", (user) => user.id.eq("user_0"))
      .traverse("follows", "e")
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

  const reverseMs = await benchmarkQuery("reverse traversal", async () => {
    await store
      .query()
      .from("User", "follower")
      .traverse("follows", "e")
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
      .traverse("follows", "e1")
      .to("User", "friend")
      .traverse("authored", "e2")
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
      .traverse("follows", "e1")
      .to("User", "f1")
      .traverse("follows", "e2")
      .to("User", "f2")
      .traverse("authored", "e3")
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
        .optionalTraverse("follows", "e")
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
        .optionalTraverse("follows", "e")
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
    "10-hop traversal (linear next edges)",
    async () => {
      await store
        .query()
        .from("User", "u0")
        .whereNode("u0", (user) => user.id.eq("user_0"))
        .traverse("next", "e1")
        .to("User", "u1")
        .traverse("next", "e2")
        .to("User", "u2")
        .traverse("next", "e3")
        .to("User", "u3")
        .traverse("next", "e4")
        .to("User", "u4")
        .traverse("next", "e5")
        .to("User", "u5")
        .traverse("next", "e6")
        .to("User", "u6")
        .traverse("next", "e7")
        .to("User", "u7")
        .traverse("next", "e8")
        .to("User", "u8")
        .traverse("next", "e9")
        .to("User", "u9")
        .traverse("next", "e10")
        .to("User", "u10")
        .select((context) => ({
          id: context.u10.id,
          name: context.u10.name,
        }))
        .limit(1)
        .execute();
    },
  );

  const recursiveHundredHopMs = await benchmarkQuery(
    "100-hop recursive traversal (linear next edges)",
    async () => {
      await store
        .query()
        .from("User", "u")
        .whereNode("u", (user) => user.id.eq("user_0"))
        .traverse("next", "e")
        .recursive()
        .minHops(100)
        .maxHops(100)
        .to("User", "target")
        .select((context) => ({
          id: context.target.id,
        }))
        .limit(1)
        .execute();
    },
  );

  const recursiveThousandHopMs = await benchmarkQuery(
    "1000-hop recursive traversal (linear next edges)",
    async () => {
      await store
        .query()
        .from("User", "u")
        .whereNode("u", (user) => user.id.eq("user_0"))
        .traverse("next", "e")
        .recursive()
        .minHops(1000)
        .maxHops(1000)
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
    tenHopMs,
    recursiveHundredHopMs,
    recursiveThousandHopMs,
  };
}
