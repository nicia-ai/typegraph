/**
 * Identity expansion at the **current** read coordinate must be bounded by the
 * frontier, not by the identity population (typegraph#432).
 *
 * The regression this pins: the class relation was built by self-joining the
 * whole closure table into a materialized CTE, so a hop from a single start row
 * paid for every identity class in the graph. Nine unrelated classes of 501
 * members produce 501² rows each — 2,259,009 seed/member pairs — before any
 * frontier predicate applies, which is quadratic in the identity population for
 * a query that reads one row.
 *
 * Two independent guards, because each catches what the other cannot:
 *
 * - **Plan shape** (deterministic, the primary guard). Every access to the
 *   closure must be an index seek keyed by the row before it: the frontier row's
 *   class through the closure primary key, that class's members through the
 *   class index, each member's node through the nodes primary key. A full scan
 *   of the closure — or a materialized relation over it — is the regression, and
 *   the plan says so regardless of machine, data volume or timer resolution.
 * - **Scaling** (timing, the sanity check). Doubling an unrelated class's size
 *   must not multiply the hop's cost. Held loosely on purpose: see
 *   {@link assertFlatScaling} for the bound's rationale.
 *
 * Both run on SQLite and, when `POSTGRES_URL` is set, on PostgreSQL: the fix is
 * one compilation path, so a guard that ran on one engine would certify half of
 * it.
 */
import type BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type GraphBackend,
} from "../src";
import { generatePostgresMigrationSQL } from "../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../src/backend/postgres";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { IDENTITY_CLASS_CTE_ALIAS } from "../src/query/compiler/identity-traversal";
import { provisionPostgresTestDatabase } from "./postgres-test-database";

/**
 * Unrelated identity classes, sized to reproduce the review's scenario without
 * making the lane pay for a graph that has to be provisioned twice. Nine classes
 * of 500 members is 2,250,000 seed/member pairs under the removed shape.
 */
const UNRELATED_CLASS_COUNT = 9;

/** The two sizes {@link assertFlatScaling} compares. */
const SMALL_CLASS_SIZE = 250;
const LARGE_CLASS_SIZE = 500;

const FrontierPerson = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const frontierLink = defineEdge("link", { schema: z.object({}) });

/**
 * `sameIdAcrossKinds: "ignore"` keeps every class in the fixture the product of
 * an explicit assertion, so the sizes below are exactly what the closure holds.
 */
const frontierGraph = defineGraph({
  id: "identity_frontier_bounded",
  nodes: { Person: { type: FrontierPerson } },
  edges: {
    link: { type: frontierLink, from: [FrontierPerson], to: [FrontierPerson] },
  },
  identity: { sameIdAcrossKinds: "ignore" },
});

type FrontierStore = Awaited<
  ReturnType<typeof createStoreWithSchema<typeof frontierGraph>>
>[0];

/**
 * Seeds the measured shape: a one-row frontier whose own class has three
 * members, `unrelatedMembers` members in each of {@link UNRELATED_CLASS_COUNT}
 * classes that share nothing with it, and a single `link` edge leaving a *peer*
 * of the start row.
 *
 * The edge leaves the peer rather than the start row so nothing is reachable
 * without the expansion — a hop that quietly stopped expanding identity would
 * return no rows rather than return them faster.
 */
async function provisionFrontierFixture(
  backend: GraphBackend,
  unrelatedMembers: number,
): Promise<FrontierStore> {
  const [store] = await createStoreWithSchema(frontierGraph, backend);
  const nodes = [
    { id: "start", props: { name: "start" } },
    { id: "start-peer", props: { name: "start peer" } },
    { id: "start-peer-two", props: { name: "start peer two" } },
    { id: "target", props: { name: "target" } },
    ...Array.from(
      { length: UNRELATED_CLASS_COUNT * unrelatedMembers },
      (unused, index) => ({
        id: `unrelated-${index}`,
        props: { name: `unrelated ${index}` },
      }),
    ),
  ];
  await store.nodes.Person.bulkCreate(nodes);
  await store.edges.link.bulkCreate([
    {
      from: { id: "start-peer", kind: "Person" as const },
      id: "link-peer-target",
      props: {},
      to: { id: "target", kind: "Person" as const },
    },
  ]);

  const pairs = [
    {
      a: { id: "start", kind: "Person" as const },
      b: { id: "start-peer", kind: "Person" as const },
    },
    {
      a: { id: "start", kind: "Person" as const },
      b: { id: "start-peer-two", kind: "Person" as const },
    },
  ];
  for (
    let classIndex = 0;
    classIndex < UNRELATED_CLASS_COUNT;
    classIndex += 1
  ) {
    const first = classIndex * unrelatedMembers;
    for (let member = 1; member < unrelatedMembers; member += 1) {
      pairs.push({
        a: { id: `unrelated-${first}`, kind: "Person" as const },
        b: { id: `unrelated-${first + member}`, kind: "Person" as const },
      });
    }
  }
  await store.identity.bulkAssertSame(pairs);
  // Both engines plan from statistics; measuring before they exist would measure
  // the planner's default guesses instead of the shape under test.
  await store.refreshStatistics();
  return store;
}

