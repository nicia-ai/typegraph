/**
 * Item D.2 (`acyclic: true`) under GENUINE contention on a real PostgreSQL
 * server: two independent connections each try to close the SAME two-node
 * cycle from opposite ends at once.
 *
 * The reachability probe (`src/store/recursive-cte.ts`'s
 * `buildEdgeAcyclicityProbe`) is an APPLICATION probe with no database key
 * behind it — the edges table is unique on `(graph_id, id)` only, and a cycle
 * is a predicate over the whole relation's current population, not over any
 * single row. Nothing stops both of two concurrent writers from probing "no
 * cycle yet", both getting a clean answer, and both committing — unless the
 * probe and the insert it guards run under one per-graph mutual exclusion.
 * `edgeWriteNeedsConstraintFence` reporting `"edgeAcyclicity"` for a
 * `cardinality: "many", acyclic: true` edge kind is what makes that fence
 * apply here (`CONSTRAINT_FENCE_BACKING.edgeAcyclicity === "lockOnly"`).
 *
 * ## Why this suite exists alongside the in-process ones
 *
 * `tests/constraint-write-fence.test.ts` pins the MECHANISM on PGlite — that
 * the per-graph lock is taken, before the reachability probe, for an acyclic
 * edge create. It cannot pin the OUTCOME: PGlite is single-connection and
 * serial, so two writers can never actually overlap there. This suite is the
 * other half — design §14.2 calls this "the test the whole design exists
 * for". It runs two independent connections against one database and
 * asserts only OUTCOMES — how many callers succeeded, and that the surviving
 * graph has no cycle — never timing or ordering, because which of the two
 * wins the lock is genuinely arbitrary and asserting on it would make the
 * suite flaky by construction.
 *
 * Against the pre-fix code (drop `"edgeAcyclicity"` from
 * `edgeWriteNeedsConstraintFence`'s acyclic arm) this case fails
 * nondeterministically: both writers' probes read "no cycle" and both
 * commit, leaving a live two-edge cycle `a -> b -> a` in the database.
 *
 * The pair carries an explicit timeout. A blocked `pg_advisory_xact_lock`
 * waits indefinitely, so a lock-order regression would otherwise stall the
 * run rather than report; the timeout turns a hang into a failure.
 *
 * ## §14.2 test 17 — a genuine engine cutoff mid-probe
 *
 * The in-process suite (`tests/edge-acyclicity.test.ts`) proves
 * `EdgeAcyclicityIndeterminateError` is reported when the backend's
 * `execute` throws a recognized cut-short code, but it SIMULATES that
 * throw — it never actually asks a real engine to abandon a running
 * statement. This is the one test that does: `SET LOCAL statement_timeout
 * = '1ms'` inside the SAME transaction as an acyclic create over a
 * 10^5-edge relation, so the reachability probe is genuinely still
 * walking when PostgreSQL cancels the statement (`57014
 * query_canceled`) — never "too small to notice a 1ms budget", which
 * would make this a test of statement-dispatch latency instead of the
 * probe itself. Asserts `EdgeAcyclicityIndeterminateError` and that no row
 * was written; `isStatementCutShortError` classifying `57014` is what
 * makes the write path report indeterminate rather than "no cycle" or a
 * raw driver error. Skipped here (no `POSTGRES_URL` in this environment);
 * the lead's Postgres lane exercises it.
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStore,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  EdgeAcyclicityError,
  EdgeAcyclicityIndeterminateError,
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { requireDefined } from "../../../src/utils/presence";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";
import { runServerSuiteSetup } from "./server-suite-setup";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

/** One writer holds the fence while the other waits for the reachability probe. */
const CONTENTION_TIMEOUT_MS = 20_000;

const Task = defineNode("Task", { schema: z.object({ name: z.string() }) });

/** `cardinality: "many", acyclic: true`: the common D.2 case. */
const dependsOn = defineEdge("dependsOn", { schema: z.object({}) });

const graph = defineGraph({
  id: "concurrent-edge-acyclicity",
  nodes: { Task: { type: Task } },
  edges: {
    dependsOn: {
      type: dependsOn,
      from: [Task],
      to: [Task],
      cardinality: "many",
      acyclic: true,
    },
  },
});

