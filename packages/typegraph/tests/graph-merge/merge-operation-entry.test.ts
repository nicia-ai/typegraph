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
 * The Store runtime port's members that take a statement target take it
 * through a signature the public API spells, with no session: a merge's
 * operation handle or a transaction handed to one joins as a binding of its
 * own (`enterTargetOperation`), after the member's early returns.
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
import type { GraphBackend, TransactionBackend } from "../../src/backend/types";
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
  enterTransactionOperation,
  openTransactionSession,
  operationEntrySession,
  type TransactionSession,
} from "../../src/store/operation-scope";
import { storeRuntime } from "../../src/store/runtime-port";
import { TRANSACTION_RUNTIME } from "../../src/store/types";

vi.mock("../../src/store/operation-scope", async (importOriginal) => {
  const actual: typeof OperationScopeModule = await importOriginal();
  return {
    ...actual,
    enterOperation: vi.fn(actual.enterOperation),
    enterTargetOperation: vi.fn(actual.enterTargetOperation),
    enterTransactionOperation: vi.fn(actual.enterTransactionOperation),
    openTransactionSession: vi.fn(actual.openTransactionSession),
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
 * the last clear entered (it enters inside the mint module, so its
 * `enterOperation` is not among the spied calls).
 */
function runtimeEntrySessions(): readonly TransactionSession[] {
  return enterTransactionOperationSpy.mock.results.map((result) => {
    if (result.type !== "return") throw new Error("mint threw");
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
  expect(sessions.length).toBeGreaterThan(0);
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

const IdentityItem = defineNode("Item", {
  schema: z.object({ name: z.string() }),
});
const identityGraph = defineGraph({
  id: "merge_operation_entry_identity",
  nodes: { Item: { type: IdentityItem } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

async function createIdentityTarget(): Promise<Store<typeof identityGraph>> {
  const { backend } = createLocalSqliteBackend();
  cleanups.push(() => backend.close());
  const [store] = await createAdapterStoreWithSchema(identityGraph, backend);
  await store.nodes.Item.create({ name: "kept" }, { id: "kept" });
  return store;
}

/** The runtime ports of `graph` and `identityGraph`, side by side. */
type AnyRuntime =
  | ReturnType<typeof storeRuntime<typeof graph>>
  | ReturnType<typeof storeRuntime<typeof identityGraph>>;

describe("the Store runtime port's statement targets", () => {
  it("a member handed a merge's operation handle or a transaction joins it as a binding of its own, and the root as itself", async () => {
    const target = await createIdentityTarget();
    const runtime = storeRuntime(target);
    const root: GraphBackend = runtime.backend;
    await target.transaction(async (tx) => {
      clearMints();
      await tx.nodes.Item.create({ name: "own" }, { id: "own" });
      const [session] = enteredSessions();
      if (session === undefined) throw new Error("no session entered");
      // What merge apply hands the members: the handle of the operation it
      // entered in this transaction's session.
      const handle = enterTransactionOperation(tx).backend;
      const raw: TransactionBackend = tx[TRANSACTION_RUNTIME].backend;
      const calls: readonly (readonly [
        string,
        TransactionBackend,
        () => unknown,
      ])[] = [handle, raw].flatMap((passed) => [
        [
          "queryBackend",
          passed,
          () => {
            runtime.queryBackend(passed);
          },
        ],
        [
          "liveNodesSharingIds",
          passed,
          () => runtime.liveNodesSharingIds(["kept"], passed),
        ],
        [
          "identityAssertionRowsByIds",
          passed,
          () => runtime.identityAssertionRowsByIds(["a"], passed),
        ],
        [
          "structuralIdentityClasses",
          passed,
          () =>
            runtime.structuralIdentityClasses(
              [{ kind: "Item", id: "kept" }],
              passed,
            ),
        ],
        [
          "interchangeIdentityAssertionsByIdsAtTarget",
          passed,
          () =>
            requirePort(runtime.interchangeIdentityAssertionsByIdsAtTarget)(
              passed,
              ["a"],
              "state",
            ),
        ],
      ]);
      const observed: unknown[] = [];
      for (const [label, passed, call] of calls) {
        clearMints();
        await call();
        const joined = targetEntrySessions();
        observed.push({
          label,
          targetEntries: joined.length,
          ofThePassedTarget: enterTargetOperationSpy.mock.calls.every(
            ([argument]) => argument === passed,
          ),
          // A binding of its own: a new session, never the transaction's.
          ownBinding:
            joined[0] !== undefined && (joined[0] as unknown) !== session,
        });
      }
      expect(observed).toEqual(
        calls.map(([label]) => ({
          label,
          targetEntries: 1,
          ofThePassedTarget: true,
          ownBinding: true,
        })),
      );
    });

    clearMints();
    expect(runtime.queryBackend(root)).toBeDefined();
    await runtime.liveNodesSharingIds(["kept"], root);
    expect(openTransactionSessionSpy).not.toHaveBeenCalled();
    expect(targetEntrySessions()).toEqual([undefined, undefined]);
    expect(
      enterTargetOperationSpy.mock.calls.map(([argument]) => argument),
    ).toEqual([root, root]);
  });

  it("a member returns before it enters: a call that reads or writes nothing enters nothing", async () => {
    const identityTarget = await createIdentityTarget();
    const plainTarget = await createTarget();
    const outcomes: unknown[] = [];
    const settle = async (
      label: string,
      call: () => Promise<unknown>,
    ): Promise<void> => {
      clearMints();
      const outcome = await call().then(
        (value) => ({ resolved: value }),
        (error: unknown) => ({ rejected: String(error) }),
      );
      outcomes.push({
        label,
        outcome,
        entered:
          enterTargetOperationSpy.mock.calls.length +
          openTransactionSessionSpy.mock.calls.length +
          enterOperationSpy.mock.calls.length,
      });
    };
    for (const [label, runtime] of [
      ["identity", storeRuntime(identityTarget)],
      ["plain", storeRuntime(plainTarget)],
    ] as const satisfies readonly (readonly [string, AnyRuntime])[]) {
      const interchange = requirePort(
        runtime.interchangeIdentityAssertionsByIdsAtTarget,
      );
      // An untyped caller with no target and no ids: nothing to read.
      await settle(`${label} interchange, no ids, no target`, () =>
        interchange(undefined as never, [], "state"),
      );
      await settle(`${label} uniqueness, nothing cleared`, () =>
        runtime.applyResolvedNodeUniqueness(
          undefined as never,
          { upserts: [], releases: [] },
          () => Promise.resolve("applied"),
        ),
      );
    }
    const plain = storeRuntime(plainTarget);
    await plainTarget.transaction(async (tx) => {
      const raw = tx[TRANSACTION_RUNTIME].backend;
      // A graph without identity has no identity tables to read.
      await settle("plain interchange, identity disabled", () =>
        requirePort(plain.interchangeIdentityAssertionsByIdsAtTarget)(
          raw,
          ["a"],
          "state",
        ),
      );
      await settle("plain assertion rows, identity disabled", () =>
        plain.identityAssertionRowsByIds(["a"], raw),
      );
      await settle("plain structural classes, identity disabled", () =>
        plain.structuralIdentityClasses([{ kind: "Item", id: "kept" }], raw),
      );
    });
    const empty = (label: string, resolved: unknown) => ({
      label,
      outcome: { resolved },
      entered: 0,
    });
    expect(outcomes).toEqual([
      empty("identity interchange, no ids, no target", []),
      empty("identity uniqueness, nothing cleared", "applied"),
      empty("plain interchange, no ids, no target", []),
      empty("plain uniqueness, nothing cleared", "applied"),
      empty("plain interchange, identity disabled", []),
      empty("plain assertion rows, identity disabled", new Map()),
      empty("plain structural classes, identity disabled", new Map()),
    ]);
  });
});

function requirePort<T>(port: T | undefined): T {
  if (port === undefined) throw new Error("the runtime port lacks this member");
  return port;
}
