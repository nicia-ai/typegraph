/**
 * TypeGraph-owned savepoint scopes against overlapping calls on one
 * transaction, on every backend.
 *
 * A savepoint's rollback undoes every statement issued on the session since
 * the savepoint was taken, whoever issued it. Two batch calls started inside
 * one `store.transaction()` callback without awaiting each other would
 * otherwise share one rollback boundary: the first call's caught failure
 * would roll back the second call's completed, successfully reported writes.
 *
 * Each case names, in a comment, the mutation that must make it fail.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  type GraphBackend,
} from "../../../src";
import { statementExecutionVerdict } from "../../../src/backend/capabilities/resolve";
import {
  deriveBackend,
  projectBackendWithout,
} from "../../../src/backend/derive-backend";
import { nextParkedSessionUnit } from "../../../src/backend/session-exclusivity";
import {
  type HardDeleteEdgeParams,
  type TransactionBackend,
} from "../../../src/backend/types";
import { UnsupportedBackendCapabilityError } from "../../../src/errors-entry";
import { MergePlanCapabilityError, unwrap } from "../../../src/graph-merge";
import { branch } from "../../../src/graph-merge/branch";
import {
  applyMergePlanInTransaction,
  planMerge,
} from "../../../src/graph-merge/merge";
import { asBranchId } from "../../../src/graph-merge/types";
import { runRecordedTransactionSavepoint } from "../../../src/store/recorded-capture";
import { transactionBackend } from "../../../src/store/runtime-port";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationTestContext } from "./test-context";

const SpoPerson = defineNode("SpoPerson", {
  schema: z.object({ name: z.string() }),
});
const spoFollows = defineEdge("spoFollows", { schema: z.object({}) });

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: { SpoPerson: { type: SpoPerson } },
    edges: {
      spoFollows: { type: spoFollows, from: [SpoPerson], to: [SpoPerson] },
    },
  });
}

let graphIdCounter = 0;
function nextGraphId(): string {
  graphIdCounter += 1;
  return `savepoint_overlap_${graphIdCounter}`;
}

class InjectedOverlapFailure extends Error {}

type Deferred = Readonly<{ promise: Promise<void>; resolve: () => void }>;

function deferred(): Deferred {
  const resolvers: (() => void)[] = [];
  const promise = new Promise<void>((resolvePromise) => {
    resolvers.push(resolvePromise);
  });
  return {
    promise,
    resolve: () => {
      for (const resolvePromise of resolvers) resolvePromise();
    },
  };
}

/**
 * The lane's backend without `hardDeleteEdgesBatch`, so `bulkHardDelete`
 * removes each edge through `hardDeleteEdge`. The delete of `pausedId` runs,
 * then signals `deleted` and waits for `release` before throwing — so the
 * statement has landed inside its call's savepoint when the call fails.
 */
function pausingHardDelete(
  backend: GraphBackend,
  pausedId: string,
): Readonly<{
  backend: GraphBackend;
  deleted: Promise<void>;
  release: () => void;
}> {
  const deleted = deferred();
  const release = deferred();
  function strip<T extends GraphBackend | TransactionBackend>(
    target: T,
  ): Omit<T, "hardDeleteEdgesBatch"> {
    const stripped = projectBackendWithout(target, ["hardDeleteEdgesBatch"]);
    return deriveBackend(stripped, {
      async hardDeleteEdge(params: HardDeleteEdgeParams): Promise<boolean> {
        const removed = await target.hardDeleteEdge(params);
        if (params.id !== pausedId) return removed;
        deleted.resolve();
        await release.promise;
        throw new InjectedOverlapFailure();
      },
    } as never);
  }
  const derived: GraphBackend = deriveBackend(strip(backend) as GraphBackend, {
    transaction: (fn, options) =>
      backend.transaction((tx) => fn(strip(tx) as TransactionBackend), options),
  });
  return {
    backend: derived,
    deleted: deleted.promise,
    release: release.resolve,
  };
}

/**
 * Resolves once the overlapping call is provably parked in the session's turn
 * order (`parked`), or once it has settled without parking — the defect the
 * cases guard. Releasing the failing scope only after this point means a
 * sibling that did not wait has already issued its writes inside the scope.
 */