/**
 * TWO pools, not one with a larger `max`. The losing writer parks inside
 * `pg_advisory_xact_lock` while holding its connection, and it must be
 * impossible for that wait to sit behind the winner's own connection in a
 * shared checkout queue — see `concurrent-constraint-fence.test.ts`'s
 * identical rationale.
 */
let firstPool: Pool | undefined;
let secondPool: Pool | undefined;
let firstDb: NodePgDatabase | undefined;
let secondDb: NodePgDatabase | undefined;
let isPostgresAvailable = false;

function requirePostgres(): Readonly<{
  first: NodePgDatabase;
  second: NodePgDatabase;
}> {
  if (!isPostgresAvailable || firstDb === undefined || secondDb === undefined) {
    throw new Error(
      "concurrent-edge-acyclicity: PostgreSQL connections are unavailable after setup reported success.",
    );
  }
  return { first: firstDb, second: secondDb };
}

function createPool(): Pool {
  return new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
    max: 4,
  });
}

beforeAll(async () => {
  if (!process.env["POSTGRES_URL"]) return;
  const first = createPool();
  const second = createPool();
  await runServerSuiteSetup(
    "concurrent-edge-acyclicity",
    [first, second],
    async () => {
      await first.query("SELECT 1");
      await second.query("SELECT 1");
      await first.query(generatePostgresMigrationSQL());
      firstPool = first;
      secondPool = second;
      firstDb = drizzle(first);
      secondDb = drizzle(second);
      isPostgresAvailable = true;
    },
  );
});

afterAll(async () => {
  if (firstPool !== undefined) await firstPool.end();
  if (secondPool !== undefined) await secondPool.end();
});

beforeEach(async () => {
  if (firstPool === undefined) return;
  await firstPool.query("TRUNCATE typegraph_edges, typegraph_nodes");
});

type Settled<T> = Readonly<{
  fulfilled: readonly T[];
  rejected: readonly unknown[];
}>;

/**
 * Splits a settled pair into winners and losers. Assertions are always about
 * COUNTS and the loser's error TYPE — never about which of the two writers
 * won, which is arbitrary and would make the suite flaky.
 */
function partitionSettled<T>(
  results: readonly PromiseSettledResult<T>[],
): Settled<T> {
  return {
    fulfilled: results
      .filter((result): result is PromiseFulfilledResult<T> => {
        return result.status === "fulfilled";
      })
      .map((result) => result.value),
    rejected: results
      .filter((result): result is PromiseRejectedResult => {
        return result.status === "rejected";
      })
      .map((result): unknown => result.reason),
  };
}

