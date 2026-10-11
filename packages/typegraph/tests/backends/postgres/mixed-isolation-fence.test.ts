/**
 * Lock-only fence decisions under MIXED transaction isolation on a real
 * PostgreSQL server.
 *
 * A reachability probe, a composition-cycle probe and a merge's re-validation
 * are all reads with no claim row behind them: the per-graph write fence is
 * the only thing that makes them true at commit. A lock alone cannot do that
 * for a session whose snapshot predates the fence — a `SERIALIZABLE` or
 * `REPEATABLE READ` transaction that read anything before a concurrent
 * `READ COMMITTED` writer committed keeps reading the graph as it was, however
 * long it then waits for the lock, and PostgreSQL's serialization-failure
 * detection only arbitrates serializable transactions against EACH OTHER.
 *
 * Every case here drives that exact sequence deterministically, with two real
 * connections and no timing: the stale session takes its snapshot, the
 * read-committed writer commits one half of a cycle, and only then does the
 * stale session attempt the other half. Every writer that makes such a
 * decision advances the graph's fence row, so the stale session fails on that
 * row with a serialization failure instead of deciding on the graph it can no
 * longer see.
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStore,
  createStore,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  EdgeAcyclicityError,
  partOf,
  type Store,
  TransactionConflictError,
} from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { createLocalSqliteBackend } from "../../../src/backend/sqlite/local";
import type {
  GraphBackend,
  TransactionOptions,
} from "../../../src/backend/types";
import { branch } from "../../../src/graph-merge/branch";
import { BaseVersionMismatchError } from "../../../src/graph-merge/errors";
import { merge } from "../../../src/graph-merge/merge";
import { isErr, unwrap } from "../../../src/graph-merge/result";
import { asBranchId } from "../../../src/graph-merge/types";
import { sql as fragment } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { requireDefined } from "../../../src/utils/presence";
import { isSerializationFailure } from "../../../src/utils/sql-errors";
import { createGate } from "../../concurrency-utils";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";
import { runServerSuiteSetup } from "./server-suite-setup";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const STALE_ISOLATION_LEVELS = ["serializable", "repeatable_read"] as const;
type StaleIsolationLevel = (typeof STALE_ISOLATION_LEVELS)[number];

/** A writer holds the fence while the stale session parks on it. */
const CONTENTION_TIMEOUT_MS = 20_000;
const FENCE_WAIT_POLL_MS = 20;

const Task = defineNode("Task", { schema: z.object({ name: z.string() }) });
const dependsOn = defineEdge("dependsOn", { schema: z.object({}) });

