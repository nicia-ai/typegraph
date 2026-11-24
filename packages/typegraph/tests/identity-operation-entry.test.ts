/**
 * Where an identity or search maintenance call enters its operation.
 *
 * Each call of an identity facade, a read or a mutation, enters ONE
 * `Operation` of the facade's scope after its statement-free refusals: the
 * session of the transaction whose context offers the facade (`tx.identity`),
 * or the pooled root itself (`store.identity`), which allocates no session. A
 * Store identity port call whose target arrives through a signature carrying
 * no session enters through `enterTargetOperation`. Identity maintenance, the
 * fulltext rebuild and the contribution rebuild open a session where they
 * open their transaction. The session always arrives as a value; nothing is
 * looked up.
 *
 * Operations change nothing a database can observe yet, so these cases watch
 * the mints themselves: the operation-scope module is wrapped with spies that
 * call through to the real functions. `backends/integration/
 * identity-operation-routing.ts` is the cross-backend half, which watches the
 * statements.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  defineGraph,
  defineNode,
  searchable,
} from "../src";
import type * as OperationScopeModule from "../src/store/operation-scope";
import {
  enterOperation,
  enterTargetOperation,
  type EntryScope,
  openTransactionSession,
  type OperationEntry,
  operationEntrySession,
  type TransactionSession,
} from "../src/store/operation-scope";
import { storeRuntime } from "../src/store/runtime-port";
import { TRANSACTION_RUNTIME } from "../src/store/types";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend } from "./test-utils";

vi.mock("../src/store/operation-scope", async (importOriginal) => {
  const actual: typeof OperationScopeModule = await importOriginal();
  return {
    ...actual,
    enterOperation: vi.fn(actual.enterOperation),
    enterTargetOperation: vi.fn(actual.enterTargetOperation),
    openTransactionSession: vi.fn(actual.openTransactionSession),
  };
});

const enterOperationSpy = vi.mocked(enterOperation);
const enterTargetOperationSpy = vi.mocked(enterTargetOperation);
const openTransactionSessionSpy = vi.mocked(openTransactionSession);

const Person = defineNode("Person", {
  schema: z.object({ name: searchable() }),
});
const graph = defineGraph({
  id: "identity_operation_entry",
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

const a = { kind: "Person" as const, id: "a" };
const b = { kind: "Person" as const, id: "b" };
const c = { kind: "Person" as const, id: "c" };

/** The scope each `enterOperation` call since the last clear entered from. */
function enteredScopes(): readonly EntryScope[] {
  return enterOperationSpy.mock.calls.map(([scope]) => scope);
}

