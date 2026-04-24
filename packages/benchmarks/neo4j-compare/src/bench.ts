/**
 * Neo4j-side of the head-to-head benchmark. Runs the same query shapes as
 * packages/benchmarks/src/measurements.ts with matching methodology
 * (2 warmup iterations, 15 samples, median reported).
 *
 * Queries are driver-side compiled via parameter binding; Neo4j caches the
 * query plan so re-executions skip planning. This is the closest analogue
 * to TypeGraph's `cachedExecute` / `preparedExecute`.
 *
 * Notes on semantics:
 *   - Cypher's variable-length path `*N..N` enforces relationship uniqueness
 *     by default (no repeated edge). The :NEXT chain is linear so no cycles
 *     exist either way. TypeGraph's benchmark uses `cyclePolicy: "allow"`,
 *     which skips cycle tracking entirely — slightly looser than Cypher's
 *     default, but for this shape the traversal space is identical.
 *   - `expand: "inverse"` is a TypeGraph ontology feature with no direct
 *     Cypher equivalent; that row is omitted from the comparison.
 */
import neo4j, { type Driver, type Session } from "neo4j-driver";

import { BENCHMARK_CONFIG, NEO4J_CONFIG } from "./config.ts";
import { formatMs, median, nowMs } from "./utils.ts";

async function benchmarkQuery(
  label: string,
  fn: () => Promise<void>,
): Promise<number> {
  for (let i = 0; i < BENCHMARK_CONFIG.warmupIterations; i += 1) {
    await fn();
  }
  const samples: number[] = [];
  for (let i = 0; i < BENCHMARK_CONFIG.sampleIterations; i += 1) {
    const startedAt = nowMs();
    await fn();
    samples.push(nowMs() - startedAt);
  }
  const result = median(samples);
  console.log(`${label}: ${formatMs(result)}`);
  return result;
}

/**
 * Runs a Cypher query and returns records as plain JS objects so call
 * sites can assert cardinality and content invariants — mirroring the
 * TypeGraph-side invariants. Drops the Neo4j driver's record wrapper
 * by projecting every field to its JS value.
 */
async function run(
  session: Session,
  cypher: string,
  params: Record<string, unknown>,
): Promise<readonly Record<string, unknown>[]> {
  const result = await session.run(cypher, params);
  return result.records.map((record) => record.toObject());
}

type Metrics = {
  forwardMs: number;
  cachedExecuteMs: number;
  preparedExecuteMs: number;
  reverseMs: number;
  twoHopMs: number;
  threeHopMs: number;
  aggregateMs: number;
  aggregateDistinctMs: number;
  tenHopMs: number;
  hundredHopMs: number;
  thousandHopMs: number;
};

