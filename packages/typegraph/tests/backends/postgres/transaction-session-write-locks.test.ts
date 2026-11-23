/**
 * TWO TRANSACTIONS NEVER SHARE A HELD GRAPH WRITE LOCK.
 *
 * Write frames of one transaction session share the graph write lock a
 * still-running frame of that session holds or is acquiring
 * (`TransactionSession.heldGraphWriteLocks`). Frames of two different
 * transactions must not: each transaction takes the lock itself, so the
 * second one waits for the first to commit. A lock map shared across sessions
 * (keyed by graph id alone) would let the second transaction skip its
 * acquisition while the first still holds the lock, and write unfenced.
 *
 * That only shows while the two frames OVERLAP, which needs two connections:
 * on one connection the transactions serialize and the first frame clears its
 * entry before the second starts. So the holder's frame is parked mid-write,
 * after it took the lock: a third connection inserts the row id the holder
 * creates and keeps its transaction open, so the holder's INSERT waits on the
 * unique key. Only then does the contender start its create on its own
 * connection. With per-session state the contender takes the lock itself and
 * is observed waiting on the holder's connection; with shared state it would
 * take no lock and settle while the holder is still parked.
 *
 * MUTATION CHECK, verified and reverted: `runInWriteTransactionAttempt`
 * reading `held` from one module-level `Map` instead of the frame's session
 * fails this case (the contender settles, and the lock is taken once).
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createStore, defineGraph, defineNode } from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { createGate } from "../../concurrency-utils";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";
import { poolApplicationName } from "./held-transaction-race";
import { runServerSuiteSetup } from "./server-suite-setup";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const Task = defineNode("Task", { schema: z.object({ name: z.string() }) });

const graph = defineGraph({
  id: "session_write_locks_server",
  nodes: { Task: { type: Task } },
  edges: {},
});

const GRAPH_WRITE_FENCE_NAMESPACE = "typegraph:recorded-graph-write";
const HOLDER = "tg_session_locks_holder";
const CONTENDER = "tg_session_locks_contender";
const BLOCKER = "tg_session_locks_blocker";
const DEADLINE_MS = 5000;
const POLL_INTERVAL_MS = 10;

type Pools = Readonly<{
  holder: Pool;
  contender: Pool;
  blocker: Pool;
  probe: Pool;
}>;

let pools: Pools | undefined;

function requirePools(): Pools {
  if (pools === undefined) {
    throw new Error(
      "transaction-session-write-locks: PostgreSQL connections are unavailable after setup reported success.",
    );
  }
  return pools;
}

function createPool(applicationName: string | undefined): Pool {
  return new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
    max: 2,
    ...(applicationName === undefined ?
      {}
    : poolApplicationName(applicationName)),
  });
}

beforeAll(async () => {
  if (!process.env["POSTGRES_URL"]) return;
  const candidate = {
    holder: createPool(HOLDER),
    contender: createPool(CONTENDER),
    blocker: createPool(BLOCKER),
    probe: createPool(undefined),
  };
  await runServerSuiteSetup(
    "transaction-session-write-locks",
    Object.values(candidate),
    async () => {
      await candidate.probe.query(generatePostgresMigrationSQL());
      pools = candidate;
    },
  );
});

afterAll(async () => {
  if (pools === undefined) return;
  await Promise.all(Object.values(pools).map((pool) => pool.end()));
});

beforeEach(async () => {
  if (pools === undefined) return;
  await pools.probe.query(
    "TRUNCATE typegraph_node_uniques, typegraph_edges, typegraph_nodes",
  );
});

/** Counts the graph-write-lock statements issued through one connection. */
function lockCountingBackend(pool: Pool) {
  const counter = { acquisitions: 0 };
  const backend = createPostgresBackend(
    drizzle(pool, {
      logger: {
        logQuery(query: string, params: unknown[]): void {
          if (
            query.includes("pg_advisory_xact_lock") &&
            params.includes(GRAPH_WRITE_FENCE_NAMESPACE)
          ) {
            counter.acquisitions += 1;
          }
        },
      },
    }),
    { vector: false },
  );
  return { backend, counter };
}