/** What each `enterTargetOperation` call since the last clear returned. */
function targetEntries(): readonly OperationEntry[] {
  return enterTargetOperationSpy.mock.results.map((result) => {
    if (result.type !== "return") throw new Error("mint threw");
    return result.value;
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

function clearMints(): void {
  enterOperationSpy.mockClear();
  enterTargetOperationSpy.mockClear();
  openTransactionSessionSpy.mockClear();
}

/** The session a transaction's own writes enter their operations from. */
async function sessionOf(
  write: () => Promise<unknown>,
): Promise<TransactionSession> {
  clearMints();
  await write();
  const [scope] = enteredScopes();
  if (scope === undefined || !("heldGraphWriteLocks" in scope))
    throw new Error("the write entered no operation of a session");
  return scope;
}

async function createIdentityStore(history: boolean) {
  const backend = createTestBackend();
  const [store] = await createAdapterStoreWithSchema(graph, backend, {
    history,
  });
  await store.nodes.Person.create({ name: "Ada" }, { id: "a" });
  await store.nodes.Person.create({ name: "Bea" }, { id: "b" });
  await store.nodes.Person.create({ name: "Cy" }, { id: "c" });
  clearMints();
  return { store, backend };
}

type IdentityStore = Awaited<ReturnType<typeof createIdentityStore>>["store"];

/** Every `identity` facade call, reads and mutations, in a runnable order. */
function facadeCalls(
  identity: IdentityStore["identity"],
): readonly (readonly [string, () => Promise<unknown>])[] {
  return [
    ["assertSame", () => identity.assertSame(a, b)],
    ["assertDifferent", () => identity.assertDifferent(a, c)],
    ["bulkAssertSame", () => identity.bulkAssertSame([{ a, b }])],
    [
      "bulkAssertDifferent",
      () => identity.bulkAssertDifferent([{ a: b, b: c }]),
    ],
    ["classes", () => identity.classes({ limit: 10 })],
    ["representativeOf", () => identity.representativeOf(a)],
    ["membersOf", () => identity.membersOf(a)],
    ["nodesOf", () => identity.nodesOf(a)],
    ["areSame", () => identity.areSame(a, b)],
    ["areDifferent", () => identity.areDifferent(a, c)],
    ["assertionsOf", () => identity.assertionsOf(a)],
    ["explainSame", () => identity.explainSame(a, b)],
    ["transitionsOf", () => identity.transitionsOf(a)],
    ["replay", () => identity.replay(a)],
    [
      "retractDifferentAssertion",
      () => identity.retractDifferentAssertion(b, c),
    ],
    [
      "retractAssertion",
      async () => {
        const assertions = await identity.assertionsOf(a);
        const different = assertions.find(
          (assertion) => assertion.relation === "different",
        );
        clearMints();
        return identity.retractAssertion(requireDefined(different).id);
      },
    ],
    [
      "bulkRetractAssertions",
      async () => {
        const assertions = await identity.assertionsOf(a);
        clearMints();
        return identity.bulkRetractAssertions(
          assertions.map((assertion) => assertion.id),
        );
      },
    ],
    ["retractSameAssertion", () => identity.retractSameAssertion(a, b)],
  ];
}

describe("an identity call enters its operation", () => {
  afterEach(() => {
    clearMints();
  });

  it("each tx.identity call, read or mutation, enters exactly one operation of the transaction's own session", async () => {
    const { store } = await createIdentityStore(true);
    await store.transaction(async (tx) => {
      const session = await sessionOf(() =>
        tx.nodes.Person.create({ name: "Dee" }, { id: "d" }),
      );
      const observed: unknown[] = [];
      const calls = facadeCalls(tx.identity);
      for (const [label, call] of calls) {
        clearMints();
        await call();
        const scopes = enteredScopes();
        observed.push({
          at: label,
          entered: scopes.length,
          // `toBe`-strength: the same session object, not an equal one.
          fromThisSession: scopes.every((scope) => scope === session),
          sessionsOpened: openedSessions().length,
          targetEntries: targetEntries().length,
        });
      }
      expect(observed).toEqual(
        calls.map(([label]) => ({
          at: label,
          entered: 1,
          fromThisSession: true,
          sessionsOpened: 0,
          targetEntries: 0,
        })),
      );
    });
  });

  it("each store.identity read enters from the pooled root itself and opens no session", async () => {
    const { store } = await createIdentityStore(true);
    await store.identity.assertSame(a, b);
    const root = storeRuntime(store).backend;
    const reads: readonly (readonly [string, () => Promise<unknown>])[] = [
      ["classes", () => store.identity.classes({ limit: 10 })],
      ["membersOf", () => store.identity.membersOf(a)],
      ["nodesOf", () => store.identity.nodesOf(a)],
      ["areDifferent", () => store.identity.areDifferent(a, c)],
      ["explainSame", () => store.identity.explainSame(a, b)],
      ["transitionsOf", () => store.identity.transitionsOf(a)],
      ["replay", () => store.identity.replay(a)],
    ];
    const observed: unknown[] = [];
    for (const [label, read] of reads) {
      clearMints();
      await read();
      const scopes = enteredScopes();
      observed.push({
        at: label,
        entered: scopes.length,
        fromTheRoot: scopes.every((scope) => scope === root),
        sessionsOpened: openedSessions().length,
      });
    }
    expect(observed).toEqual(
      reads.map(([label]) => ({
        at: label,
        entered: 1,
        fromTheRoot: true,
        sessionsOpened: 0,
      })),
    );
  });

  it("a pinned view's identity read enters from a root backend and opens no session", async () => {
    const { store } = await createIdentityStore(true);
    await store.identity.assertSame(a, b);
    const now = await store.recordedNow();
    if (now === undefined)
      throw new Error("the history store has no recorded instant");
    const view = store.asOfRecorded(now);
    clearMints();
    const nodes = await view.identity.nodesOf(a);
    expect(nodes.map((node) => node.id).toSorted()).toEqual(["a", "b"]);
    const scopes = enteredScopes();
    expect(scopes).toHaveLength(1);
    expect(scopes[0] !== undefined && "heldGraphWriteLocks" in scopes[0]).toBe(
      false,
    );
    expect(openedSessions()).toEqual([]);
    expect(targetEntries()).toEqual([]);
  });

  it("a refused identity call enters nothing", async () => {
    const { store: historyOff } = await createIdentityStore(false);
    const { store: historyOn } = await createIdentityStore(true);
    const unregistered = { kind: "Nobody", id: "a" } as unknown as typeof a;
    const refusals: readonly (readonly [string, () => Promise<unknown>])[] = [
      [
        "membersOf, unregistered kind",
        () => historyOff.identity.membersOf(unregistered),
      ],
      [
        "areDifferent, unregistered kind",
        () => historyOff.identity.areDifferent(a, unregistered),
      ],
      ["classes, limit 0", () => historyOff.identity.classes({ limit: 0 })],
      [
        "transitionsOf, history off",
        () => historyOff.identity.transitionsOf(a),
      ],
      ["replay, bad limit", () => historyOn.identity.replay(a, { limit: 0 })],
    ];
    const observed: unknown[] = [];
    await historyOff.transaction(async (tx) => {
      for (const [label, refuse] of [
        ...refusals,
        ["tx transitionsOf, history off", () => tx.identity.transitionsOf(a)],
        [
          "tx explainSame, unregistered kind",
          () => tx.identity.explainSame(unregistered, a),
        ],
      ] as const) {
        clearMints();
        const outcome = await refuse().then(
          () => "resolved",
          () => "rejected",
        );
        observed.push({ at: label, outcome, entered: enteredScopes().length });
      }
    });
    expect(observed).toEqual(
      [
        ...refusals.map(([label]) => label),
        "tx transitionsOf, history off",
        "tx explainSame, unregistered kind",
      ].map((label) => ({ at: label, outcome: "rejected", entered: 0 })),
    );
  });

  it("an identity port call whose target arrives with no session joins as a binding of its own", async () => {
    const { store } = await createIdentityStore(false);
    await store.identity.assertSame(a, b);
    const runtime = storeRuntime(store);
    await store.transaction(async (tx) => {
      const session = await sessionOf(() =>
        tx.nodes.Person.create({ name: "Dee" }, { id: "d" }),
      );
      const target = tx[TRANSACTION_RUNTIME].backend;
      const reads: readonly (readonly [string, () => Promise<unknown>])[] = [
        [
          "identityAssertionsAtTarget",
          () => runtime.identityAssertionsAtTarget(target),
        ],
        [
          "identityAssertionsTouchingAtTarget",
          () =>
            requirePort(runtime.identityAssertionsTouchingAtTarget)(target, [
              a,
            ]),
        ],
        [
          "readIdentityAssertionPageAtTarget",
          () =>
            runtime.readIdentityAssertionPageAtTarget(target, "state", {
              limit: 10,
            }),
        ],
        [
          "assertIdentityClassesConsistentAtTarget",
          () => runtime.assertIdentityClassesConsistentAtTarget(target, [a]),
        ],
      ];
      const observed: unknown[] = [];
      for (const [label, read] of reads) {
        clearMints();
        await read();
        const [entry] = targetEntries();
        observed.push({
          at: label,
          targetEntries: targetEntries().length,
          ofTheTarget: enterTargetOperationSpy.mock.calls.every(
            ([argument]) => argument === target,
          ),
          // A binding of its own: a new session, never the transaction's.
          ownBinding:
            entry !== undefined &&
            operationEntrySession(entry) !== undefined &&
            operationEntrySession(entry) !== session,
        });
      }
      expect(observed).toEqual(
        reads.map(([label]) => ({
          at: label,
          targetEntries: 1,
          ofTheTarget: true,
          ownBinding: true,
        })),
      );
    });

    // The pooled root as the target enters as itself.
    clearMints();
    await runtime.identityAssertionsAtTarget(runtime.backend);
    expect(targetEntries()).toEqual([runtime.backend]);
    expect(openedSessions()).toEqual([]);
  });
});

function requirePort<T>(port: T | undefined): T {
  if (port === undefined) throw new Error("the runtime port lacks this member");
  return port;
}

describe("identity and search maintenance open a session where they open their transaction", () => {
  afterEach(() => {
    clearMints();
  });

  it("validateIdentity enters one operation of the session of the transaction it opens", async () => {
    const { store } = await createIdentityStore(false);
    await store.identity.assertSame(a, b);
    clearMints();
    await storeRuntime(store).validateIdentity();
    const opened = openedSessions();
    expect(opened).toHaveLength(1);
    expect(enteredScopes()).toHaveLength(1);
    expect(enteredScopes()[0]).toBe(opened[0]);
  });

  it("rebuildIdentityClosure runs under the one session its write frame opens", async () => {
    const { store } = await createIdentityStore(false);
    await store.identity.assertSame(a, b);
    clearMints();
    await storeRuntime(store).rebuildIdentityClosure();
    // The root is handed in as the entry itself, not joined as a target.
    expect(targetEntries()).toEqual([]);
    const opened = openedSessions();
    expect(opened).toHaveLength(1);
    expect(enteredScopes()).toEqual([opened[0]]);
    expect(enteredScopes()[0]).toBe(opened[0]);
  });

  it("a fulltext rebuild opens a session for each page's transaction and runs that page under it", async () => {
    const { store } = await createIdentityStore(false);
    clearMints();
    const result = await store.search.rebuildFulltext("Person", {
      pageSize: 1,
    });
    expect(result.processed).toBe(3);
    // Each page's transaction, handed in where it opened: never the root,
    // and a different transaction per page.
    const pageTransactions = enterTargetOperationSpy.mock.calls.map(
      ([transaction]) => transaction,
    );
    expect(pageTransactions.length).toBeGreaterThanOrEqual(3);
    expect(pageTransactions).not.toContain(storeRuntime(store).backend);
    expect(new Set(pageTransactions).size).toBe(pageTransactions.length);
    // Each page runs under a session of its own, opened for that transaction.
    const sessions = targetEntries().map((entry) =>
      operationEntrySession(entry),
    );
    expect(sessions).not.toContain(undefined);
    expect(new Set(sessions).size).toBe(sessions.length);
  });

  it("a contribution rebuild opens one session for the transaction the engine opens", async () => {
    const { store } = await createIdentityStore(false);
    clearMints();
    await store.rebuildContribution("fulltext");
    const opened = openedSessions();
    expect(opened).toHaveLength(1);
    expect(enteredScopes()).toHaveLength(1);
    expect(enteredScopes()[0]).toBe(opened[0]);
  });
});
