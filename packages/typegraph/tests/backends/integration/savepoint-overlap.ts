/**
 * TypeGraph-owned savepoint scopes against overlapping calls on one
 * transaction, on every backend.
 *
 * A savepoint's rollback undoes every statement issued on the session since
 * the savepoint was taken, whoever issued it. Two calls started inside one
 * `store.transaction()` callback without awaiting each other would otherwise
 * share one rollback boundary: a batch call's caught failure would roll back
 * the other call's completed, successfully reported writes. While a scope is
 * open, TypeGraph refuses every statement on the transaction from outside it
 * with a `SavepointScopeConflictError`, before anything reaches the driver.
 *
 * Every pause is a promise the test resolves itself; nothing waits on a timer.
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
import {
  type HardDeleteEdgeParams,
  type TransactionBackend,
} from "../../../src/backend/types";
import { SavepointScopeConflictError } from "../../../src/errors-entry";
import { runRecordedTransactionSavepoint } from "../../../src/store/recorded-capture";
import { transactionBackend } from "../../../src/store/runtime-port";
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

const BULK_DELETE_HOLDER = "edges.spoFollows.bulkHardDelete";

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

/** Settles with the rejection of `call`, or with `"resolved"`. */
function outcomeOf(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => "resolved" as const,
    (error: unknown) => error,
  );
}

function expectConflict(
  outcome: unknown,
  holder: string,
  refused: RegExp,
): void {
  expect(outcome).toBeInstanceOf(SavepointScopeConflictError);
  const conflict = outcome as SavepointScopeConflictError;
  expect(conflict.code).toBe("SAVEPOINT_SCOPE_CONFLICT");
  expect(conflict.details.holder).toBe(holder);
  expect(conflict.details.refused).toMatch(refused);
}

/**
 * `strip` applied to the lane's backend and to every transaction it opens.
 */
function deriveEverywhere(
  backend: GraphBackend,
  strip: <T extends GraphBackend | TransactionBackend>(target: T) => T,
): GraphBackend {
  return deriveBackend(strip(backend), {
    transaction: (fn, options) =>
      backend.transaction((tx) => fn(strip(tx)), options),
  });
}

/**
 * The lane's backend without `hardDeleteEdgesBatch` (and, with
 * `withoutStatements`, without `executeStatement`), so `bulkHardDelete`
 * removes each edge through `hardDeleteEdge`. The delete of `pausedId` runs,
 * then signals `deleted` and waits for `release` before throwing — so the
 * statement has landed inside its call's savepoint, and the savepoint is
 * still open, when the test acts.
 */
function pausingHardDelete(
  backend: GraphBackend,
  pausedId: string,
  withoutStatements = false,
): Readonly<{
  backend: GraphBackend;
  deleted: Promise<void>;
  release: () => void;
}> {
  const deleted = deferred();
  const release = deferred();
  const omitted =
    withoutStatements ?
      (["hardDeleteEdgesBatch", "executeStatement"] as const)
    : (["hardDeleteEdgesBatch"] as const);
  function strip<T extends GraphBackend | TransactionBackend>(target: T): T {
    const stripped = projectBackendWithout(target, omitted);
    return deriveBackend(stripped, {
      async hardDeleteEdge(params: HardDeleteEdgeParams): Promise<boolean> {
        const removed = await target.hardDeleteEdge(params);
        if (params.id !== pausedId) return removed;
        deleted.resolve();
        await release.promise;
        throw new InjectedOverlapFailure();
      },
    } as never) as unknown as T;
  }
  return {
    backend: deriveEverywhere(backend, strip),
    deleted: deleted.promise,
    release: release.resolve,
  };
}

function person(id: string) {
  return { kind: "SpoPerson" as const, id };
}

async function seed(context: IntegrationTestContext) {
  const graph = buildGraph(nextGraphId());
  const store = await context.createStore(graph);
  for (const id of ["p1", "p2", "p3"]) {
    await store.nodes.SpoPerson.create({ name: id }, { id });
  }
  const follows = store.edges.spoFollows;
  await follows.create(person("p1"), person("p2"), {}, { id: "a1" });
  await follows.create(person("p2"), person("p3"), {}, { id: "b1" });
  return { graph, store };
}