/** Whether a backend of `waiter` waits on a lock a backend of `blocker` holds. */
async function isWaitingOn(
  probe: Pool,
  waiter: string,
  blocker: string,
): Promise<boolean> {
  const result = await probe.query<{ waiting: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_stat_activity AS waiting_backend
       JOIN pg_stat_activity AS blocking_backend
         ON blocking_backend.pid = ANY (pg_blocking_pids(waiting_backend.pid))
       WHERE waiting_backend.datname = current_database()
         AND waiting_backend.application_name = $1
         AND waiting_backend.wait_event_type = 'Lock'
         AND blocking_backend.application_name = $2
     ) AS waiting`,
    [waiter, blocker],
  );
  return result.rows[0]?.waiting === true;
}

/**
 * Polls until `waiter` is observed waiting on `blocker` ("waiting") or
 * `operation` settles first ("settled").
 */
async function waitingOrSettled(
  probe: Pool,
  waiter: string,
  blocker: string,
  operation: Promise<unknown>,
): Promise<"waiting" | "settled"> {
  const state = { settled: false };
  void operation.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    if (state.settled) return "settled";
    if (await isWaitingOn(probe, waiter, blocker)) return "waiting";
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(
    `${waiter} neither settled nor waited on ${blocker} within ${String(DEADLINE_MS)}ms.`,
  );
}

class BlockerRollback extends Error {}

describe.runIf(process.env["POSTGRES_URL"])(
  "held graph write locks across two transactions (PostgreSQL)",
  () => {
    it("are taken by each transaction while the other's frame still holds one", async () => {
      const { holder, contender, blocker, probe } = requirePools();
      const holderSide = lockCountingBackend(holder);
      const contenderSide = lockCountingBackend(contender);
      const holderStore = createStore(graph, holderSide.backend, {
        revisionTracking: true,
      });
      const contenderStore = createStore(graph, contenderSide.backend, {
        revisionTracking: true,
      });
      // Takes no graph write lock (no revision tracking): it only holds the
      // row id the holder creates, so the holder's INSERT waits on it.
      const blockerStore = createStore(
        graph,
        createPostgresBackend(drizzle(blocker), { vector: false }),
      );

      const inserted = createGate();
      const release = createGate();
      const blockerDone = blockerStore
        .transaction(async (tx) => {
          await tx.nodes.Task.create({ name: "blocker" }, { id: "held" });
          inserted.open();
          await release.opened;
          throw new BlockerRollback(
            "roll back so the holder's INSERT proceeds",
          );
        })
        .catch((error: unknown) => {
          if (!(error instanceof BlockerRollback)) throw error;
        });
      await inserted.opened;

      try {
        // The holder opens its own transaction, takes the graph lock, and
        // parks at its INSERT on the blocker's uncommitted row.
        const holderWrite = holderStore.nodes.Task.create(
          { name: "holder" },
          { id: "held" },
        );
        expect(
          await waitingOrSettled(probe, HOLDER, BLOCKER, holderWrite),
        ).toBe("waiting");
        expect(holderSide.counter.acquisitions).toBe(1);

        // The holder's frame is still running and holds the graph lock. The
        // contender's transaction must take the lock itself, and so wait for
        // the holder's transaction.
        const contenderWrite = contenderStore.nodes.Task.create({
          name: "contender",
        });
        const contenderState = await waitingOrSettled(
          probe,
          CONTENDER,
          HOLDER,
          contenderWrite,
        );

        release.open();
        await blockerDone;
        await holderWrite;
        await contenderWrite;

        expect(contenderState).toBe("waiting");
        expect(contenderSide.counter.acquisitions).toBe(1);
        expect(await holderStore.nodes.Task.count()).toBe(2);
      } finally {
        release.open();
        await blockerDone;
      }
    });
  },
);