describe.runIf(process.env["POSTGRES_URL"])(
  "edge acyclicity under genuine contention (PostgreSQL)",
  () => {
    it(
      "admits exactly one of two concurrent creates that close the SAME two-node cycle from opposite ends",
      { timeout: CONTENTION_TIMEOUT_MS },
      async () => {
        const live = requirePostgres();
        const setup = createStore(graph, createPostgresBackend(live.first));
        const a = await setup.nodes.Task.create({ name: "a" }, { id: "a" });
        const b = await setup.nodes.Task.create({ name: "b" }, { id: "b" });

        const storeA = createStore(graph, createPostgresBackend(live.first));
        const storeB = createStore(graph, createPostgresBackend(live.second));

        // a -> b and b -> a fired at once: each writer's own probe sees no
        // cycle in the population it can read BEFORE either commits. Only
        // the per-graph fence keeps the second writer's probe from running
        // until the first has committed (or aborted).
        const { fulfilled, rejected } = partitionSettled(
          await Promise.allSettled([
            storeA.edges.dependsOn.create(a, b),
            storeB.edges.dependsOn.create(b, a),
          ]),
        );

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0]).toBeInstanceOf(EdgeAcyclicityError);

        // The surviving graph has exactly one edge and no cycle: the loser's
        // refusal left nothing behind for a third writer to trip over.
        const edges = await setup.edges.dependsOn.find({});
        expect(edges).toHaveLength(1);
        await expect(
          setup
            .verifyConstraintFences()
            .then((violations) =>
              violations.filter(
                (violation) => violation.family === "edgeAcyclicity",
              ),
            ),
        ).resolves.toEqual([]);
      },
    );

    it(
      "lets two concurrent creates that do NOT close a cycle both commit",
      { timeout: CONTENTION_TIMEOUT_MS },
      async () => {
        // The control, on OUTCOMES only: the fence must not turn independent
        // acyclic writes into failures just because they share the lock.
        const live = requirePostgres();
        const setup = createStore(graph, createPostgresBackend(live.first));
        const a = await setup.nodes.Task.create({ name: "a" }, { id: "a" });
        const b = await setup.nodes.Task.create({ name: "b" }, { id: "b" });
        const c = await setup.nodes.Task.create({ name: "c" }, { id: "c" });

        const storeA = createStore(graph, createPostgresBackend(live.first));
        const storeB = createStore(graph, createPostgresBackend(live.second));

        const { fulfilled, rejected } = partitionSettled(
          await Promise.allSettled([
            storeA.edges.dependsOn.create(a, b),
            storeB.edges.dependsOn.create(a, c),
          ]),
        );

        expect(rejected).toEqual([]);
        expect(fulfilled).toHaveLength(2);
        expect(await setup.edges.dependsOn.findFrom(a)).toHaveLength(2);
      },
    );

    it(
      "§14.2 test 17: a statement_timeout cutoff mid-probe reports EdgeAcyclicityIndeterminateError and writes nothing",
      { timeout: CONTENTION_TIMEOUT_MS },
      async () => {
        const live = requirePostgres();

        // A 10^5-edge chain: long enough that the reachability probe is
        // genuinely still walking it when the 1ms budget expires (the walk
        // costs microseconds per hop), not just dispatching the statement.
        // Seeded with two set-based INSERTs straight into the store's tables
        // rather than through the store: a chain this long is the shape a
        // per-row or per-batch acyclicity probe is slowest on, and the seed
        // is fixture setup, not the behavior under test. Node and edge ids
        // are derived from a generated series so the rows are exactly what
        // `nodes.Task.bulkCreate` / `edges.dependsOn.bulkCreate` would have
        // written for the same ids.
        const CHAIN_LENGTH = 100_000;
        const db = requireDefined(firstDb);
        const graphId = graph.id;
        await db.execute(sql`
          INSERT INTO typegraph_nodes (graph_id, id, kind, props, created_at, updated_at)
          SELECT ${graphId}, 'chain-' || i, 'Task',
                 jsonb_build_object('name', 'chain-' || i), now(), now()
          FROM generate_series(0, ${CHAIN_LENGTH}) AS s(i)
        `);
        await db.execute(sql`
          INSERT INTO typegraph_edges (graph_id, id, kind, from_kind, from_id, to_kind, to_id, props, created_at, updated_at)
          SELECT ${graphId}, 'chain-edge-' || i, 'dependsOn',
                 'Task', 'chain-' || i, 'Task', 'chain-' || (i + 1),
                 '{}'::jsonb, now(), now()
          FROM generate_series(0, ${CHAIN_LENGTH - 1}) AS s(i)
        `);
        await db.execute(sql`ANALYZE typegraph_edges`);
        const setup = createStore(graph, createPostgresBackend(live.first));

        // The closing edge, attempted inside a caller-adopted transaction
        // with a 1ms statement budget: `tail -> head` would walk the ENTIRE
        // chain to discover `head` already reaches `tail`.
        const head = { kind: "Task" as const, id: "chain-0" };
        const tail = {
          kind: "Task" as const,
          id: `chain-${String(CHAIN_LENGTH)}`,
        };

        const adapterBackend = createPostgresBackend(db);
        const adapterStore = createAdapterStore(graph, adapterBackend);

        await expect(
          db.transaction(async (sqlTx) => {
            await sqlTx.execute(sql`SET LOCAL statement_timeout = '1ms'`);
            const txStore = adapterStore.withTransaction(sqlTx);
            await txStore.edges.dependsOn.create(tail, head);
          }),
        ).rejects.toThrow(EdgeAcyclicityIndeterminateError);

        // No row was written: the caller's transaction rolled back on the
        // thrown error, and the closing edge never lands.
        const closingEdge = await setup.edges.dependsOn.find({
          from: tail,
          to: head,
        });
        expect(closingEdge).toEqual([]);
        expect(await setup.edges.dependsOn.find({})).toHaveLength(CHAIN_LENGTH);
      },
    );
  },
);