/** A standalone `acyclic: true` relation: one edge kind, no composition. */
const acyclicGraph = defineGraph({
  id: "mixed-isolation-acyclic",
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

const assignedTo = defineEdge("assignedTo", { schema: z.object({}) });
const blocks = defineEdge("blocks", { schema: z.object({}) });

/**
 * An acyclic relation beside constraints that name another fence reason:
 * `assignedTo` is fenced for its cardinality alone and decides nothing under
 * the lock, and `blocks` is acyclic but names its cardinality.
 */
const layeredGraph = defineGraph({
  id: "mixed-isolation-layered",
  nodes: { Task: { type: Task } },
  edges: {
    dependsOn: { type: dependsOn, from: [Task], to: [Task], acyclic: true },
    assignedTo: {
      type: assignedTo,
      from: [Task],
      to: [Task],
      cardinality: "one",
    },
    blocks: {
      type: blocks,
      from: [Task],
      to: [Task],
      cardinality: "one",
      acyclic: true,
    },
  },
});

const Assembly = defineNode("Assembly", {
  schema: z.object({ name: z.string() }),
});
const containedIn = defineEdge("containedIn", { schema: z.object({}) });

/** A reflexive composition: an assembly is part of at most one assembly. */
const compositionGraph = defineGraph({
  id: "mixed-isolation-composition",
  nodes: { Assembly: { type: Assembly } },
  edges: {
    containedIn: {
      type: containedIn,
      from: [Assembly],
      to: [Assembly],
      cardinality: "one",
    },
  },
  ontology: [
    partOf(Assembly, Assembly, { via: containedIn, partSide: "from" }),
  ],
});

let stalePool: Pool | undefined;
let writerPool: Pool | undefined;
let staleDb: NodePgDatabase | undefined;
let writerDb: NodePgDatabase | undefined;

function requirePostgres(): Readonly<{
  stale: NodePgDatabase;
  writer: NodePgDatabase;
}> {
  if (staleDb === undefined || writerDb === undefined) {
    throw new Error(
      "mixed-isolation-fence: PostgreSQL connections are unavailable after setup reported success.",
    );
  }
  return { stale: staleDb, writer: writerDb };
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
  const stale = createPool();
  const writer = createPool();
  await runServerSuiteSetup(
    "mixed-isolation-fence",
    [stale, writer],
    async () => {
      await stale.query(generatePostgresMigrationSQL());
      await writer.query("SELECT 1");
      stalePool = stale;
      writerPool = writer;
      staleDb = drizzle(stale);
      writerDb = drizzle(writer);
    },
  );
});

afterAll(async () => {
  if (stalePool !== undefined) await stalePool.end();
  if (writerPool !== undefined) await writerPool.end();
});

beforeEach(async () => {
  if (stalePool === undefined) return;
  await stalePool.query(
    `TRUNCATE typegraph_edges, typegraph_nodes, typegraph_node_uniques,
              typegraph_schema_versions, typegraph_recorded_clock,
              typegraph_revision_origins`,
  );
});

async function cycleViolations(
  store: Pick<Store<typeof acyclicGraph>, "verifyConstraintFences">,
): Promise<readonly unknown[]> {
  const violations = await store.verifyConstraintFences();
  return violations.filter(
    (violation) => violation.family === "edgeAcyclicity",
  );
}

/**
 * The failure a caller-owned transaction sees when its snapshot predates the
 * fence: typed, and still classified as a serialization failure so a caller's
 * own retry loop recognizes it.
 */
function expectStaleSnapshotConflict(error: unknown): void {
  expect(error).toBeInstanceOf(TransactionConflictError);
  expect(isSerializationFailure(error)).toBe(true);
}

/**
 * Resolves once some session of THIS database is parked waiting for an
 * advisory lock. `pg_locks` is cluster-wide, so the database filter keeps a
 * suite running against another database from answering for this one.
 */
async function untilSessionWaitsOnFence(observer: Pool): Promise<void> {
  for (;;) {
    const { rows } = await observer.query<{ waiting: string }>(
      `SELECT count(*) AS waiting
       FROM pg_locks
       WHERE locktype = 'advisory'
         AND NOT granted
         AND database = (
           SELECT oid FROM pg_database WHERE datname = current_database()
         )`,
    );
    if (Number(rows[0]?.waiting) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, FENCE_WAIT_POLL_MS));
  }
}

/**
 * A backend whose every transaction runs at `isolationLevel`, counting the
 * transactions it opens — a deployment whose `default_transaction_isolation`
 * is a snapshot isolation, with the store none the wiser.
 */
function atIsolation(
  backend: GraphBackend,
  isolationLevel: StaleIsolationLevel,
): Readonly<{ backend: GraphBackend; opened: () => number }> {
  let opened = 0;
  return {
    backend: deriveBackend(backend, {
      transaction: (run, options) => {
        opened += 1;
        return backend.transaction(run, { ...options, isolationLevel });
      },
    }),
    opened: () => opened,
  };
}

/**
 * The merge commit of a store without recorded capture asks for
 * `SERIALIZABLE`. This pins the level under test onto that one transaction
 * and leaves every other transaction the merge opens as it asked for it.
 */
function mergeCommitOptionsAt(
  isolationLevel: StaleIsolationLevel,
  options: TransactionOptions | undefined,
): TransactionOptions | undefined {
  return options?.isolationLevel === "serializable" ?
      { ...options, isolationLevel }
    : options;
}

