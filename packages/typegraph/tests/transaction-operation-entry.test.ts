/**
 * Where a privileged transaction-bound internal enters its operation.
 *
 * Provenance and a working copy's durable operation are handed a transaction
 * context, not a session. The session reaches them as a value the context's
 * runtime carries (`enterTransactionOperation`), never by looking anything up:
 * so each call enters one operation of the session of the transaction it runs
 * in — the same object the transaction's own writes enter from, through
 * `tx.measure` scopes too — after its refusals. A runtime this copy of
 * TypeGraph did not build carries no session; its transaction joins as a
 * binding of its own.
 *
 * Operations change nothing a database can observe yet, so these cases watch
 * the mints themselves: the operation-scope module is wrapped with spies that
 * call through to the real functions.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";
import { UnsupportedBackendCapabilityError } from "../src/errors";
import { createRetractionCapability } from "../src/provenance";
import type * as OperationScopeModule from "../src/store/operation-scope";
import {
  enterOperation,
  enterTransactionOperation,
  type EntryScope,
  openBoundTransactionSession,
  openTransactionSession,
  operationEntrySession,
  type TransactionSession,
} from "../src/store/operation-scope";
import { transactionBackend } from "../src/store/runtime-port";
import { TRANSACTION_RUNTIME } from "../src/store/types";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend } from "./test-utils";

/**
 * The session each `openRootTransaction` call handed its callback: the one a
 * root's own `transaction` member opened (the capture overlay's), or the one
 * the mint opened over what the member handed out, inside the mint module
 * where the `openTransactionSession` spy cannot see.
 */
const rootTransactionSessions = vi.hoisted((): unknown[] => []);

vi.mock("../src/store/operation-scope", async (importOriginal) => {
  const actual: typeof OperationScopeModule = await importOriginal();
  return {
    ...actual,
    enterOperation: vi.fn(actual.enterOperation),
    enterTransactionOperation: vi.fn(actual.enterTransactionOperation),
    openTransactionSession: vi.fn(actual.openTransactionSession),
    openRootTransaction: vi.fn(
      (...[root, fn, options]: Parameters<typeof actual.openRootTransaction>) =>
        actual.openRootTransaction(
          root,
          (session) => {
            rootTransactionSessions.push(session);
            return fn(session);
          },
          options,
        ),
    ),
    openBoundTransactionSession: vi.fn(actual.openBoundTransactionSession),
  };
});

const enterOperationSpy = vi.mocked(enterOperation);
const enterTransactionOperationSpy = vi.mocked(enterTransactionOperation);
const openTransactionSessionSpy = vi.mocked(openTransactionSession);
const openBoundTransactionSessionSpy = vi.mocked(openBoundTransactionSession);

const Source = defineNode("Source", {
  schema: z.object({
    label: z.string(),
    retracted: z.boolean().default(false),
  }),
});
const Fact = defineNode("Fact", { schema: z.object({ label: z.string() }) });
const Justification = defineNode("Justification", {
  schema: z.object({ label: z.string() }),
});
const premiseOf = defineEdge("premiseOf");
const derives = defineEdge("derives");
const graph = defineGraph({
  id: "transaction_operation_entry",
  nodes: {
    Source: { type: Source },
    Fact: { type: Fact },
    Justification: { type: Justification },
  },
  edges: {
    premiseOf: { type: premiseOf, from: [Source], to: [Justification] },
    derives: { type: derives, from: [Justification], to: [Fact] },
  },
});
const config = {
  source: { kind: "Source" },
  justification: { kind: "Justification" },
  fact: { kinds: ["Fact"] },
  premiseOf: { kind: "premiseOf" },
  derives: { kind: "derives" },
} as const;

/**
 * The scope each operation entered since the last clear was entered from:
 * each `enterOperation` call's, then the session of each operation
 * `enterTransactionOperation` returned (it enters inside the mint module,
 * where the `enterOperation` spy cannot see).
 */
function enteredScopes(): readonly EntryScope[] {
  return [
    ...enterOperationSpy.mock.calls.map(([scope]) => scope),
    ...enterTransactionOperationSpy.mock.results.map((result) => {
      if (result.type !== "return") throw new Error("mint threw");
      return requireDefined(operationEntrySession(result.value));
    }),
  ];
}

/**
 * What each `openTransactionSession` call since the last clear returned, then
 * each session an `openRootTransaction` call handed its callback.
 */
function openedSessions(): readonly TransactionSession[] {
  return [
    ...openTransactionSessionSpy.mock.results.map((result) => {
      if (result.type !== "return") throw new Error("mint threw");
      const session: TransactionSession = result.value;
      return session;
    }),
    ...rootTransactionSessions.map((session) => session as TransactionSession),
  ];
}

/**
 * The session each `openBoundTransactionSession` call since the last clear
 * opened: where `store.transaction` opens its session over the transaction
 * whose writes go through a surface it binds. It opens that session inside
 * the mint module, where the `openTransactionSession` spy cannot see.
 */
async function boundSessions(): Promise<readonly TransactionSession[]> {
  return Promise.all(
    openBoundTransactionSessionSpy.mock.results.map(async (result) => {
      if (result.type !== "return") throw new Error("mint threw");
      const { session } = await result.value;
      return session;
    }),
  );
}

