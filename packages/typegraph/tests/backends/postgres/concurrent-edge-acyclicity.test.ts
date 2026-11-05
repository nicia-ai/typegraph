/**
 * Edge acyclicity (`acyclic: true`) under GENUINE contention on a real PostgreSQL
 * server: two independent connections each try to close the SAME two-node
 * cycle from opposite ends.
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
 * other half: two independent connections against one database, with the
 * interleaving FORCED by hold-and-gate (`./held-transaction-race.ts`). The
 * holder writes inside a transaction it keeps open; the contender starts on
 * the other pool and must be observed parked on the holder's lock before the
 * holder commits.
 *
 * Against the pre-fix code (drop `"edgeAcyclicity"` from
 * `edgeWriteNeedsConstraintFence`'s acyclic arm) the contender's probe runs
 * while the holder is still open, reads "no cycle", and commits: the case
 * fails deterministically on `contenderState: "settled"` and a live two-edge
 * cycle `a -> b -> a`.
 *
 * ## A genuine engine cutoff mid-probe
 *
 * The in-process suite (`tests/edge-acyclicity.test.ts`) proves
 * `EdgeAcyclicityIndeterminateError` is reported when the backend's
 * `execute` throws a recognized cut-short code, but it SIMULATES that
 * throw — it never actually asks a real engine to abandon a running
 * statement. This is the one test that does: a third connection holds
 * `ACCESS EXCLUSIVE` on the edges table, and the acyclic create runs under
 * `SET LOCAL statement_timeout` in its own transaction. The reachability probe
 * is the create's first statement to read the edges table, so it parks on that
 * lock until PostgreSQL cancels it (`57014 query_canceled`) — however fast or
 * loaded the machine is. Asserts `EdgeAcyclicityIndeterminateError` and that
 * no row was written; `isStatementCutShortError` classifying `57014` is what
 * makes the write path report indeterminate rather than "no cycle" or a raw
 * driver error.
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
import { provisionPostgresTestDatabase } from "../../postgres-test-database";
import {
  poolApplicationName,
  raceAgainstHeldTransaction,
  summarizeRace,
} from "./held-transaction-race";
import { runServerSuiteSetup } from "./server-suite-setup";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const CASE_TIMEOUT_MS = 20_000;
/**
 * The cut-short case's statement budget. Generous for the fence statement
 * that precedes the probe; the probe itself waits on a held table lock, so
 * no budget is ever enough for it.
 */
const PROBE_STATEMENT_TIMEOUT_MS = 1000;

const HOLDER_APPLICATION = "concurrent-edge-acyclicity:holder";
const CONTENDER_APPLICATION = "concurrent-edge-acyclicity:contender";

const Task = defineNode("Task", { schema: z.object({ name: z.string() }) });

/** `cardinality: "many", acyclic: true`: the common acyclic case. */
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
 * Separate pools, not one with a larger `max`. The contender parks inside
 * `pg_advisory_xact_lock` while holding its connection, and it must be
 * impossible for that wait to sit behind the holder's own connection in a
 * shared checkout queue — see `concurrent-constraint-fence.test.ts`'s
 * identical rationale. The probe pool observes the wait and holds the table
 * lock in the cut-short case.
 */
let holderPool: Pool | undefined;
let contenderPool: Pool | undefined;
let probePool: Pool | undefined;
let holderDb: NodePgDatabase | undefined;
let contenderDb: NodePgDatabase | undefined;

function requirePostgres(): Readonly<{
  holder: NodePgDatabase;
  contender: NodePgDatabase;
  probe: Pool;
}> {
  if (
    holderDb === undefined ||
    contenderDb === undefined ||
    probePool === undefined
  ) {
    throw new Error(
      "concurrent-edge-acyclicity: PostgreSQL connections are unavailable after setup reported success.",
    );
  }
  return { holder: holderDb, contender: contenderDb, probe: probePool };
}

function createPool(applicationName?: string): Pool {
  return new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
    max: 4,
    ...(applicationName === undefined ?
      {}
    : poolApplicationName(applicationName)),
  });
}

beforeAll(async () => {
  if (!process.env["POSTGRES_URL"]) return;
  const pools = [
    createPool(HOLDER_APPLICATION),
    createPool(CONTENDER_APPLICATION),
    createPool(),
  ] as const;
  await runServerSuiteSetup("concurrent-edge-acyclicity", pools, async () => {
    const [holder, contender, probe] = pools;
    await holder.query("SELECT 1");
    await contender.query("SELECT 1");
    await probe.query(generatePostgresMigrationSQL());
    holderPool = holder;
    contenderPool = contender;
    probePool = probe;
    holderDb = drizzle(holder);
    contenderDb = drizzle(contender);
  });
});

afterAll(async () => {
  for (const pool of [holderPool, contenderPool, probePool]) {
    if (pool !== undefined) await pool.end();
  }
});

beforeEach(async () => {
  if (probePool === undefined) return;
  await probePool.query("TRUNCATE typegraph_edges, typegraph_nodes");
});