function parkedOrSettled(
  parked: Promise<void>,
  call: Promise<unknown>,
): Promise<void> {
  return Promise.race([parked, call.then(ignore, ignore)]);
}

function ignore(): void {
  return;
}

async function seed(context: IntegrationTestContext) {
  const graph = buildGraph(nextGraphId());
  const store = await context.createStore(graph);
  const people = [];
  for (const id of ["p1", "p2", "p3", "p4"]) {
    people.push(await store.nodes.SpoPerson.create({ name: id }, { id }));
  }
  const [p1, p2, p3, p4] = people.map((person) => requireDefined(person));
  const follows = store.edges.spoFollows;
  await follows.create(
    requireDefined(p1),
    requireDefined(p2),
    {},
    { id: "a1" },
  );
  await follows.create(
    requireDefined(p2),
    requireDefined(p3),
    {},
    { id: "b1" },
  );
  await follows.create(
    requireDefined(p3),
    requireDefined(p4),
    {},
    { id: "c1" },
  );
  return { graph, store };
}

export function registerSavepointOverlapIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("savepoint scopes and overlapping calls on one transaction", () => {
    it("keeps a sibling call's completed writes when an overlapping call's failure is caught", async () => {
      const { graph, store } = await seed(context);
      const pausing = pausingHardDelete(store.backend, "a1");
      const pausingStore = createStore(graph, pausing.backend);

      const outcome = await pausingStore.transaction(async (tx) => {
        const callA = tx.edges.spoFollows.bulkHardDelete(["a1"] as never).then(
          () => "resolved" as const,
          (error: unknown) => error,
        );
        // Start B only once A's delete has landed and A is still open.
        await Promise.race([pausing.deleted, callA]);
        const parked = nextParkedSessionUnit(transactionBackend(tx));
        const callB = tx.edges.spoFollows.bulkHardDelete(["b1"] as never);
        const parkedB = parkedOrSettled(parked, callB);
        // Fail A only once B is provably parked behind A's scope, or has
        // finished without waiting (the defect this case guards).
        await parkedB;
        pausing.release();
        const [errorA] = await Promise.all([callA, callB]);
        return errorA;
      });

      expect(outcome).toBeInstanceOf(InjectedOverlapFailure);
      // A failed: its delete is rolled back with its savepoint.
      expect(await store.backend.getEdge(store.graphId, "a1")).toBeDefined();
      // B reported success: its delete must survive A's rollback.
      expect(await store.backend.getEdge(store.graphId, "b1")).toBeUndefined();
      expect(await store.backend.getEdge(store.graphId, "c1")).toBeDefined();
    });
    // MUTATION CHECK: make `withSavepointState` and
    // `runOptionallyInTransaction` run their unit without
    // `withExclusiveSessionUse` — B's delete lands inside A's savepoint and
    // A's rollback removes it after B resolved.

    it("keeps a sibling plain write issued while another call's savepoint scope is open", async () => {
      const { graph, store } = await seed(context);
      const pausing = pausingHardDelete(store.backend, "a1");
      const pausingStore = createStore(graph, pausing.backend);

      const outcome = await pausingStore.transaction(async (tx) => {
        const callA = tx.edges.spoFollows.bulkHardDelete(["a1"] as never).then(
          () => "resolved" as const,
          (error: unknown) => error,
        );
        await Promise.race([pausing.deleted, callA]);
        const parked = nextParkedSessionUnit(transactionBackend(tx));
        const callB = tx.nodes.SpoPerson.create(
          { name: "late" },
          { id: "late" },
        );
        const parkedB = parkedOrSettled(parked, callB);
        await parkedB;
        pausing.release();
        const [errorA] = await Promise.all([callA, callB]);
        return errorA;
      });

      expect(outcome).toBeInstanceOf(InjectedOverlapFailure);
      expect(await store.backend.getEdge(store.graphId, "a1")).toBeDefined();
      expect(
        await store.backend.getNode(store.graphId, "SpoPerson", "late"),
      ).toBeDefined();
    });
    // MUTATION CHECK: run the transaction-session branch of
    // `runOptionallyInTransaction` without `withExclusiveSessionUse` — the
    // create is not a savepoint scope, so only its write frame can wait, and
    // without the wait A's rollback removes the node B created.

    it("keeps a sibling write that overlaps a savepoint scope opened outside any write frame", async () => {
      // The shape of an adopted merge apply: the scope is opened directly in
      // the callback, and the rows it writes are nested calls inside it.
      const { graph, store } = await seed(context);
      const scopeStore = createStore(graph, store.backend);
      const verdict = statementExecutionVerdict(store.backend);
      if (!verdict.supported)
        throw new Error("Lane lacks statement execution.");
      const opened = deferred();
      const release = deferred();

      const outcome = await scopeStore.transaction(async (tx) => {
        const scope = runRecordedTransactionSavepoint(
          transactionBackend(tx),
          verdict,
          "test_overlap_scope",
          async () => {
            await tx.nodes.SpoPerson.create({ name: "in" }, { id: "in" });
            opened.resolve();
            await release.promise;
            return {
              action: "rollback",
              value: "rolled-back",
              cause: new InjectedOverlapFailure(),
            } as const;
          },
        );
        await Promise.race([opened.promise, scope]);
        const parked = nextParkedSessionUnit(transactionBackend(tx));
        const sibling = tx.nodes.SpoPerson.create(
          { name: "out" },
          { id: "out" },
        );
        const parkedSibling = parkedOrSettled(parked, sibling);
        await parkedSibling;
        release.resolve();
        const [value] = await Promise.all([scope, sibling]);
        return value;
      });

      expect(outcome).toBe("rolled-back");
      // The nested create ran inside the scope and went with its rollback.
      expect(
        await store.backend.getNode(store.graphId, "SpoPerson", "in"),
      ).toBeUndefined();
      expect(
        await store.backend.getNode(store.graphId, "SpoPerson", "out"),
      ).toBeDefined();
    });
    // MUTATION CHECK: drop `withExclusiveSessionUse` from
    // `withSavepointState` — no write frame encloses this scope, so the
    // sibling create runs while it is open and its rollback removes "out".

    it("runs calls nested inside a savepoint scope inside it, without waiting for it", async () => {
      const { graph, store } = await seed(context);
      const scopeStore = createStore(graph, store.backend);
      const verdict = statementExecutionVerdict(store.backend);
      if (!verdict.supported)
        throw new Error("Lane lacks statement execution.");
      const timedOut = Symbol("timed out");

      const outcome = await scopeStore.transaction(async (tx) => {
        const scope = runRecordedTransactionSavepoint(
          transactionBackend(tx),
          verdict,
          "test_nested_scope",
          async () => {
            // A plain write, and a batch call that opens a write frame and a
            // savepoint scope of its own, both overlapping inside the scope.
            await Promise.all([
              tx.nodes.SpoPerson.create({ name: "n" }, { id: "nested" }),
              tx.edges.spoFollows.bulkHardDelete(["c1"] as never),
            ]);
            return { action: "release", value: "released" } as const;
          },
        );
        return Promise.race([
          scope,
          new Promise<typeof timedOut>((resolve) =>
            setTimeout(() => {
              resolve(timedOut);
            }, 2000),
          ),
        ]);
      });

      expect(outcome).toBe("released");
      expect(
        await store.backend.getNode(store.graphId, "SpoPerson", "nested"),
      ).toBeDefined();
      expect(await store.backend.getEdge(store.graphId, "c1")).toBeUndefined();
    });
    // MUTATION CHECK: make `withExclusiveSessionUse` always queue on the
    // session's top-level turn order, ignoring the holder it runs inside —
    // the nested calls wait for the scope that awaits them, and the race
    // resolves to the timeout.

    it("keeps an earlier unit's recorded history when a savepoint queued behind it rolls back", async () => {
      const graph = buildGraph(nextGraphId());
      const store = await context.createHistoryStore(graph);
      const verdict = statementExecutionVerdict(context.getBackend());
      if (!verdict.supported)
        throw new Error("Lane lacks statement execution.");
      const gate = deferred();

      const { receipt } = await store.transactionWithReceipt(async (tx) => {
        // The earlier unit holds the session and writes only after the
        // later scope has been called.
        const earlier = runRecordedTransactionSavepoint(
          transactionBackend(tx),
          verdict,
          "test_earlier_unit",
          async () => {
            await gate.promise;
            await tx.nodes.SpoPerson.create({ name: "kept" }, { id: "kept" });
            return { action: "release", value: undefined } as const;
          },
        );
        const later = runRecordedTransactionSavepoint(
          transactionBackend(tx),
          verdict,
          "test_later_scope",
          () =>
            Promise.resolve({
              action: "rollback",
              value: undefined,
              cause: new InjectedOverlapFailure(),
            } as const),
        );
        gate.resolve();
        await Promise.all([earlier, later]);
      });

      expect(
        await store.backend.getNode(store.graphId, "SpoPerson", "kept"),
      ).toBeDefined();
      // The committed create allocated a recorded revision: the later scope's
      // rollback did not restore a capture checkpoint taken before it.
      expect(receipt.recorded).toBeDefined();
    });
    // MUTATION CHECK: take the capture and graph-lock checkpoint in
    // `runRecordedTransactionSavepoint` before `withSavepointState` instead of
    // inside it — the rollback restores the empty capture taken before the
    // earlier unit wrote, and the transaction records no revision.

    it("queues a heterogeneous upsert batch behind an open savepoint scope", async () => {
      const graph = buildGraph(nextGraphId());
      const store = await context.createHistoryStore(graph);
      const verdict = statementExecutionVerdict(context.getBackend());
      if (!verdict.supported)
        throw new Error("Lane lacks statement execution.");
      const opened = deferred();
      const release = deferred();

      const outcome = await store.transaction(async (tx) => {
        if (transactionBackend(tx).upsertHeterogeneousNodes === undefined) {
          // A declared gap of this lane: the batch is refused outright.
          return tx
            .writeNodeUpsertBatch([
              { kind: "SpoPerson", id: "u" as never, props: { name: "u" } },
            ])
            .then(
              () => "accepted" as const,
              (error: unknown) => error,
            );
        }
        const scope = runRecordedTransactionSavepoint(
          transactionBackend(tx),
          verdict,
          "test_upsert_overlap_scope",
          async () => {
            opened.resolve();
            await release.promise;
            return {
              action: "rollback",
              value: "rolled-back",
              cause: new InjectedOverlapFailure(),
            } as const;
          },
        );
        await Promise.race([opened.promise, scope]);
        const parked = nextParkedSessionUnit(transactionBackend(tx));
        const batch = tx.writeNodeUpsertBatch([
          { kind: "SpoPerson", id: "upserted" as never, props: { name: "u" } },
        ]);
        await parkedOrSettled(parked, batch);
        release.resolve();
        const [value] = await Promise.all([scope, batch]);
        return value;
      });

      const supported = outcome === "rolled-back";
      expect(
        supported ? outcome : (
          outcome instanceof UnsupportedBackendCapabilityError
        ),
      ).toBe(supported ? "rolled-back" : true);
      const upserted = await store.backend.getNode(
        store.graphId,
        "SpoPerson",
        "upserted",
      );
      expect(upserted !== undefined).toBe(supported);
    });
    // MUTATION CHECK: build `tx.writeNodeUpsertBatch` without
    // `withSessionTurn` — the batch writes inside the open scope and the
    // scope's rollback removes the node it reported.

    it("decides an edge delete only once its turn comes", async () => {
      const { graph, store } = await seed(context);
      const pausing = pausingHardDelete(store.backend, "a1");
      const pausingStore = createStore(graph, pausing.backend);

      const outcome = await pausingStore.transaction(async (tx) => {
        const callA = tx.edges.spoFollows.bulkHardDelete(["a1"] as never).then(
          () => "resolved" as const,
          (error: unknown) => error,
        );
        await Promise.race([pausing.deleted, callA]);
        // A has removed a1 inside its scope; B's lookup must not see that.
        const parked = nextParkedSessionUnit(transactionBackend(tx));
        const callB = tx.edges.spoFollows.delete("a1" as never);
        await parkedOrSettled(parked, callB);
        pausing.release();
        const [errorA] = await Promise.all([callA, callB]);
        return errorA;
      });

      expect(outcome).toBeInstanceOf(InjectedOverlapFailure);
      // A rolled back, so a1 is back; B's delete then tombstoned it.
      const a1 = await store.backend.getEdge(store.graphId, "a1");
      expect(a1).toBeDefined();
      expect(a1?.deleted_at).toBeDefined();
    });
    // MUTATION CHECK: create collections without the per-call
    // `withSessionTurn` wrapper — `delete` looks the edge up while A's
    // scope has it removed, returns without writing, and A's rollback leaves
    // the edge live.

    it("takes a continuation that outlived its holder through the turn order that is live", async () => {
      const { graph, store } = await seed(context);
      const pausing = pausingHardDelete(store.backend, "a1");
      const pausingStore = createStore(graph, pausing.backend);
      const verdict = statementExecutionVerdict(store.backend);
      if (!verdict.supported)
        throw new Error("Lane lacks statement execution.");
      const resume = deferred();

      const outcome = await pausingStore.transaction(async (tx) => {
        let continuation: Promise<unknown> | undefined;
        await runRecordedTransactionSavepoint(
          transactionBackend(tx),
          verdict,
          "test_finished_holder",
          () => {
            // Scheduled inside this holder, run after it has finished.
            continuation = resume.promise.then(() =>
              tx.nodes.SpoPerson.create({ name: "c" }, { id: "continued" }),
            );
            return Promise.resolve({
              action: "release",
              value: undefined,
            } as const);
          },
        );
        const callA = tx.edges.spoFollows.bulkHardDelete(["a1"] as never).then(
          () => "resolved" as const,
          (error: unknown) => error,
        );
        await Promise.race([pausing.deleted, callA]);
        const parked = nextParkedSessionUnit(transactionBackend(tx));
        resume.resolve();
        await resume.promise;
        const created = requireDefined(continuation);
        await parkedOrSettled(parked, created);
        pausing.release();
        const [errorA] = await Promise.all([callA, created]);
        return errorA;
      });

      expect(outcome).toBeInstanceOf(InjectedOverlapFailure);
      expect(await store.backend.getEdge(store.graphId, "a1")).toBeDefined();
      expect(
        await store.backend.getNode(store.graphId, "SpoPerson", "continued"),
      ).toBeDefined();
    });
    // MUTATION CHECK: let `liveHolder` return the innermost holder whether or
    // not it has been released — the continuation queues in the finished
    // holder's empty order, creates inside A's scope, and A's rollback
    // removes the node after the create resolved.

    it("refuses an adopted merge apply when a unit ahead of it writes the target first", async () => {
      const graph = buildGraph(nextGraphId());
      const target = await context.createStore(graph, {
        revisionTracking: true,
      });
      await target.nodes.SpoPerson.create({ name: "orig" }, { id: "m1" });
      const source = unwrap(
        await branch(target, () => context.createIsolatedBackend(), {
          id: asBranchId("overlap-branch"),
        }),
      );
      await source.store.nodes.SpoPerson.update("m1" as never, {
        name: "branch",
      });
      const plan = unwrap(await planMerge(target, [source]));
      const verdict = statementExecutionVerdict(context.getBackend());
      if (!verdict.supported)
        throw new Error("Lane lacks statement execution.");
      const gate = deferred();

      const refusal = await target.transaction(async (tx) => {
        const earlier = runRecordedTransactionSavepoint(
          transactionBackend(tx),
          verdict,
          "test_earlier_writer",
          async () => {
            await gate.promise;
            await tx.nodes.SpoPerson.update("m1" as never, { name: "tx" });
            return { action: "release", value: undefined } as const;
          },
        );
        const parked = nextParkedSessionUnit(transactionBackend(tx));
        const apply = applyMergePlanInTransaction(target, tx, plan).then(
          () => "applied" as const,
          (error: unknown) => error,
        );
        await parkedOrSettled(parked, apply);
        gate.resolve();
        const [, applied] = await Promise.all([earlier, apply]);
        return applied;
      });

      // The earlier update is pending when the apply's turn comes, so the
      // apply refuses instead of overwriting it.
      expect(refusal).toBeInstanceOf(MergePlanCapabilityError);
      const m1 = await target.nodes.SpoPerson.getById("m1" as never);
      expect(m1?.name).toBe("tx");
    });
    // MUTATION CHECK: run `assertMergeTransactionPristine` before
    // `applyMergePlanInTransaction` takes its turn — the check passes while
    // the earlier unit has yet to write, and the apply then overwrites "tx".

    it("shares one turn order between two bindings of one native transaction", async () => {
      const graph = buildGraph(nextGraphId());
      const [store] = await createAdapterStoreWithSchema(
        graph,
        context.getBackend(),
      );
      const verdict = statementExecutionVerdict(context.getBackend());
      if (!verdict.supported)
        throw new Error("Lane lacks statement execution.");
      const opened = deferred();
      const release = deferred();

      const outcome = await store.transaction(async (tx) => {
        if (tx.sqlAvailability !== "available") {
          throw new Error("Lane does not expose tx.sql.");
        }
        const adopted = store.withTransaction(tx.sql);
        const scope = runRecordedTransactionSavepoint(
          transactionBackend(tx),
          verdict,
          "test_original_binding_scope",
          async () => {
            opened.resolve();
            await release.promise;
            return {
              action: "rollback",
              value: "rolled-back",
              cause: new InjectedOverlapFailure(),
            } as const;
          },
        );
        await Promise.race([opened.promise, scope]);
        const parked = nextParkedSessionUnit(transactionBackend(tx));
        const sibling = adopted.nodes.SpoPerson.create(
          { name: "adopted" },
          { id: "adopted" },
        );
        await parkedOrSettled(parked, sibling);
        release.resolve();
        const [value] = await Promise.all([scope, sibling]);
        return value;
      });

      expect(outcome).toBe("rolled-back");
      expect(
        await context
          .getBackend()
          .getNode(store.graphId, "SpoPerson", "adopted"),
      ).toBeDefined();
    });
    // MUTATION CHECK: key `transactionSessionOf` by the derivation root only,
    // ignoring the registered native transaction — the adopted binding gets
    // a turn order of its own, creates inside the scope, and the scope's
    // rollback removes the node it reported.

    it("refuses a recorded-revision request while an overlapping call holds the session", async () => {
      const graph = buildGraph(nextGraphId());
      const store = await context.createHistoryStore(graph);
      const verdict = statementExecutionVerdict(context.getBackend());
      if (!verdict.supported)
        throw new Error("Lane lacks statement execution.");
      const opened = deferred();
      const release = deferred();

      const { receipt } = await store.transactionWithReceipt(async (tx) => {
        const scope = runRecordedTransactionSavepoint(
          transactionBackend(tx),
          verdict,
          "test_request_overlap_scope",
          async () => {
            opened.resolve();
            await release.promise;
            return {
              action: "rollback",
              value: undefined,
              cause: new InjectedOverlapFailure(),
            } as const;
          },
        );
        await Promise.race([opened.promise, scope]);
        // The scope's rollback would restore a checkpoint taken before this
        // request and drop it, so the request is refused, not accepted.
        expect(() => {
          tx.requestRecordedRevision();
        }).toThrow(
          expect.objectContaining({
            details: expect.objectContaining({
              code: "RECORDED_REVISION_REQUEST_OVERLAPS_CALL",
            }) as unknown,
          }) as unknown,
        );
        release.resolve();
        await scope;
        // With no call in progress, the request is honored.
        tx.requestRecordedRevision();
      });

      expect(receipt.recorded).toBeDefined();
    });
    // MUTATION CHECK: drop the `isSessionHeldByAnotherUnit` refusal from
    // `tx.requestRecordedRevision()` — the request during the open scope is
    // accepted instead of refused.
  });
}
