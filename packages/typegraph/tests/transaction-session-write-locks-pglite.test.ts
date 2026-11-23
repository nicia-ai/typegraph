/**
 * WHERE A TRANSACTION'S HELD GRAPH WRITE LOCKS LIVE.
 *
 * Every write frame of one transaction binding shares the graph write lock a
 * still-running frame holds or is acquiring: a frame that starts while
 * another is taking the lock awaits that acquisition instead of issuing its
 * own. That state lives on the binding's transaction session
 * (`TransactionSession.heldGraphWriteLocks`), which the Store opens where it
 * opens or joins the transaction and hands down explicitly: the transaction
 * context's collections, its `tx.measure` scopes and its identity facade each
 * enter their operations from that one session.
 *
 * Asserted from the emitted SQL, on PGlite, where taking the lock is a
 * statement (`pg_advisory_xact_lock` in the graph-write namespace): writes
 * started together inside one transaction take it once, and writes that each
 * open their own transaction take it once each.
 *
 * MUTATION CHECKS, each verified and reverted:
 * - `runInWriteTransactionAttempt` keeping a frame-local map instead of the
 *   session's fails the three "takes the lock once" cases (two acquisitions).
 * - `#buildTransactionContext` handing the identity facade no session (its
 *   mutation then joins as a binding of its own) fails the identity case.
 * - `#attachMeasure`'s scoped surface built over a session of its own fails
 *   the measure case.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStore,
  createStore,
  defineGraph,
  defineNode,
} from "../src";
import { deriveBackend } from "../src/backend/derive-backend";
import type { TransactionBackend } from "../src/backend/types";
import {
  createRecordedPostgresStore,
  type LoggedStatement,
} from "./statement-recorder";

const Task = defineNode("Task", { schema: z.object({ name: z.string() }) });

const graph = defineGraph({
  id: "session_write_locks",
  nodes: { Task: { type: Task } },
  edges: {},
});

const identityGraph = defineGraph({
  id: "session_write_locks_identity",
  nodes: { Task: { type: Task } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

const GRAPH_WRITE_FENCE_NAMESPACE = "typegraph:recorded-graph-write";

/** The statements that take the per-graph write lock. */
function graphLockAcquisitions(
  statements: readonly LoggedStatement[],
): readonly LoggedStatement[] {
  return statements.filter(
    (statement) =>
      statement.query.includes("pg_advisory_xact_lock") &&
      statement.params.includes(GRAPH_WRITE_FENCE_NAMESPACE),
  );
}

async function revisionTrackedStore<G extends typeof graph>(target: G) {
  const recorded = await createRecordedPostgresStore(target);
  const store = createStore(target, recorded.backend, {
    revisionTracking: true,
  });
  return { ...recorded, store };
}

describe("a transaction's held graph write locks", () => {
  it("are taken once by writes started together inside one transaction", async () => {
    const { store, statements, reset } = await revisionTrackedStore(graph);
    reset();

    await store.transaction(async (tx) => {
      await Promise.all([
        tx.nodes.Task.create({ name: "a" }),
        tx.nodes.Task.create({ name: "b" }),
      ]);
    });

    expect(graphLockAcquisitions(statements)).toHaveLength(1);
    expect(await store.nodes.Task.count()).toBe(2);
  });

  it("are taken once by a write and a measured write started together", async () => {
    const { store, statements, reset } = await revisionTrackedStore(graph);
    reset();

    await store.transactionWithReceipt(async (tx) => {
      await Promise.all([
        tx.nodes.Task.create({ name: "a" }),
        tx.measure((scoped) => scoped.nodes.Task.create({ name: "b" })),
      ]);
    });

    expect(graphLockAcquisitions(statements)).toHaveLength(1);
  });

  it("are taken once by a node write and an identity mutation started together", async () => {
    const recorded = await createRecordedPostgresStore(identityGraph);
    const store = createStore(identityGraph, recorded.backend, {
      revisionTracking: true,
    });
    const a = await store.nodes.Task.create({ name: "a" });
    const b = await store.nodes.Task.create({ name: "b" });
    recorded.reset();

    await store.transaction(async (tx) => {
      await Promise.all([
        tx.nodes.Task.create({ name: "c" }),
        tx.identity.assertSame(
          { kind: "Task", id: a.id },
          { kind: "Task", id: b.id },
        ),
      ]);
    });

    expect(graphLockAcquisitions(recorded.statements)).toHaveLength(1);
  });

  // Two transactions on two connections, overlapping, are pinned on a server:
  // `tests/backends/postgres/transaction-session-write-locks.test.ts`. Here,
  // on one serial connection, this only pins one acquisition per transaction.
  it("are taken once by each write that opens its own transaction", async () => {
    const { store, statements, reset } = await revisionTrackedStore(graph);
    reset();

    await Promise.all([
      store.nodes.Task.create({ name: "a" }),
      store.nodes.Task.create({ name: "b" }),
    ]);

    expect(graphLockAcquisitions(statements)).toHaveLength(2);
  });
});

/**
 * THE ONE DELIBERATE DIFFERENCE: two adoptions of one native transaction are
 * two bindings, even when a custom adapter returns the same object for both.
 *
 * Held locks used to live in a `WeakMap` keyed by the transaction object, so
 * two transaction contexts built over one object shared them: a write of the
 * second context started while a write of the first was acquiring the lock
 * awaited that acquisition and took no lock itself. Object identity is not
 * evidence that the two are one native transaction (an adapter may hand out
 * one object for more than one), and skipping an acquisition on the strength
 * of another binding's is only right when they are. Each context now holds
 * its own session, as two Stores on one native transaction always have, and
 * each takes the lock: on one native transaction the second acquisition is
 * re-entrant and costs one statement.
 *
 * On the parent commit (held locks keyed by the object) this case sees one
 * acquisition, not two.
 */
describe("two adoptions of one native transaction through one object", () => {
  it("take the graph write lock once per transaction context", async () => {
    const recorded = await createRecordedPostgresStore(graph);
    const adopted = new WeakMap<object, TransactionBackend>();
    const backend = deriveBackend(recorded.backend, {
      adoptTransaction: (nativeTransaction) => {
        const existing = adopted.get(nativeTransaction);
        if (existing !== undefined) return existing;
        const created = recorded.backend.adoptTransaction(nativeTransaction);
        adopted.set(nativeTransaction, created);
        return created;
      },
    });
    const store = createAdapterStore(graph, backend, {
      revisionTracking: true,
    });
    recorded.reset();

    await recorded.backend.transactionWithNative(async (_tx, native) => {
      const first = store.withTransaction(native);
      const second = store.withTransaction(native);
      await Promise.all([
        first.nodes.Task.create({ name: "a" }),
        second.nodes.Task.create({ name: "b" }),
      ]);
    });

    expect(graphLockAcquisitions(recorded.statements)).toHaveLength(2);
    expect(await store.nodes.Task.count()).toBe(2);
  });
});