/** The measured hop: one frontier row, reached through its identity class. */
function frontierHop(store: FrontierStore) {
  return store
    .query()
    .from("Person", "person")
    .whereNode("person", (node) => node.id.eq("start"))
    .traverse("link", "edge", {
      expand: "none",
      includeIdentityMembers: true,
    })
    .to("Person", "friend")
    .select((queryContext) => queryContext.friend.id);
}

/** Runs the hop, asserting it still reaches the target through the peer. */
async function executeFrontierHop(store: FrontierStore): Promise<number> {
  const started = performance.now();
  const rows = await frontierHop(store).execute();
  const elapsed = performance.now() - started;
  expect(rows).toEqual(["target"]);
  return elapsed;
}

/** Median of `runs` executions, after two warm-up executions. */
async function medianMilliseconds(
  store: FrontierStore,
  runs: number,
): Promise<number> {
  await executeFrontierHop(store);
  await executeFrontierHop(store);
  const samples: number[] = [];
  for (let run = 0; run < runs; run += 1) {
    samples.push(await executeFrontierHop(store));
  }
  const sorted = samples.toSorted((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

/**
 * The noise floor the ratio is taken against.
 *
 * A frontier-bounded hop over this fixture costs well under a millisecond, so a
 * bare `t(500) < 3 × t(250)` ratio would compare two numbers that are mostly
 * timer noise and scheduler jitter — it would fail on a busy machine while
 * certifying nothing. Comparing against `max(t(250), 10ms)` keeps the guard
 * meaningful in the only direction that matters: the removed shape costs ~150 ms
 * at 250 members and ~560 ms at 500 on both engines, so anything quadratic in the
 * identity population misses a 30 ms ceiling by more than an order of magnitude.
 */
const SCALING_NOISE_FLOOR_MS = 10;

/** Factor allowed between the two sizes — generous against a noisy lane. */
const SCALING_TOLERANCE = 3;

function assertFlatScaling(small: number, large: number, engine: string): void {
  const ceiling = SCALING_TOLERANCE * Math.max(small, SCALING_NOISE_FLOOR_MS);
  expect({
    engine,
    doubledUnrelatedPopulation: large <= ceiling,
  }).toEqual({ engine, doubledUnrelatedPopulation: true });
}

describe("current identity expansion is frontier-bounded", () => {
  describe("sqlite", () => {
    it("seeks the closure from the frontier instead of scanning it", async () => {
      const { backend, db } = createLocalSqliteBackend();
      try {
        const store = await provisionFrontierFixture(backend, LARGE_CLASS_SIZE);
        const statement = frontierHop(store).toSQL();
        const client = (db as unknown as { $client: BetterSqlite3.Database })
          .$client;
        const plan = (
          client
            .prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
            .all(...statement.params) as readonly { detail: string }[]
        )
          .map((row) => row.detail)
          .join("\n");

        // The frontier row's class, then that class's members: both index
        // seeks, each keyed by the step before it.
        expect(plan).toContain(
          "SEARCH identity_seed_class USING INDEX sqlite_autoindex_typegraph_identity_closure_1",
        );
        expect(plan).toContain(
          "SEARCH identity_peer USING INDEX typegraph_identity_closure_class_idx",
        );
        // The regression's signature: the closure read whole, or folded into a
        // relation the frontier cannot narrow. Both spellings are pinned — the
        // hoisted relation shows up as its own `MATERIALIZE` step, while an
        // unkeyed join shows up as a scan of the closure under whatever alias it
        // is given.
        expect(plan).not.toContain(`MATERIALIZE ${IDENTITY_CLASS_CTE_ALIAS}`);
        expect(plan).not.toContain("SCAN typegraph_identity_closure");
        expect(plan).not.toMatch(/SCAN identity_/);
      } finally {
        await backend.close();
      }
    }, 120_000);

    it("does not grow with an unrelated identity class", async () => {
      const measured: number[] = [];
      for (const size of [SMALL_CLASS_SIZE, LARGE_CLASS_SIZE]) {
        const { backend } = createLocalSqliteBackend();
        try {
          const store = await provisionFrontierFixture(backend, size);
          measured.push(await medianMilliseconds(store, 5));
        } finally {
          await backend.close();
        }
      }
      const [small, large] = measured;
      assertFlatScaling(small ?? Number.NaN, large ?? Number.NaN, "sqlite");
    }, 300_000);
  });

  describe("postgres", () => {
    const databaseUrl = process.env["POSTGRES_URL"];
    let pool: Pool | undefined;

    beforeAll(async () => {
      if (databaseUrl === undefined) return;
      const url = await provisionPostgresTestDatabase(import.meta.url);
      const candidate = new Pool({
        connectionString: url,
        connectionTimeoutMillis: 5000,
      });
      await candidate.query("SELECT 1");
      await candidate.query(generatePostgresMigrationSQL());
      pool = candidate;
    }, 120_000);

    afterAll(async () => {
      if (pool !== undefined) await pool.end();
    });

    async function truncate(activePool: Pool): Promise<void> {
      await activePool.query(
        "TRUNCATE typegraph_nodes, typegraph_edges, typegraph_identity_assertions, typegraph_identity_closure",
      );
    }

    it.runIf(databaseUrl !== undefined)(
      "visits a bounded number of rows regardless of the identity population",
      async () => {
        const activePool = pool;
        if (activePool === undefined) return;
        const store = await provisionFrontierFixture(
          createPostgresBackend(drizzle(activePool)),
          LARGE_CLASS_SIZE,
        );
        const statement = frontierHop(store).toSQL();
        // Actual rows rather than estimates: PostgreSQL reports no plan-level
        // "materialized" marker to assert on, but a relation built over the whole
        // closure has to emit its rows, and they are counted here.
        const explained = await activePool.query<{ "QUERY PLAN": PlanRoot[] }>(
          `EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF, FORMAT JSON) ${statement.sql}`,
          [...statement.params],
        );
        const root = explained.rows[0]?.["QUERY PLAN"][0]?.Plan;
        const visited =
          root === undefined ? Number.POSITIVE_INFINITY : totalActualRows(root);

        // The fixture holds 4504 nodes in 10 identity classes; the removed shape
        // emitted 2,250,000 pairs from them. A frontier-bounded hop touches the
        // start row, its two peers and one edge — tens of rows, whatever the
        // planner picks. The ceiling is loose enough to survive a plan change and
        // four orders of magnitude below the regression.
        expect(visited).toBeLessThan(500);
        await truncate(activePool);
      },
      300_000,
    );

    it.runIf(databaseUrl !== undefined)(
      "does not grow with an unrelated identity class",
      async () => {
        const activePool = pool;
        if (activePool === undefined) return;
        const measured: number[] = [];
        for (const size of [SMALL_CLASS_SIZE, LARGE_CLASS_SIZE]) {
          const store = await provisionFrontierFixture(
            createPostgresBackend(drizzle(activePool)),
            size,
          );
          measured.push(await medianMilliseconds(store, 5));
          await truncate(activePool);
        }
        const [small, large] = measured;
        assertFlatScaling(small ?? Number.NaN, large ?? Number.NaN, "postgres");
      },
      600_000,
    );
  });
});

/** Shape of the `EXPLAIN (FORMAT JSON)` documents this file reads. */
type PlanRoot = Readonly<{ Plan: PlanNode }>;

type PlanNode = Readonly<{
  "Actual Loops"?: number;
  "Actual Rows"?: number;
  Plans?: readonly PlanNode[];
}>;

/**
 * Rows every node of the plan actually emitted, loops included — PostgreSQL
 * reports per-loop averages, so a nested loop's inner side has to be multiplied
 * back out to count the work it did.
 */
function totalActualRows(node: PlanNode): number {
  const own = (node["Actual Rows"] ?? 0) * (node["Actual Loops"] ?? 1);
  return (node.Plans ?? []).reduce(
    (sum, child) => sum + totalActualRows(child),
    own,
  );
}