function requireStatements(backend: GraphBackend) {
  const verdict = statementExecutionVerdict(backend);
  if (!verdict.supported) throw new Error("Lane lacks statement execution.");
  return verdict;
}

export function registerSavepointOverlapIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("savepoint scopes and overlapping calls on one transaction", () => {
    it("refuses a sibling write while a batch call's savepoint is open, and commits the rest", async () => {
      const { graph, store } = await seed(context);
      const pausing = pausingHardDelete(store.backend, "a1");
      const pausingStore = createStore(graph, pausing.backend);

      const outcomes = await pausingStore.transaction(async (tx) => {
        await tx.nodes.SpoPerson.create({ name: "x" }, { id: "before" });
        const callA = outcomeOf(
          tx.edges.spoFollows.bulkHardDelete(["a1"] as never),
        );
        await pausing.deleted;
        const sibling = await outcomeOf(
          tx.nodes.SpoPerson.create({ name: "x" }, { id: "sibling" }),
        );
        pausing.release();
        const failure = await callA;
        // The scope has closed: the transaction is usable again.
        await tx.nodes.SpoPerson.create({ name: "x" }, { id: "after" });
        return { failure, sibling };
      });

      expect(outcomes.failure).toBeInstanceOf(InjectedOverlapFailure);
      expectConflict(outcomes.sibling, BULK_DELETE_HOLDER, /statement$/u);
      // A failed: its delete is rolled back with its savepoint.
      expect(await store.backend.getEdge(store.graphId, "a1")).toBeDefined();
      const node = (id: string) =>
        store.backend.getNode(store.graphId, "SpoPerson", id);
      expect(await node("before")).toBeDefined();
      expect(await node("sibling")).toBeUndefined();
      expect(await node("after")).toBeDefined();
    });
    // MUTATION CHECK: make `admitSessionStatement` return without refusing —
    // the sibling create succeeds inside A's savepoint and A's rollback
    // removes the node it reported as created.

    it("refuses a sibling read, and judges a built query when it executes", async () => {
      const { graph, store } = await seed(context);
      const pausing = pausingHardDelete(store.backend, "a1");
      const pausingStore = createStore(graph, pausing.backend);

      const outcomes = await pausingStore.transaction(async (tx) => {
        const query = tx
          .query()
          .from("SpoPerson", "person")
          .select((select) => select.person.name);
        const callA = outcomeOf(
          tx.edges.spoFollows.bulkHardDelete(["a1"] as never),
        );
        await pausing.deleted;
        const read = await outcomeOf(tx.nodes.SpoPerson.getById("p1" as never));
        const built = await outcomeOf(query.execute());
        const deferredQuery = tx
          .query()
          .from("SpoPerson", "person")
          .select((select) => select.person.name);
        pausing.release();
        await callA;
        return {
          read,
          built,
          afterClose: await query.execute(),
          builtInside: await deferredQuery.execute(),
        };
      });

      expectConflict(outcomes.read, BULK_DELETE_HOLDER, /statement$/u);
      expectConflict(outcomes.built, BULK_DELETE_HOLDER, /statement$/u);
      expect(outcomes.afterClose).toHaveLength(3);
      expect(outcomes.builtInside).toHaveLength(3);
    });
    // MUTATION CHECK: as above, make `admitSessionStatement` admit every
    // statement — both reads resolve with rows the open scope may roll back.

    it("refuses opening a second savepoint scope beside an open one", async () => {
      const { graph, store } = await seed(context);
      const pausing = pausingHardDelete(store.backend, "a1");
      const pausingStore = createStore(graph, pausing.backend);
      const verdict = requireStatements(store.backend);

      const outcomes = await pausingStore.transaction(async (tx) => {
        const callA = outcomeOf(
          tx.edges.spoFollows.bulkHardDelete(["a1"] as never),
        );
        await pausing.deleted;
        const second = await outcomeOf(
          runRecordedTransactionSavepoint(
            transactionBackend(tx),
            verdict,
            "second scope",
            "test_second_scope",
            () => Promise.resolve({ action: "release", value: 1 } as const),
          ),
        );
        pausing.release();
        return { failure: await callA, second };
      });

      expectConflict(
        outcomes.second,
        BULK_DELETE_HOLDER,
        /^Opening a savepoint for second scope$/u,
      );
      // A's own rollback still ran on its savepoint.
      expect(outcomes.failure).toBeInstanceOf(InjectedOverlapFailure);
      expect(await store.backend.getEdge(store.graphId, "a1")).toBeDefined();
    });
    // MUTATION CHECK: delete the `foreignOpenScope` refusal in
    // `runSavepointScope` — the second scope opens beside A and the refusal
    // comes, if at all, from its SAVEPOINT statement instead.

    it("runs calls and scopes nested inside a savepoint scope", async () => {
      const { graph, store } = await seed(context);
      const scopeStore = createStore(graph, store.backend);
      const verdict = requireStatements(store.backend);

      const outcome = await scopeStore.transaction(async (tx) =>
        runRecordedTransactionSavepoint(
          transactionBackend(tx),
          verdict,
          "outer scope",
          "test_outer_scope",
          async () => {
            // Nested calls run concurrently with each other inside the scope;
            // the bulk delete opens a nested scope of its own.
            await Promise.all([
              tx.nodes.SpoPerson.create({ name: "n" }, { id: "nested" }),
              tx.nodes.SpoPerson.getById("p1" as never),
            ]);
            await tx.edges.spoFollows.bulkHardDelete(["b1"] as never);
            const rolledBack = await runRecordedTransactionSavepoint(
              transactionBackend(tx),
              verdict,
              "inner scope",
              "test_inner_scope",
              async () => {
                await tx.nodes.SpoPerson.create({ name: "r" }, { id: "inner" });
                return {
                  action: "rollback",
                  value: "inner rolled back",
                  cause: new InjectedOverlapFailure(),
                } as const;
              },
            );
            return { action: "release", value: rolledBack } as const;
          },
        ),
      );

      expect(outcome).toBe("inner rolled back");
      const node = (id: string) =>
        store.backend.getNode(store.graphId, "SpoPerson", id);
      expect(await node("nested")).toBeDefined();
      expect(await node("inner")).toBeUndefined();
      expect(await store.backend.getEdge(store.graphId, "b1")).toBeUndefined();
    });
    // MUTATION CHECK: make `foreignOpenScope` ignore the ancestry walk (treat
    // every open scope as foreign) — the nested create is refused.

    it("treats a continuation that outlives its scope as outside the scopes opened after it", async () => {
      const { graph, store } = await seed(context);
      const pausing = pausingHardDelete(store.backend, "a1");
      const pausingStore = createStore(graph, pausing.backend);
      const verdict = requireStatements(store.backend);
      const resumeWhileOpen = deferred();
      const resumeAfterClose = deferred();

      const outcomes = await pausingStore.transaction(async (tx) => {
        const continuations: Promise<unknown>[] = [];
        await runRecordedTransactionSavepoint(
          transactionBackend(tx),
          verdict,
          "finished scope",
          "test_finished_scope",
          () => {
            continuations.push(
              resumeWhileOpen.promise.then(() =>
                tx.nodes.SpoPerson.create({ name: "c" }, { id: "refused" }),
              ),
              resumeAfterClose.promise.then(() =>
                tx.nodes.SpoPerson.create({ name: "c" }, { id: "continued" }),
              ),
            );
            return Promise.resolve({
              action: "release",
              value: undefined,
            } as const);
          },
        );
        const [whileOpen, afterClose] = continuations.map((continuation) =>
          outcomeOf(continuation),
        );
        const callA = outcomeOf(
          tx.edges.spoFollows.bulkHardDelete(["a1"] as never),
        );
        await pausing.deleted;
        resumeWhileOpen.resolve();
        const refused = await whileOpen;
        pausing.release();
        await callA;
        resumeAfterClose.resolve();
        return { refused, continued: await afterClose };
      });

      // The continuation started inside "finished scope", which had closed;
      // it is not inside the bulk delete's scope, so its statement is refused.
      expectConflict(outcomes.refused, BULK_DELETE_HOLDER, /statement$/u);
      // Once no scope is open, a continuation is ordinary work.
      expect(outcomes.continued).toBe("resolved");
      expect(
        await store.backend.getNode(store.graphId, "SpoPerson", "continued"),
      ).toBeDefined();
      expect(
        await store.backend.getNode(store.graphId, "SpoPerson", "refused"),
      ).toBeUndefined();
    });
    // MUTATION CHECK: in `foreignOpenScope`, admit any execution that carries
    // a scope frame for the session — the continuation's closed frame admits
    // its create inside the bulk delete's savepoint.

    it("covers a second binding of the same native transaction", async () => {
      const graph = buildGraph(nextGraphId());
      const [store] = await createAdapterStoreWithSchema(
        graph,
        context.getBackend(),
      );
      const verdict = requireStatements(context.getBackend());
      const opened = deferred();
      const release = deferred();

      const outcomes = await store.transaction(async (tx) => {
        if (tx.sqlAvailability !== "available") {
          throw new Error("Lane does not expose tx.sql.");
        }
        const adopted = store.withTransaction(tx.sql);
        const scope = runRecordedTransactionSavepoint(
          transactionBackend(tx),
          verdict,
          "original binding scope",
          "test_original_binding_scope",
          async () => {
            await adopted.nodes.SpoPerson.create(
              { name: "in" },
              { id: "adopted-inside" },
            );
            opened.resolve();
            await release.promise;
            return { action: "release", value: undefined } as const;
          },
        );
        await opened.promise;
        const sibling = await outcomeOf(
          adopted.nodes.SpoPerson.create({ name: "out" }, { id: "sibling" }),
        );
        release.resolve();
        await scope;
        return { sibling };
      });

      expectConflict(outcomes.sibling, "original binding scope", /statement$/u);
      expect(
        await store.nodes.SpoPerson.getById("adopted-inside" as never),
      ).toBeDefined();
      expect(
        await store.nodes.SpoPerson.getById("sibling" as never),
      ).toBeUndefined();
    });
    // MUTATION CHECK: register each transaction backend as its own session
    // (`registerTransactionSession(backend, backend)` and the guard keyed to
    // the backend) — the adopted binding's create lands inside the scope.

    it("enforces nothing on a transaction without statement execution", async () => {
      const { graph, store } = await seed(context);
      const pausing = pausingHardDelete(store.backend, "a1", true);
      const pausingStore = createStore(graph, pausing.backend);

      const outcomes = await pausingStore.transaction(async (tx) => {
        const callA = outcomeOf(
          tx.edges.spoFollows.bulkHardDelete(["a1"] as never),
        );
        await pausing.deleted;
        const sibling = await outcomeOf(
          tx.nodes.SpoPerson.create({ name: "x" }, { id: "sibling" }),
        );
        pausing.release();
        return { failure: await callA, sibling };
      });

      // As before the rule existed: no savepoint is taken, so the sibling
      // runs and A's caught failure keeps the delete that landed before it.
      expect(outcomes.failure).toBeInstanceOf(InjectedOverlapFailure);
      expect(outcomes.sibling).toBe("resolved");
      expect(
        await store.backend.getNode(store.graphId, "SpoPerson", "sibling"),
      ).toBeDefined();
      expect(await store.backend.getEdge(store.graphId, "a1")).toBeUndefined();
    });
    // MUTATION CHECK: make `runFrameWritesAsUnit` open a scope
    // (`runSavepointScope`) on its unsupported-statement branch too — the
    // sibling create is refused.
  });
}