function clearMints(): void {
  enterOperationSpy.mockClear();
  enterTransactionOperationSpy.mockClear();
  openTransactionSessionSpy.mockClear();
  rootTransactionSessions.length = 0;
  openBoundTransactionSessionSpy.mockClear();
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

async function seeded() {
  const [store] = await createStoreWithSchema(graph, createTestBackend(), {
    history: true,
  });
  const source = await store.nodes.Source.create(
    { label: "source", retracted: false },
    { id: "source" },
  );
  const fact = await store.nodes.Fact.create({ label: "fact" }, { id: "fact" });
  const justification = await store.nodes.Justification.create(
    { label: "justification" },
    { id: "justification" },
  );
  await store.edges.premiseOf.create(source, justification, {});
  await store.edges.derives.create(justification, fact, {});
  return { store, fact, provenance: createRetractionCapability(store, config) };
}

afterEach(() => {
  clearMints();
});

describe("a transaction-bound internal enters an operation of its transaction's session", () => {
  it("holding(tx) and assertHolds(tx) enter from the session the transaction's writes enter from, through a measure scope too", async () => {
    const { store, fact, provenance } = await seeded();
    await store.transactionWithReceipt(async (tx) => {
      const session = await sessionOf(() =>
        tx.nodes.Source.create({ label: "other", retracted: false }),
      );

      // The fences enter one operation through the runtime port; the read
      // enters its own.
      clearMints();
      await provenance.holding(tx);
      expect(enteredScopes()).toHaveLength(2);
      for (const scope of enteredScopes()) expect(scope).toBe(session);

      clearMints();
      await provenance.assertHolds(tx, [fact]);
      expect(enteredScopes()).toHaveLength(2);
      for (const scope of enteredScopes()) expect(scope).toBe(session);

      // A measure scope builds a runtime of its own, carrying the same session.
      await tx.measure(async (scoped) => {
        clearMints();
        await provenance.holding(scoped);
        expect(enteredScopes()).toHaveLength(2);
        for (const scope of enteredScopes()) expect(scope).toBe(session);
      });

      // No session was opened for any of them.
      expect(openedSessions()).toEqual([]);
    });
  });

  it("holding() and a retraction enter only from the one session of the transaction they open", async () => {
    const { store, provenance } = await seeded();
    const source = { kind: "Source" as const, id: "source" };

    // A history store's backend is the recorded capture overlay: it opens
    // the native transaction and its one session, binds that session over
    // the capture surface, and runs its isolation check, flush and pre-commit
    // hook as one operation of it. `store.transaction` receives that session
    // (`openRootTransaction`) and enters every other operation from it.
    function entered(session: TransactionSession | undefined): number {
      return enteredScopes().filter((scope) => scope === session).length;
    }

    clearMints();
    await provenance.holding();
    const [holdingSession] = openedSessions();
    expect(openedSessions()).toHaveLength(1);
    expect(await boundSessions()).toEqual([holdingSession]);
    // The overlay's operation, the transaction's opener and its context, and
    // holding()'s one operation, which the lock and the read share.
    expect({
      session: entered(holdingSession),
      holding: enterTransactionOperationSpy.mock.results.map((result) =>
        result.type === "return" ?
          operationEntrySession(result.value)
        : undefined,
      ),
      all: enteredScopes().length,
    }).toEqual({ session: 4, holding: [holdingSession], all: 4 });

    clearMints();
    await provenance.retract(source);
    const [retractSession] = openedSessions();
    expect(openedSessions()).toHaveLength(1);
    expect(await boundSessions()).toEqual([retractSession]);
    // The overlay's operation, the transaction's opener and its context, the
    // fences, the transition's reads, the source update and the fact's
    // close: one operation each, all of the transaction's one session.
    expect({
      session: entered(retractSession),
      all: enteredScopes().length,
    }).toEqual({ session: 7, all: 7 });
    expect(store.graphId).toBe(graph.id);
  });

  it("a refused call enters nothing", async () => {
    const { store, fact, provenance } = await seeded();
    const [other] = await createStoreWithSchema(graph, createTestBackend(), {
      history: true,
    });

    await store.transaction(
      async (tx) => {
        clearMints();
        await expect(provenance.assertHolds(tx, [fact])).rejects.toThrow(
          UnsupportedBackendCapabilityError,
        );
        expect(enteredScopes()).toEqual([]);
      },
      { accessMode: "read_only" },
    );

    await other.transaction(async (foreign) => {
      clearMints();
      await expect(provenance.holding(foreign)).rejects.toThrow(
        ConfigurationError,
      );
      await expect(provenance.assertHolds(foreign, [fact])).rejects.toThrow(
        ConfigurationError,
      );
      expect(enteredScopes()).toEqual([]);
    });

    clearMints();
    await expect(
      provenance.retract({ kind: "Fact" as "Source", id: "fact" }),
    ).rejects.toThrow(ConfigurationError);
    expect(enteredScopes()).toEqual([]);
    expect(openedSessions()).toEqual([]);
  });

  it("a runtime that carries no session joins its transaction as a binding of its own", async () => {
    const { store } = await seeded();
    await store.transaction(async (tx) => {
      const session = await sessionOf(() =>
        tx.nodes.Source.create({ label: "other", retracted: false }),
      );
      // The runtime port as another copy of TypeGraph builds it: the public
      // runtime members, no session.
      const foreign = {
        [TRANSACTION_RUNTIME]: { backend: transactionBackend(tx) },
      };
      const operation = enterTransactionOperation(foreign);
      const joined = requireDefined(operationEntrySession(operation));
      expect(joined).not.toBe(session);
      expect(operation.backend).toBe(transactionBackend(tx));
      // Two entries from the foreign context are two operations of two
      // bindings: nothing is looked up from the transaction object.
      const again = enterTransactionOperation(foreign);
      expect(operationEntrySession(again)).not.toBe(joined);
      // The context itself enters from its own session.
      expect(operationEntrySession(enterTransactionOperation(tx))).toBe(
        session,
      );
    });
  });
});
