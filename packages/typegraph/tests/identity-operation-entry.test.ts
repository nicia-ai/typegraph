/**
 * Where an identity or search maintenance call enters its operation.
 *
 * Each call of an identity facade, a read or a mutation, enters ONE
 * `Operation` of the facade's scope after its statement-free refusals: the
 * session of the transaction whose context offers the facade (`tx.identity`),
 * or the pooled root itself (`store.identity`), which allocates no session. A
 * Store identity port member runs in the operation its caller hands it, of
 * the caller's session, and opens none of its own. Identity maintenance, the
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
import type * as ResolvedNodeClaimsModule from "../src/store/claims/resolved-node-claims";
import { applyResolvedNodeClaims } from "../src/store/claims/resolved-node-claims";
import type * as OperationScopeModule from "../src/store/operation-scope";
import {
  enterOperation,
  enterTargetOperation,
  enterTransactionOperation,
  type EntryScope,
  openTransactionSession,
  type OperationEntry,
  operationEntrySession,
  portOperationEntry,
  type TransactionSession,
} from "../src/store/operation-scope";
import { storeRuntime } from "../src/store/runtime-port";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend } from "./test-utils";

vi.mock("../src/store/claims/resolved-node-claims", async (importOriginal) => {
  const actual: typeof ResolvedNodeClaimsModule = await importOriginal();
  return {
    ...actual,
    applyResolvedNodeClaims: vi.fn(actual.applyResolvedNodeClaims),
  };
});

vi.mock("../src/store/operation-scope", async (importOriginal) => {
  const actual: typeof OperationScopeModule = await importOriginal();
  return {
    ...actual,
    enterOperation: vi.fn(actual.enterOperation),
    enterTargetOperation: vi.fn(actual.enterTargetOperation),
    openTransactionSession: vi.fn(actual.openTransactionSession),
    operationEntrySession: vi.fn(actual.operationEntrySession),
    portOperationEntry: vi.fn(actual.portOperationEntry),
  };
});

const enterOperationSpy = vi.mocked(enterOperation);
const enterTargetOperationSpy = vi.mocked(enterTargetOperation);
const openTransactionSessionSpy = vi.mocked(openTransactionSession);
const operationEntrySessionSpy = vi.mocked(operationEntrySession);
const applyResolvedNodeClaimsSpy = vi.mocked(applyResolvedNodeClaims);
const portOperationEntrySpy = vi.mocked(portOperationEntry);

const Person = defineNode("Person", {
  schema: z.object({ name: searchable() }),
});
const graph = defineGraph({
  id: "identity_operation_entry",
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

const Tagged = defineNode("Tagged", { schema: z.object({ tag: z.string() }) });
const uniqueGraph = defineGraph({
  id: "identity_operation_entry_unique",
  nodes: {
    Tagged: {
      type: Tagged,
      unique: [
        { name: "tag", fields: ["tag"], scope: "kind", collation: "binary" },
      ],
    },
  },
  edges: {},
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

  it("an identity port member runs in the operation its caller hands it, and opens no session", async () => {
    const { store } = await createIdentityStore(true);
    await store.identity.assertSame(a, b);
    const runtime = storeRuntime(store);
    const [assertion] = await runtime.identityAssertionsAtTarget(
      runtime.backend,
    );
    if (assertion === undefined) throw new Error("no assertion stored");
    const observed: unknown[] = [];
    await store.transaction(async (tx) => {
      // What merge apply and export hand a member: an operation of the
      // session of the transaction they hold.
      const operation = enterTransactionOperation(tx);
      const session = operationEntrySession(operation);
      if (session === undefined) throw new Error("no session entered");
      const members: readonly (readonly [string, () => Promise<unknown>])[] = [
        [
          "identityAssertionsAtTarget",
          () => runtime.identityAssertionsAtTarget(operation),
        ],
        [
          "identityAssertionsTouchingAtTarget",
          () =>
            requirePort(runtime.identityAssertionsTouchingAtTarget)(operation, [
              a,
            ]),
        ],
        [
          "readIdentityAssertionPageAtTarget",
          () =>
            runtime.readIdentityAssertionPageAtTarget(operation, "state", {
              limit: 10,
            }),
        ],
        [
          "readIdentityTransitionPageAtTarget",
          () =>
            runtime.readIdentityTransitionPageAtTarget(operation, {
              limit: 10,
            }),
        ],
        [
          "identityTransitionRetentionAtTarget",
          () => runtime.identityTransitionRetentionAtTarget(operation),
        ],
        [
          "assertIdentityClassesConsistentAtTarget",
          () => runtime.assertIdentityClassesConsistentAtTarget(operation, [a]),
        ],
        [
          // A write: its identity mutation's write frame runs under the
          // caller's operation, so every session it reads is the caller's.
          "applyIdentityMergeAtTarget",
          () =>
            runtime.applyIdentityMergeAtTarget(
              operation,
              [{ ...assertion, validTo: new Date().toISOString() }],
              [],
            ),
        ],
        [
          "deleteNodeWithPolicy",
          () => runtime.deleteNodeWithPolicy(operation, c),
        ],
      ];
      for (const [label, call] of members) {
        clearMints();
        portOperationEntrySpy.mockClear();
        operationEntrySessionSpy.mockClear();
        await call();
        observed.push({
          at: label,
          ...runIn(operation, session),
        });
      }
    });
    expect(observed).toEqual(
      [
        "identityAssertionsAtTarget",
        "identityAssertionsTouchingAtTarget",
        "readIdentityAssertionPageAtTarget",
        "readIdentityTransitionPageAtTarget",
        "identityTransitionRetentionAtTarget",
        "assertIdentityClassesConsistentAtTarget",
        "applyIdentityMergeAtTarget",
        "deleteNodeWithPolicy",
      ].map((label) => ({ at: label, ...RAN_IN_THE_CALLERS_OPERATION })),
    );

    // The pooled root as the entry enters as itself.
    clearMints();
    portOperationEntrySpy.mockClear();
    await runtime.identityAssertionsAtTarget(runtime.backend);
    expect(portOperationEntrySpy.mock.calls.map(([entry]) => entry)).toEqual([
      runtime.backend,
    ]);
    expect(openedSessions()).toEqual([]);
  });

  it("the resolved-uniqueness member runs its claim work in the caller's operation", async () => {
    const backend = createTestBackend();
    const [store] = await createAdapterStoreWithSchema(uniqueGraph, backend);
    const runtime = storeRuntime(store);
    let observed: unknown;
    await store.transaction(async (tx) => {
      const operation = enterTransactionOperation(tx);
      const session = operationEntrySession(operation);
      if (session === undefined) throw new Error("no session entered");
      clearMints();
      portOperationEntrySpy.mockClear();
      operationEntrySessionSpy.mockClear();
      applyResolvedNodeClaimsSpy.mockClear();
      await runtime.applyResolvedNodeUniqueness(
        operation,
        {
          upserts: [{ kind: "Tagged", id: "t1", props: { tag: "x" } }],
          releases: [],
        },
        () => tx.nodes.Tagged.create({ tag: "x" }, { id: "t1" }),
      );
      observed = {
        ...runIn(operation, session),
        // The clear-and-rebuild claim work ran, on the caller's own handle.
        claimWorkOn: applyResolvedNodeClaimsSpy.mock.calls.map(
          ([, backend]) => backend === operation.backend,
        ),
      };
    });
    expect(observed).toEqual({
      ...RAN_IN_THE_CALLERS_OPERATION,
      claimWorkOn: [true],
    });
  });
});

/** What {@link runIn} reports for a member that ran in its caller's operation. */
const RAN_IN_THE_CALLERS_OPERATION = {
  entries: 1,
  ranInTheCallersOperation: true,
  everySessionReadIsTheCallers: true,
  openedSessions: 0,
  targetEntries: 0,
  otherSessionsEntered: 0,
} as const;

/**
 * Where one port member call (since the mints were last cleared) ran: the
 * entry it checked (`portOperationEntry`), every session read through an
 * entry during the call, and every session an operation was entered from,
 * each compared by identity with the caller's.
 */
function runIn(operation: OperationEntry, session: TransactionSession) {
  const [checked] = portOperationEntrySpy.mock.calls.map(([entry]) => entry);
  const sessionsRead = operationEntrySessionSpy.mock.results.map((result) => {
    if (result.type !== "return") throw new Error("read threw");
    return result.value;
  });
  return {
    entries: portOperationEntrySpy.mock.calls.length,
    ranInTheCallersOperation: checked === operation,
    everySessionReadIsTheCallers: sessionsRead.every(
      (read) => read === undefined || read === session,
    ),
    openedSessions: openedSessions().length,
    targetEntries: enterTargetOperationSpy.mock.calls.length,
    otherSessionsEntered: enteredScopes().filter(
      (scope) => "heldGraphWriteLocks" in scope && scope !== session,
    ).length,
  };
}

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
