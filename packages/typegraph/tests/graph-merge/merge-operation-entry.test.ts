/**
 * Where merge apply and a durable Store operation enter their operation.
 *
 * Merge apply, `applyMergePlanInTransaction` and `operateStore` issue
 * statements on a transaction directly (fences, freshness guards, savepoints,
 * evidence reads) while the collection writes they drive enter operations of
 * their own. Each public call enters ONE operation for its direct statements,
 * of the session of the transaction it runs in: the caller's session when the
 * caller handed it a transaction context, the session opened with the
 * transaction when the call opened it. The session reaches the call through
 * the context's runtime (`enterTransactionOperation`); nothing is looked up
 * from an object.
 *
 * The Store runtime port's members that take a statement target have a
 * statement port (`storeStatementPort`) that runs on the handle it is given;
 * their public forms carry no session, so a transaction handed to them
 * enters as a binding of its own.
 *
 * Operations change nothing a database can observe yet, so these cases watch
 * the mints themselves, wrapped with spies that call through.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  createAdapterStoreWithSchema,
  defineGraph,
  defineNode,
  type Store,
} from "../../src";
import { createLocalSqliteBackend } from "../../src/backend/sqlite/local";
import type { GraphBackend } from "../../src/backend/types";
import {
  branch,
  captureStoreOperationTarget,
  type GraphBranch,
  merge,
  mergeIncremental,
  operateStore,
  unwrap,
} from "../../src/graph-merge";
import {
  applyMergePlan,
  applyMergePlanInTransaction,
  planMerge,
} from "../../src/graph-merge/merge";
import { asBranchId } from "../../src/graph-merge/types";
import type * as OperationScopeModule from "../../src/store/operation-scope";
import {
  enterOperation,
  enterTargetOperation,
  openTransactionSession,
  operationEntrySession,
  type StoreTransactionBackend,
  type TransactionSession,
} from "../../src/store/operation-scope";
import type * as RuntimePortModule from "../../src/store/runtime-port";
import {
  enterTransactionOperation,
  storeRuntime,
  storeStatementPort,
  transactionBackend,
} from "../../src/store/runtime-port";
import {
  TRANSACTION_RUNTIME,
  type TransactionRuntime,
} from "../../src/store/types";

vi.mock("../../src/store/operation-scope", async (importOriginal) => {
  const actual: typeof OperationScopeModule = await importOriginal();
  return {
    ...actual,
    enterOperation: vi.fn(actual.enterOperation),
    enterTargetOperation: vi.fn(actual.enterTargetOperation),
    openTransactionSession: vi.fn(actual.openTransactionSession),
  };
});

vi.mock("../../src/store/runtime-port", async (importOriginal) => {
  const actual: typeof RuntimePortModule = await importOriginal();
  return {
    ...actual,
    enterTransactionOperation: vi.fn(actual.enterTransactionOperation),
  };
});

const enterOperationSpy = vi.mocked(enterOperation);
const enterTargetOperationSpy = vi.mocked(enterTargetOperation);
const openTransactionSessionSpy = vi.mocked(openTransactionSession);
const enterTransactionOperationSpy = vi.mocked(enterTransactionOperation);

const Item = defineNode("Item", { schema: z.object({ name: z.string() }) });
const graph = defineGraph({
  id: "merge_operation_entry",
  nodes: { Item: { type: Item } },
  edges: {},
});

type GraphStore = Store<typeof graph>;

function clearMints(): void {
  enterOperationSpy.mockClear();
  enterTargetOperationSpy.mockClear();
  openTransactionSessionSpy.mockClear();
  enterTransactionOperationSpy.mockClear();
}

/** The session a read inside `tx` enters its operation from. */
async function readSessionOf(
  tx: Parameters<Parameters<GraphStore["transaction"]>[0]>[0],
): Promise<TransactionSession> {
  clearMints();
  await tx
    .query()
    .from("Item", "item")
    .select((ctx) => ctx.item.name)
    .execute();
  const [session] = enteredSessions();
  if (session === undefined) throw new Error("the read entered no session");
  return session;
}