async function main(): Promise<Metrics> {
  const driver = neo4j.driver(
    NEO4J_CONFIG.url,
    neo4j.auth.basic(NEO4J_CONFIG.user, NEO4J_CONFIG.password),
    { maxConnectionPoolSize: 10 },
  );

  // Warm up the page cache by touching every node and edge once.
  {
    const session = driver.session({ database: NEO4J_CONFIG.database });
    try {
      await session.run("MATCH (n) RETURN count(n)");
      await session.run("MATCH ()-[r]->() RETURN count(r)");
    } finally {
      await session.close();
    }
  }

  const session = driver.session({ database: NEO4J_CONFIG.database });
  try {
    console.log(
      `Neo4j perf sanity (report mode, backend=neo4j ${NEO4J_CONFIG.url})`,
    );

    // Every User in the seed has exactly 10 outgoing FOLLOWS relationships,
    // so user_0's forward-traversal cardinality is an invariant on both sides.
    const expectedForwardCount = 10;
    const assertLength = (
      label: string,
      rows: readonly unknown[],
      expected: number,
    ): void => {
      if (rows.length !== expected) {
        throw new Error(
          `${label} drift: expected ${expected} rows, got ${rows.length}`,
        );
      }
    };

    const forwardMs = await benchmarkQuery("forward traversal", async () => {
      const rows = await run(
        session,
        `MATCH (u:User {id: "user_0"})-[:FOLLOWS]->(friend:User)
         RETURN friend.name AS friendName`,
        {},
      );
      assertLength("forward traversal", rows, expectedForwardCount);
    });

    const cachedCypher = `MATCH (u:User {id: "user_0"})-[:FOLLOWS]->(friend:User)
                          RETURN friend.name AS friendName`;
    const cachedExecuteMs = await benchmarkQuery(
      "cached execute (same query text)",
      async () => {
        const rows = await run(session, cachedCypher, {});
        assertLength("cached execute", rows, expectedForwardCount);
      },
    );

    const preparedCypher = `MATCH (u:User {id: $userId})-[:FOLLOWS]->(friend:User)
                            RETURN friend.name AS friendName`;
    const preparedExecuteMs = await benchmarkQuery(
      "prepared execute",
      async () => {
        const rows = await run(session, preparedCypher, { userId: "user_0" });
        assertLength("prepared execute", rows, expectedForwardCount);
      },
    );

    const reverseMs = await benchmarkQuery("reverse traversal", async () => {
      const rows = await run(
        session,
        `MATCH (follower:User)-[:FOLLOWS]->(target:User {id: "user_0"})
         RETURN follower.name AS followerName`,
        {},
      );
      if (rows.length === 0) {
        throw new Error(
          "reverse traversal drift: expected non-empty result set",
        );
      }
    });

    const twoHopMs = await benchmarkQuery("2-hop traversal", async () => {
      const rows = await run(
        session,
        `MATCH (u:User {id: "user_0"})-[:FOLLOWS]->(friend:User)-[:AUTHORED]->(post:Post)
         RETURN friend.name AS friendName, post.title AS title
         LIMIT 50`,
        {},
      );
      assertLength("2-hop traversal", rows, 50);
    });

    const threeHopMs = await benchmarkQuery("3-hop traversal", async () => {
      const rows = await run(
        session,
        `MATCH (u:User {id: "user_500"})
               -[:FOLLOWS]->(f1:User)
               -[:FOLLOWS]->(f2:User)
               -[:AUTHORED]->(post:Post)
         RETURN f1.name AS f1Name, f2.name AS f2Name, post.title AS title
         LIMIT 20`,
        {},
      );
      assertLength("3-hop traversal", rows, 20);
    });

    // Full-graph aggregate. Deliberately no `LIMIT` — we claim this
    // measures COUNT per user across all 1,200 users, and we assert that
    // count returns, so the measurement and the label stay aligned.
    // The TypeGraph-side benchmark was updated to match.
    const expectedAggregateRows = 1200;
    const aggregateMs = await benchmarkQuery(
      "aggregate follow count",
      async () => {
        const rows = await run(
          session,
          `MATCH (u:User)
         OPTIONAL MATCH (u)-[:FOLLOWS]->(target:User)
         WITH u, count(target) AS followCount
         RETURN u.name AS name, followCount`,
          {},
        );
        assertLength("aggregate follow count", rows, expectedAggregateRows);
      },
    );

    const aggregateDistinctMs = await benchmarkQuery(
      "aggregate distinct follow count",
      async () => {
        const rows = await run(
          session,
          `MATCH (u:User)
           OPTIONAL MATCH (u)-[:FOLLOWS]->(target:User)
           WITH u, count(DISTINCT target) AS followCount
           RETURN u.name AS name, followCount`,
          {},
        );
        assertLength(
          "aggregate distinct follow count",
          rows,
          expectedAggregateRows,
        );
      },
    );

    // Recursive traversals walk the :NEXT linear chain (user_0 -> user_1
    // -> ...). At depth N, the single reachable target is user_N.
    // Asserting the target id catches both empty-result regressions and
    // off-by-one depth bugs, same as the TypeGraph side.
    const assertRecursiveHit = (
      label: string,
      rows: readonly Record<string, unknown>[],
      expectedDepth: number,
    ): void => {
      if (rows.length !== 1) {
        throw new Error(
          `${label} drift: expected 1 row at depth ${expectedDepth}, got ${rows.length}`,
        );
      }
      if (rows[0]!.id !== `user_${expectedDepth}`) {
        throw new Error(
          `${label} drift: expected target user_${expectedDepth}, got ${String(rows[0]!.id)}`,
        );
      }
    };

    const tenHopMs = await benchmarkQuery(
      "10-hop recursive traversal (linear :NEXT chain)",
      async () => {
        const rows = await run(
          session,
          `MATCH (u:User {id: "user_0"})-[:NEXT*10..10]->(target:User)
           RETURN target.id AS id, target.name AS name
           LIMIT 1`,
          {},
        );
        assertRecursiveHit("10-hop recursive", rows, 10);
      },
    );

    const hundredHopMs = await benchmarkQuery(
      "100-hop recursive traversal (linear :NEXT chain)",
      async () => {
        const rows = await run(
          session,
          `MATCH (u:User {id: "user_0"})-[:NEXT*100..100]->(target:User)
           RETURN target.id AS id
           LIMIT 1`,
          {},
        );
        assertRecursiveHit("100-hop recursive", rows, 100);
      },
    );

    const thousandHopMs = await benchmarkQuery(
      "1000-hop recursive traversal (linear :NEXT chain)",
      async () => {
        const rows = await run(
          session,
          `MATCH (u:User {id: "user_0"})-[:NEXT*1000..1000]->(target:User)
           RETURN target.id AS id
           LIMIT 1`,
          {},
        );
        assertRecursiveHit("1000-hop recursive", rows, 1000);
      },
    );

    const metrics: Metrics = {
      forwardMs,
      cachedExecuteMs,
      preparedExecuteMs,
      reverseMs,
      twoHopMs,
      threeHopMs,
      aggregateMs,
      aggregateDistinctMs,
      tenHopMs,
      hundredHopMs,
      thousandHopMs,
    };

    console.log("");
    console.log("Ratios:");
    console.log(`reverse/forward: ${(reverseMs / forwardMs).toFixed(2)}x`);
    console.log(`3-hop/2-hop: ${(threeHopMs / twoHopMs).toFixed(2)}x`);
    console.log(
      `aggregateDistinct/aggregate: ${(aggregateDistinctMs / aggregateMs).toFixed(2)}x`,
    );
    console.log(
      `prepared/cached: ${(preparedExecuteMs / cachedExecuteMs).toFixed(2)}x`,
    );
    console.log(`100-hop/10-hop: ${(hundredHopMs / tenHopMs).toFixed(2)}x`);
    console.log(
      `1000-hop/100-hop: ${(thousandHopMs / hundredHopMs).toFixed(2)}x`,
    );

    return metrics;
  } finally {
    await session.close();
    await driver.close();
  }
}

await main();