async function rejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the stale session's write to be refused.");
}

describe.runIf(process.env["POSTGRES_URL"])(
  "lock-only fence decisions under mixed isolation (PostgreSQL)",
  () => {
    describe.each(STALE_ISOLATION_LEVELS)(
      "a %s session whose snapshot predates a read-committed writer",
      (isolationLevel: StaleIsolationLevel) => {
        it("cannot close a cycle in a standalone acyclic edge kind", async () => {
          const live = requirePostgres();
          const staleStore = createStore(
            acyclicGraph,
            createPostgresBackend(live.stale),
          );
          const writerStore = createStore(
            acyclicGraph,
            createPostgresBackend(live.writer),
          );
          const a = await writerStore.nodes.Task.create(
            { name: "a" },
            { id: "a" },
          );
          const b = await writerStore.nodes.Task.create(
            { name: "b" },
            { id: "b" },
          );

          const error = await rejection(
            staleStore.transaction(
              async (tx) => {
                // Any read pins the snapshot for the rest of the transaction.
                await tx.nodes.Task.getById(a.id);
                await writerStore.edges.dependsOn.create(a, b);
                await tx.edges.dependsOn.create(b, a);
              },
              { isolationLevel },
            ),
          );

          expectStaleSnapshotConflict(error);
          expect(await writerStore.edges.dependsOn.find({})).toHaveLength(1);
          expect(await cycleViolations(writerStore)).toEqual([]);
        });

        it("cannot close a cycle through an edge kind whose named constraint is its cardinality", async () => {
          const live = requirePostgres();
          // Neither frame names acyclicity, so neither takes the fence in its
          // deciding form: the acyclicity probe itself advances the fence row
          // on both sides.
          const staleStore = createStore(
            layeredGraph,
            createPostgresBackend(live.stale),
          );
          const writerStore = createStore(
            layeredGraph,
            createPostgresBackend(live.writer),
          );
          const a = await writerStore.nodes.Task.create(
            { name: "a" },
            { id: "a" },
          );
          const b = await writerStore.nodes.Task.create(
            { name: "b" },
            { id: "b" },
          );

          const error = await rejection(
            staleStore.transaction(
              async (tx) => {
                await tx.nodes.Task.getById(a.id);
                await writerStore.edges.blocks.create(a, b);
                await tx.edges.blocks.create(b, a);
              },
              { isolationLevel },
            ),
          );

          expectStaleSnapshotConflict(error);
          expect(await writerStore.edges.blocks.find({})).toHaveLength(1);
          expect(await cycleViolations(writerStore)).toEqual([]);
        });

        it("cannot close a cycle when each transaction took the fence for a write that decided nothing", async () => {
          const live = requirePostgres();
          const staleStore = createStore(
            layeredGraph,
            createPostgresBackend(live.stale),
          );
          const writerStore = createStore(
            layeredGraph,
            createPostgresBackend(live.writer),
          );
          const a = await writerStore.nodes.Task.create(
            { name: "a" },
            { id: "a" },
          );
          const b = await writerStore.nodes.Task.create(
            { name: "b" },
            { id: "b" },
          );

          const error = await rejection(
            staleStore.transaction(
              async (tx) => {
                await tx.nodes.Task.getById(a.id);
                // The writer's fence is taken by its cardinality write, with
                // no fence-row advance; its acyclic write advances the row
                // behind the lock the transaction already holds.
                await writerStore.transaction(async (writerTx) => {
                  await writerTx.edges.assignedTo.create(a, b);
                  await writerTx.edges.dependsOn.create(a, b);
                });
                // Likewise here: the cardinality write takes the fence and
                // proceeds, and the acyclic write is the one refused.
                await tx.edges.assignedTo.create(b, a);
                await tx.edges.dependsOn.create(b, a);
              },
              { isolationLevel },
            ),
          );

          expectStaleSnapshotConflict(error);
          expect(await writerStore.edges.dependsOn.find({})).toHaveLength(1);
          expect(await writerStore.edges.assignedTo.find({})).toHaveLength(1);
          expect(await cycleViolations(writerStore)).toEqual([]);
        });

        it("cannot close a cycle when both writers take the fused schema + graph fence", async () => {
          const live = requirePostgres();
          // Schema-managed stores: a write that owes both fences takes them
          // in ONE statement, which must advance the same fence row the
          // portable acquisition does.
          const [staleStore] = await createStoreWithSchema(
            acyclicGraph,
            createPostgresBackend(live.stale),
          );
          const [writerStore] = await createStoreWithSchema(
            acyclicGraph,
            createPostgresBackend(live.writer),
          );
          const a = await writerStore.nodes.Task.create(
            { name: "a" },
            { id: "a" },
          );
          const b = await writerStore.nodes.Task.create(
            { name: "b" },
            { id: "b" },
          );

          const error = await rejection(
            staleStore.transaction(
              async (tx) => {
                await tx.nodes.Task.getById(a.id);
                await writerStore.edges.dependsOn.create(a, b);
                await tx.edges.dependsOn.create(b, a);
              },
              { isolationLevel },
            ),
          );

          expectStaleSnapshotConflict(error);
          expect(await writerStore.edges.dependsOn.find({})).toHaveLength(1);
          expect(await cycleViolations(writerStore)).toEqual([]);
        });

        it("cannot close a composition cycle", async () => {
          const live = requirePostgres();
          const staleStore = createStore(
            compositionGraph,
            createPostgresBackend(live.stale),
          );
          const writerStore = createStore(
            compositionGraph,
            createPostgresBackend(live.writer),
          );
          const a = await writerStore.nodes.Assembly.create(
            { name: "a" },
            { id: "a" },
          );
          const b = await writerStore.nodes.Assembly.create(
            { name: "b" },
            { id: "b" },
          );

          const error = await rejection(
            staleStore.transaction(
              async (tx) => {
                await tx.nodes.Assembly.getById(a.id);
                await writerStore.edges.containedIn.create(a, b);
                await tx.edges.containedIn.create(b, a);
              },
              { isolationLevel },
            ),
          );

          expectStaleSnapshotConflict(error);
          expect(await writerStore.edges.containedIn.find({})).toHaveLength(1);
          expect(await writerStore.verifyConstraintFences()).toEqual([]);
        });

        it("is told so with a typed conflict when the caller adopted its own transaction", async () => {
          const live = requirePostgres();
          const staleStore = createAdapterStore(
            acyclicGraph,
            createPostgresBackend(live.stale),
          );
          const writerStore = createStore(
            acyclicGraph,
            createPostgresBackend(live.writer),
          );
          const a = await writerStore.nodes.Task.create(
            { name: "a" },
            { id: "a" },
          );
          const b = await writerStore.nodes.Task.create(
            { name: "b" },
            { id: "b" },
          );

          // The driver's own transaction, adopted: nothing between the fence
          // and the caller translates the failure, so the fence itself must.
          const error = await rejection(
            live.stale.transaction(
              async (externalTransaction) => {
                const tx = staleStore.withTransaction(externalTransaction);
                await tx.nodes.Task.getById(a.id);
                await writerStore.edges.dependsOn.create(a, b);
                await tx.edges.dependsOn.create(b, a);
              },
              {
                isolationLevel:
                  isolationLevel === "serializable" ? "serializable" : (
                    "repeatable read"
                  ),
              },
            ),
          );

          expectStaleSnapshotConflict(error);
          expect(await writerStore.edges.dependsOn.find({})).toHaveLength(1);
          expect(await cycleViolations(writerStore)).toEqual([]);
        });

        it(
          "is replayed whole when the store owns the transaction, and then sees the winner",
          { timeout: CONTENTION_TIMEOUT_MS },
          async () => {
            const live = requirePostgres();
            const stale = atIsolation(
              createPostgresBackend(live.stale),
              isolationLevel,
            );
            const staleStore = createStore(acyclicGraph, stale.backend);
            const writerStore = createStore(
              acyclicGraph,
              createPostgresBackend(live.writer),
            );
            const a = await writerStore.nodes.Task.create(
              { name: "a" },
              { id: "a" },
            );
            const b = await writerStore.nodes.Task.create(
              { name: "b" },
              { id: "b" },
            );

            const holding = createGate();
            const release = createGate();
            const winner = writerStore.transaction(async (tx) => {
              await tx.edges.dependsOn.create(a, b);
              holding.open();
              await release.opened;
            });
            await holding.opened;

            // The store-owned write takes its snapshot in the statement that
            // then parks on the fence, so it is stale the moment the winner
            // commits.
            const openedBefore = stale.opened();
            const closing = rejection(staleStore.edges.dependsOn.create(b, a));
            await untilSessionWaitsOnFence(requireDefined(stalePool));
            release.open();
            await winner;

            // The first attempt fails on the fence row; the replay opens a
            // new transaction, reads the winner's edge and refuses the cycle.
            expect(await closing).toBeInstanceOf(EdgeAcyclicityError);
            expect(stale.opened() - openedBefore).toBe(2);
            expect(await writerStore.edges.dependsOn.find({})).toHaveLength(1);
            expect(await cycleViolations(writerStore)).toEqual([]);
          },
        );

        it("cannot commit a merge that closes a cycle", async () => {
          const live = requirePostgres();
          const local = createLocalSqliteBackend();
          const targetBackend = createPostgresBackend(live.stale);
          // Takes the merge commit's snapshot, then lets the read-committed
          // writer commit before the merge reads or writes anything.
          let afterSnapshot: (() => Promise<void>) | undefined;
          let commitsOpened = 0;
          const staleBackend = deriveBackend(targetBackend, {
            transaction: (run, options) => {
              const isMergeCommit = options?.isolationLevel === "serializable";
              if (isMergeCommit) commitsOpened += 1;
              return targetBackend.transaction(
                async (transaction) => {
                  const interleave = afterSnapshot;
                  if (interleave !== undefined && isMergeCommit) {
                    afterSnapshot = undefined;
                    await transaction.execute(
                      asCompiledRowsSql(fragment`SELECT 1`),
                    );
                    await interleave();
                  }
                  return run(transaction);
                },
                mergeCommitOptionsAt(isolationLevel, options),
              );
            },
          });
          try {
            const [target] = await createStoreWithSchema(
              acyclicGraph,
              staleBackend,
            );
            const [writerStore] = await createStoreWithSchema(
              acyclicGraph,
              createPostgresBackend(live.writer),
            );
            const a = await target.nodes.Task.create(
              { name: "a" },
              { id: "a" },
            );
            const b = await target.nodes.Task.create(
              { name: "b" },
              { id: "b" },
            );
            const source = unwrap(
              await branch(target, () => Promise.resolve(local.backend), {
                id: asBranchId("closes-the-cycle"),
              }),
            );
            await source.store.edges.dependsOn.create(b, a);

            afterSnapshot = async () => {
              await writerStore.edges.dependsOn.create(a, b);
            };
            const commitsBefore = commitsOpened;
            const merged = await merge(target, [source]);

            expect(afterSnapshot).toBeUndefined();
            // The stale commit fails on the fence row and is replayed in a
            // new transaction, which reads the writer's edge and refuses the
            // plan as stale. A refusal that never took the fence — an
            // isolation the fence does not support — opens one transaction
            // and is not this error.
            expect(commitsOpened - commitsBefore).toBe(2);
            expect(isErr(merged) ? merged.error : undefined).toBeInstanceOf(
              BaseVersionMismatchError,
            );
            expect(await writerStore.edges.dependsOn.find({})).toHaveLength(1);
            expect(await cycleViolations(writerStore)).toEqual([]);
          } finally {
            await local.backend.close();
          }
        });
      },
    );
  },
);