/**
 * The session each `enterTargetOperation` call since the last clear joined,
 * `undefined` for a root target.
 */
function targetEntrySessions(): readonly (TransactionSession | undefined)[] {
  return enterTargetOperationSpy.mock.results.map((result) => {
    if (result.type !== "return") throw new Error("mint threw");
    return operationEntrySession(result.value);
  });
}

/** The sessions every `enterOperation` call since the last clear entered. */
function enteredSessions(): readonly TransactionSession[] {
  return enterOperationSpy.mock.results.flatMap((result) => {
    if (result.type !== "return") throw new Error("mint threw");
    const session = operationEntrySession(result.value);
    return session === undefined ? [] : [session];
  });
}

/** What each `openTransactionSession` call since the last clear returned. */
function openedSessions(): readonly TransactionSession[] {
  return openTransactionSessionSpy.mock.results.map((result) => {
    if (result.type !== "return") throw new Error("mint threw");
    const session: TransactionSession = result.value;
    return session;
  });
}

/**
 * The session of the operation each `enterTransactionOperation` call since
 * the last clear entered: the `enterOperation` call it made, which is the
 * next invocation of the mint after its own.
 */
function runtimeEntrySessions(): readonly TransactionSession[] {
  const enterOrder = enterOperationSpy.mock.invocationCallOrder;
  return enterTransactionOperationSpy.mock.invocationCallOrder.map((order) => {
    const index = enterOrder.findIndex((entered) => entered > order);
    const result = enterOperationSpy.mock.results[index];
    if (result?.type !== "return")
      throw new Error("the runtime entered no operation");
    const session = operationEntrySession(result.value);
    if (session === undefined)
      throw new Error("the runtime entered the root backend");
    return session;
  });
}

/**
 * Asserts that, since the last clear, the call entered exactly one operation
 * through its context's runtime, and that it and every collection write it
 * drove entered `session` itself (`toBe`: a fresh session over the same
 * transaction deep-equals the real one).
 */
