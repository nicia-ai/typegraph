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
import {
  type HardDeleteEdgeParams,
  type TransactionBackend,
} from "../../../src/backend/types";
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
        const callB = tx.edges.spoFollows.bulkHardDelete(["b1"] as never);
        // B may wait for A's savepoint scope; give it the chance to finish
        // first if it does not, then fail A.
        await Promise.race([
          callB,
          new Promise((resolve) => setTimeout(resolve, 500)),
        ]);
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
        const callB = tx.nodes.SpoPerson.create(
          { name: "late" },
          { id: "late" },
        );
        await Promise.race([
          callB,
          new Promise((resolve) => setTimeout(resolve, 500)),
        ]);
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
        const sibling = tx.nodes.SpoPerson.create(
          { name: "out" },
          { id: "out" },
        );
        await Promise.race([
          sibling,
          new Promise((resolve) => setTimeout(resolve, 500)),
        ]);
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
  });
}