describe.runIf(process.env["POSTGRES_URL"])(
  "edge acyclicity under genuine contention (PostgreSQL)",
  () => {
    it(
      "refuses the second of two creates that close the SAME two-node cycle from opposite ends",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const live = requirePostgres();
        const setup = createStore(graph, createPostgresBackend(live.holder));
        const a = await setup.nodes.Task.create({ name: "a" }, { id: "a" });
        const b = await setup.nodes.Task.create({ name: "b" }, { id: "b" });

        const holderStore = createStore(
          graph,
          createPostgresBackend(live.holder),
        );
        const contenderStore = createStore(
          graph,
          createPostgresBackend(live.contender),
        );

        // The contender's own probe would see no cycle in the population it
        // can read while the holder is open. Only the per-graph fence keeps
        // that probe from running until the holder has committed.
        const race = await raceAgainstHeldTransaction({
          probe: live.probe,
          holderApplication: HOLDER_APPLICATION,
          contenderApplication: CONTENDER_APPLICATION,
          holder: (holdOpen) =>
            holderStore.transaction(async (tx) => {
              await tx.edges.dependsOn.create(a, b);
              await holdOpen();
            }),
          contender: () => contenderStore.edges.dependsOn.create(b, a),
        });

        expect(summarizeRace(race)).toEqual({
          contenderState: "blocked",
          holder: "ok",
          contender: EdgeAcyclicityError.name,
        });

        // The surviving graph has exactly the holder's edge and no cycle: the
        // contender's refusal left nothing behind for a third writer to trip
        // over.
        expect(await setup.edges.dependsOn.findFrom(a)).toHaveLength(1);
        expect(await setup.edges.dependsOn.find({})).toHaveLength(1);
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
      "lets two creates that do NOT close a cycle both commit, the second after waiting on the fence",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        // The control: the fence must not turn independent acyclic writes into
        // failures just because they share the lock. Both take it, so the
        // contender still waits — and then commits.
        const live = requirePostgres();
        const setup = createStore(graph, createPostgresBackend(live.holder));
        const a = await setup.nodes.Task.create({ name: "a" }, { id: "a" });
        const b = await setup.nodes.Task.create({ name: "b" }, { id: "b" });
        const c = await setup.nodes.Task.create({ name: "c" }, { id: "c" });

        const holderStore = createStore(
          graph,
          createPostgresBackend(live.holder),
        );
        const contenderStore = createStore(
          graph,
          createPostgresBackend(live.contender),
        );

        const race = await raceAgainstHeldTransaction({
          probe: live.probe,
          holderApplication: HOLDER_APPLICATION,
          contenderApplication: CONTENDER_APPLICATION,
          holder: (holdOpen) =>
            holderStore.transaction(async (tx) => {
              await tx.edges.dependsOn.create(a, b);
              await holdOpen();
            }),
          contender: () => contenderStore.edges.dependsOn.create(a, c),
        });

        expect(summarizeRace(race)).toEqual({
          contenderState: "blocked",
          holder: "ok",
          contender: "ok",
        });
        expect(await setup.edges.dependsOn.findFrom(a)).toHaveLength(2);
      },
    );

    it(
      "a statement_timeout cutoff mid-probe reports EdgeAcyclicityIndeterminateError and writes nothing",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const live = requirePostgres();
        const setup = createStore(graph, createPostgresBackend(live.holder));
        const head = await setup.nodes.Task.create(
          { name: "head" },
          { id: "head" },
        );
        const tail = await setup.nodes.Task.create(
          { name: "tail" },
          { id: "tail" },
        );
        await setup.edges.dependsOn.create(head, tail);

        // `tail -> head` closes a cycle, so a probe that ran to completion
        // would refuse it with `EdgeAcyclicityError`; only a cut-short probe
        // reports indeterminate.
        const adapterStore = createAdapterStore(
          graph,
          createPostgresBackend(live.holder),
        );
        const tableLock = await live.probe.connect();
        try {
          await tableLock.query("BEGIN");
          await tableLock.query(
            "LOCK TABLE typegraph_edges IN ACCESS EXCLUSIVE MODE",
          );

          await expect(
            live.holder.transaction(async (sqlTx) => {
              await sqlTx.execute(
                sql.raw(
                  `SET LOCAL statement_timeout = '${String(PROBE_STATEMENT_TIMEOUT_MS)}ms'`,
                ),
              );
              await adapterStore
                .withTransaction(sqlTx)
                .edges.dependsOn.create(tail, head);
            }),
          ).rejects.toThrow(EdgeAcyclicityIndeterminateError);
        } finally {
          await tableLock.query("ROLLBACK");
          tableLock.release();
        }

        // No row was written: the caller's transaction rolled back on the
        // thrown error, and the closing edge never lands.
        expect(
          await setup.edges.dependsOn.find({ from: tail, to: head }),
        ).toEqual([]);
        expect(await setup.edges.dependsOn.find({})).toHaveLength(1);
      },
    );
  },
);