function expectOneOperationOf(session: TransactionSession): void {
  const runtime = runtimeEntrySessions();
  expect(runtime).toHaveLength(1);
  expect(runtime[0]).toBe(session);
  const sessions = enteredSessions();
  // The merge drives at least one collection write of its own.
  expect(sessions.length).toBeGreaterThan(1);
  for (const entered of sessions) expect(entered).toBe(session);
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  clearMints();
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function createTarget(
  options: Readonly<{ history?: boolean }> = {},
): Promise<GraphStore> {
  const { backend } = createLocalSqliteBackend();
  cleanups.push(() => backend.close());
  const [store] = await createAdapterStoreWithSchema(graph, backend, {
    revisionTracking: true,
    ...options,
  });
  await store.nodes.Item.create({ name: "kept" }, { id: "kept" });
  return store;
}

async function branchOf(
  target: GraphStore,
): Promise<GraphBranch<typeof graph>> {
  const source = unwrap(
    await branch(
      target,
      () => {
        const fixture = createLocalSqliteBackend();
        cleanups.push(() => fixture.backend.close());
        return Promise.resolve(fixture.backend);
      },
      { id: asBranchId("source") },
    ),
  );
  await source.store.nodes.Item.create({ name: "added" }, { id: "added" });
  await source.store.nodes.Item.create({ name: "also" }, { id: "also" });
  return source;
}

describe("merge apply enters one operation of its transaction's session", () => {
  it("applyMergePlanInTransaction enters one operation of the caller's session and opens none", async () => {
    const target = await createTarget();
    const artifact = unwrap(await planMerge(target, [await branchOf(target)]));
    await target.transaction(async (tx) => {
      // A read: the apply refuses a transaction that already wrote.
      const session = await readSessionOf(tx);

      clearMints();
      await applyMergePlanInTransaction(target, tx, artifact);
      expectOneOperationOf(session);
      expect(openTransactionSessionSpy).not.toHaveBeenCalled();
      expect(enterTargetOperationSpy).not.toHaveBeenCalled();
    });
  });

  it.each(["merge", "incremental", "plan"] as const)(
    "%s opens one session with its transaction and enters one operation of it",
    async (mode) => {
      const target = await createTarget({ history: true });
      const source = await branchOf(target);
      const recorded = await target.recordedNow();
      if (recorded === undefined) throw new Error("no recorded fork point");
      const artifact =
        mode === "plan" ? unwrap(await planMerge(target, [source])) : undefined;

      clearMints();
      switch (mode) {
        case "merge": {
          unwrap(await merge(target, [source]));
          break;
        }
        case "incremental": {
          unwrap(
            await mergeIncremental({
              forkPoint: { recorded, base: source.base },
              target,
              branches: [source],
            }),
          );
          break;
        }
        case "plan": {
          if (artifact === undefined) throw new Error("no artifact");
          unwrap(await applyMergePlan(target, artifact));
          break;
        }
      }
      // The commit transaction's own session: the one every operation of the
      // call entered. Planning a merge opens no transaction of its own.
      const sessions = enteredSessions();
      const session = sessions[0];
      if (session === undefined) throw new Error("no session entered");
      expect(openedSessions()).toContain(session);
      expectOneOperationOf(session);
      expect(await target.nodes.Item.getById(asNodeId("added"))).toBeDefined();
    },
  );

  it("operateStore enters one operation of the session of the transaction it opens", async () => {
    const target = await createTarget({ history: true });
    const request = {
      target: await captureStoreOperationTarget(target),
      idempotencyKey: "key",
      metadata: { caller: "test" },
      mutation: { id: "created" },
    };

    clearMints();
    unwrap(
      await operateStore(target, request, async (tx) => {
        await tx.nodes.Item.create({ name: "created" }, { id: "created" });
        await tx.nodes.Item.create({ name: "second" }, { id: "second" });
        return { ok: true };
      }),
    );
    const session = enteredSessions()[0];
    if (session === undefined) throw new Error("no session entered");
    expect(openedSessions()).toContain(session);
    expectOneOperationOf(session);

    // A replay reads the evidence under its own operation and applies nothing.
    clearMints();
    const replayed = unwrap(
      await operateStore(target, request, () => {
        throw new Error("a replay never applies");
      }),
    );
    expect(replayed.outcome).toBe("replayed");
    expect(runtimeEntrySessions()).toHaveLength(1);
    expect(openedSessions()).toContain(runtimeEntrySessions()[0]);
  });
});

describe("the Store runtime port's statement targets", () => {
  it("the statement port runs on the handle it is given, minting nothing; the public member enters a transaction as a binding of its own", async () => {
    const target = await createTarget();
    await target.transaction(async (tx) => {
      const session = await readSessionOf(tx);
      const handle = enterTransactionOperation(tx);
      const raw: StoreTransactionBackend = transactionBackend(tx);

      clearMints();
      const throughPort = await storeStatementPort(target).liveNodesSharingIds(
        ["kept"],
        handle,
      );
      expect(throughPort).toEqual([{ kind: "Item", id: "kept" }]);
      expect(openTransactionSessionSpy).not.toHaveBeenCalled();
      expect(enterOperationSpy).not.toHaveBeenCalled();
      expect(enterTargetOperationSpy).not.toHaveBeenCalled();

      clearMints();
      const throughPublic = await storeRuntime(target).liveNodesSharingIds(
        ["kept"],
        tx[TRANSACTION_RUNTIME].backend,
      );
      expect(throughPublic).toEqual(throughPort);
      expect(enterTargetOperationSpy).toHaveBeenCalledTimes(1);
      expect(enterTargetOperationSpy.mock.calls[0]?.[0]).toBe(raw);
      const [joined] = targetEntrySessions();
      expect(joined).toBeDefined();
      expect(joined).not.toBe(session);
    });
  });

  it("each public member that takes a target enters a transaction once and the root as itself", async () => {
    const target = await createTarget();
    const runtime = storeRuntime(target);
    const root: GraphBackend = runtime.backend;
    await target.transaction(async (tx) => {
      const raw = tx[TRANSACTION_RUNTIME].backend;
      const calls: readonly (readonly [string, () => Promise<unknown>])[] = [
        [
          "liveNodesSharingIds",
          () => runtime.liveNodesSharingIds(["kept"], raw),
        ],
        [
          "identityAssertionRowsByIds",
          () => runtime.identityAssertionRowsByIds(["a"], raw),
        ],
        [
          "structuralIdentityClasses",
          () =>
            runtime.structuralIdentityClasses(
              [{ kind: "Item", id: "kept" }],
              raw,
            ),
        ],
        [
          "interchangeIdentityAssertionsByIdsAtTarget",
          () =>
            runtime.interchangeIdentityAssertionsByIdsAtTarget?.(
              raw,
              ["a"],
              "state",
            ) ?? Promise.reject(new Error("member missing")),
        ],
        [
          "applyResolvedNodeUniqueness",
          () =>
            runtime.applyResolvedNodeUniqueness(
              raw,
              { upserts: [], releases: [] },
              () => Promise.resolve("applied"),
            ),
        ],
      ];
      const session = await readSessionOf(tx);
      for (const [label, call] of calls) {
        clearMints();
        await call();
        // One new binding of the transaction per call, never the context's.
        const joined = [...targetEntrySessions(), ...openedSessions()].filter(
          (entered) => entered !== undefined,
        );
        expect({ label, joined: joined.length }).toEqual({ label, joined: 1 });
        expect(joined[0]).not.toBe(session);
        const passed = [
          ...enterTargetOperationSpy.mock.calls.map(([target]) => target),
          ...openTransactionSessionSpy.mock.calls.map(([target]) => target),
        ];
        expect(passed).toEqual([raw]);
        expect(passed[0]).toBe(raw);
      }
    });

    clearMints();
    expect(runtime.queryBackend(root)).toBeDefined();
    await runtime.liveNodesSharingIds(["kept"], root);
    expect(openTransactionSessionSpy).not.toHaveBeenCalled();
    expect(targetEntrySessions()).toEqual([undefined, undefined]);
    expect(
      enterTargetOperationSpy.mock.calls.map(([target]) => target),
    ).toEqual([root, root]);
  });
});

describe("enterTransactionOperation", () => {
  it("enters through the session the runtime carries, and as a binding of its own when the runtime carries none", async () => {
    const target = await createTarget();
    await target.transaction(async (tx) => {
      clearMints();
      await tx.nodes.Item.create({ name: "own" }, { id: "own" });
      const [session] = enteredSessions();
      if (session === undefined) throw new Error("no session entered");

      clearMints();
      enterTransactionOperation(tx);
      expect(runtimeEntrySessions()).toEqual([session]);
      expect(runtimeEntrySessions()[0]).toBe(session);
      expect(openTransactionSessionSpy).not.toHaveBeenCalled();

      // A runtime authored without the entry (an older version's): its
      // transaction carries no session to join.
      const runtime = tx[TRANSACTION_RUNTIME];
      const bare: TransactionRuntime = {
        backend: runtime.backend,
        deleteNodeWithPolicy: runtime.deleteNodeWithPolicy,
        reviveNode: runtime.reviveNode,
        acquireWriteFences: runtime.acquireWriteFences,
        acquireReadFences: runtime.acquireReadFences,
        assertWritable: runtime.assertWritable,
      };
      clearMints();
      expect(enterTransactionOperation({ [TRANSACTION_RUNTIME]: bare })).toBe(
        runtime.backend,
      );
      expect(openTransactionSessionSpy).toHaveBeenCalledTimes(1);
      expect(openTransactionSessionSpy.mock.calls[0]?.[0]).toBe(
        runtime.backend,
      );
      const [opened] = openedSessions();
      expect(opened).not.toBe(session);
      expect(enteredSessions()).toHaveLength(1);
      expect(enteredSessions()[0]).toBe(opened);
    });
  });
});
