/**
 * A schema or evolution path sends its statements through an operation of
 * the session it opened where the engine handed it the transaction.
 *
 * The engine opens a schema-write or schema-commit transaction (or adopts the
 * caller's) and hands the Store its callback; the Store opens ONE session for
 * that transaction there and enters an operation of it for the work. An
 * operation's handle is, today, the very transaction object its session
 * holds, so a path that kept a whole-transaction handle and never opened a
 * session would be indistinguishable by its rows. These cases make every
 * layer distinguishable: the backend's schema-channel members hand their
 * callbacks a recording derivation of the transaction, `enterOperation` is
 * wrapped so each operation carries a recording derivation of its session's
 * transaction, and each statement the transaction receives is attributed to
 * the operation handle it came through. Each case checks, on every backend,
 * that every transaction the engine handed the Store got exactly one session
 * (by identity), and that every statement it received came through a handle
 * of an operation of that session.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../../../src";
import {
  deriveBackend,
  type ExactBackendOverlay,
} from "../../../src/backend/derive-backend";
import type { AdapterBackend } from "../../../src/backend/types";
import { defineGraphExtension } from "../../../src/graph-extension";
import { rollbackSchema } from "../../../src/schema/manager";
import * as operationScope from "../../../src/store/operation-scope";
import type { IntegrationTestContext } from "./test-context";

/** One statement member call a transaction the engine handed out received. */
type ReceivedCall = Readonly<{
  transaction: object;
  member: string;
  /** The session of the operation handle the call came through, if any. */
  session: operationScope.TransactionSession | undefined;
}>;

/** One session the Store opened, and the transaction it was opened over. */
type OpenedSession = Readonly<{
  transaction: object;
  session: operationScope.TransactionSession;
}>;

type Recording = Readonly<{
  /** Every transaction a schema-channel member handed the Store, in order. */
  handed: object[];
  received: ReceivedCall[];
  opened: OpenedSession[];
}>;

/** Members a Store transaction may read: identity and SQL compilation. */
const IDENTITY_MEMBERS: ReadonlySet<string> = new Set(["compileSql"]);

/**
 * `target` with each of its function members replaced by `wrap(member,
 * call)`, as a derivation (so every carried mark survives).
 */
function deriveWithWrappedMembers<T extends object>(
  target: T,
  wrap: (
    member: string,
    call: (...args: unknown[]) => unknown,
  ) => (...args: unknown[]) => unknown,
): T {
  const overlay: Record<string, (...args: unknown[]) => unknown> = {};
  for (const member in target) {
    if (IDENTITY_MEMBERS.has(member)) continue;
    const value: unknown = Reflect.get(target, member);
    if (typeof value !== "function") continue;
    const call = (...args: unknown[]): unknown =>
      Reflect.apply(value, target, args);
    overlay[member] = wrap(member, call);
  }
  return deriveBackend<T, Partial<T>>(
    target,
    overlay as ExactBackendOverlay<T, Partial<T>>,
  );
}

/**
 * Routes the Store's schema channel through recording layers: `backend`'s
 * schema-write, preflight and adoption members hand out a recording
 * derivation of each transaction, `openTransactionSession` records what it
 * opened a session over, and `enterOperation` gives every operation a handle
 * of its own that tags the calls it carries with its session. Restore with
 * the returned `restore()`.
 */
function recordSchemaChannel(base: AdapterBackend<unknown>) {
  const recording: Recording = { handed: [], received: [], opened: [] };
  // The session of the operation handle a call is passing through right now.
  // A handle tags synchronously around its call into the transaction, so no
  // await separates the tag from the call it attributes.
  let throughSession: operationScope.TransactionSession | undefined;

  function handOut<T extends object>(transaction: T): T {
    const recorded = deriveWithWrappedMembers(
      transaction,
      (member, call) =>
        (...args) => {
          recording.received.push({
            transaction: recorded,
            member,
            session: throughSession,
          });
          return call(...args);
        },
    );
    recording.handed.push(recorded);
    return recorded;
  }

  const schemaWriteTransaction = base.schemaWriteTransaction;
  const commitWithPreflight = base.commitSchemaVersionWithPreflight;
  const setActiveWithPreflight = base.setActiveVersionWithPreflight;
  const adoptSchemaWrite = base.adoptSchemaWriteTransaction;
  const adopt = base.adoptTransaction;
  const backend = deriveBackend(base, {
    ...(schemaWriteTransaction === undefined ?
      {}
    : {
        schemaWriteTransaction: (graphId, fn, options) =>
          schemaWriteTransaction(
            graphId,
            (transaction) => fn(handOut(transaction)),
            options,
          ),
      }),
    ...(commitWithPreflight === undefined ?
      {}
    : {
        commitSchemaVersionWithPreflight: (params, preflight) =>
          commitWithPreflight(params, (transaction) =>
            preflight(handOut(transaction)),
          ),
      }),
    ...(setActiveWithPreflight === undefined ?
      {}
    : {
        setActiveVersionWithPreflight: (params, preflight) =>
          setActiveWithPreflight(params, (transaction) =>
            preflight(handOut(transaction)),
          ),
      }),
    ...(adoptSchemaWrite === undefined ?
      {}
    : {
        adoptSchemaWriteTransaction: async (externalTx, graphId, options) => {
          const adopted = await adoptSchemaWrite(externalTx, graphId, options);
          return { ...adopted, backend: handOut(adopted.backend) };
        },
      }),
    adoptTransaction: (externalTx) => handOut(adopt(externalTx)),
  });

  const openTransactionSession = operationScope.openTransactionSession;
  const opened = vi
    .spyOn(operationScope, "openTransactionSession")
    .mockImplementation((transaction) => {
      const session = openTransactionSession(transaction);
      recording.opened.push({ transaction, session });
      return session;
    });

  const enterOperation = operationScope.enterOperation;
  function routedEnter(
    scope: operationScope.EntryScope,
  ): operationScope.OperationEntry {
    const entry = enterOperation(scope);
    const session = operationScope.operationEntrySession(entry);
    if (session === undefined) return entry;
    const handle = deriveWithWrappedMembers(
      operationScope.operationEntryBackend(entry),
      (_member, call) =>
        (...args) => {
          const outer = throughSession;
          throughSession = session;
          try {
            return call(...args);
          } finally {
            throughSession = outer;
          }
        },
    );
    const routed: object = { ...entry, backend: handle };
    return routed as operationScope.OperationEntry;
  }
  const entered = vi
    .spyOn(operationScope, "enterOperation")
    .mockImplementation(routedEnter);

  return {
    backend,
    recording,
    restore: () => {
      entered.mockRestore();
      opened.mockRestore();
    },
  };
}

/**
 * Every transaction the engine handed the Store got exactly one session, and
 * every statement it received came through a handle of an operation of that
 * session. Returns the number of statements so checked.
 */
function expectOneSessionPerHandedTransaction(recording: Recording): number {
  expect(recording.handed.length).toBeGreaterThan(0);
  let checked = 0;
  for (const transaction of recording.handed) {
    const sessions = recording.opened.filter(
      (opened) => opened.transaction === transaction,
    );
    expect(sessions).toHaveLength(1);
    const [only] = sessions;
    if (only === undefined) continue;
    expect(only.transaction).toBe(transaction);
    for (const call of recording.received) {
      if (call.transaction !== transaction) continue;
      expect(call.session).toBe(only.session);
      checked += 1;
    }
  }
  return checked;
}

const RoutedPerson = defineNode("RoutedPerson", {
  schema: z.object({ name: z.string() }),
});
const RoutedAuthor = defineNode("RoutedAuthor", {
  schema: z.object({ penName: z.string() }),
});
const routedDependsOn = defineEdge("routedDependsOn", {
  schema: z.object({}),
});
const routedKnows = defineEdge("routedKnows", {
  schema: z.object({ label: z.string() }),
});

function identityGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      RoutedPerson: { type: RoutedPerson },
      RoutedAuthor: { type: RoutedAuthor },
    },
    edges: {},
    identity: { sameIdAcrossKinds: "fold" },
  });
}

const disjointExtension = defineGraphExtension({
  ontology: [
    { metaEdge: "disjointWith", from: "RoutedPerson", to: "RoutedAuthor" },
  ],
});

const widgetExtension = defineGraphExtension({
  nodes: { RoutedWidget: { properties: { label: { type: "string" } } } },
});

function acyclicGraph(id: string, acyclic: boolean) {
  return defineGraph({
    id,
    nodes: { RoutedPerson: { type: RoutedPerson } },
    edges: {
      routedDependsOn: {
        type: routedDependsOn,
        from: [RoutedPerson],
        to: [RoutedPerson],
        ...(acyclic ? { acyclic: true } : {}),
      },
    },
  });
}

function matchIdentityGraph(id: string) {
  return defineGraph({
    id,
    nodes: { RoutedPerson: { type: RoutedPerson } },
    edges: {
      routedKnows: {
        type: routedKnows,
        from: [RoutedPerson],
        to: [RoutedPerson],
        matchIdentity: { name: "routed-knows-label", fields: ["label"] },
      },
    },
  });
}

export function registerSchemaOperationRoutingIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("schema and evolution routing", () => {
    it("an identity graph's first commit and an identity evolution run their preflights through one session each", async () => {
      const base = context.getBackend();
      if (base.commitSchemaVersionWithPreflight === undefined) return;
      const channel = recordSchemaChannel(base);
      try {
        const [store] = await createAdapterStoreWithSchema(
          identityGraph("schema_routing_identity"),
          channel.backend,
        );
        const initialized = channel.recording.handed.length;
        expect(initialized).toBe(1);
        await store.nodes.RoutedPerson.create({ name: "Alice" });
        await store.evolve(disjointExtension);
        expect(channel.recording.handed).toHaveLength(initialized + 1);
        expect(
          expectOneSessionPerHandedTransaction(channel.recording),
        ).toBeGreaterThan(0);
      } finally {
        channel.restore();
      }
    });

    it("an edge match identity's first commit runs its preflight through one session", async () => {
      const base = context.getBackend();
      if (base.commitSchemaVersionWithPreflight === undefined) return;
      const channel = recordSchemaChannel(base);
      try {
        await createAdapterStoreWithSchema(
          matchIdentityGraph("schema_routing_match_identity"),
          channel.backend,
        );
        expect(channel.recording.handed).toHaveLength(1);
        expect(
          expectOneSessionPerHandedTransaction(channel.recording),
        ).toBeGreaterThan(0);
      } finally {
        channel.restore();
      }
    });

    it("a tightening migration and a reactivation run their preflights through one session each", async () => {
      const base = context.getBackend();
      if (
        base.commitSchemaVersionWithPreflight === undefined ||
        base.setActiveVersionWithPreflight === undefined
      ) {
        return;
      }
      const id = "schema_routing_tightening";
      await createAdapterStoreWithSchema(acyclicGraph(id, false), base);
      const channel = recordSchemaChannel(base);
      try {
        // v2 declares `acyclic`: committing it owes the tightening preflight.
        await createAdapterStoreWithSchema(
          acyclicGraph(id, true),
          channel.backend,
        );
        expect(channel.recording.handed).toHaveLength(1);
        // v3 drops it again; reactivating v2 owes the same preflight.
        await createAdapterStoreWithSchema(acyclicGraph(id, false), base);
        await rollbackSchema(channel.backend, id, 2);
        expect(channel.recording.handed).toHaveLength(2);
        const active = await base.getActiveSchema(id);
        expect(active?.version).toBe(2);
        expect(
          expectOneSessionPerHandedTransaction(channel.recording),
        ).toBeGreaterThan(0);
      } finally {
        channel.restore();
      }
    });

    it("a kind removal's commit and its materialization run through one session per transaction", async () => {
      const base = context.getBackend();
      if (
        base.commitSchemaVersionWithPreflight === undefined ||
        base.schemaWriteTransaction === undefined
      ) {
        return;
      }
      const channel = recordSchemaChannel(base);
      try {
        const [store] = await createAdapterStoreWithSchema(
          identityGraph("schema_routing_removal"),
          channel.backend,
        );
        const evolved = await store.evolve(widgetExtension);
        await evolved
          .getNodeCollectionOrThrow("RoutedWidget")
          .create({ label: "removed" });
        const before = channel.recording.handed.length;
        // On an identity graph the identity cascade runs inside the removal
        // commit's preflight.
        const removed = await evolved.removeKinds(["RoutedWidget"]);
        expect(channel.recording.handed.length).toBeGreaterThan(before);
        const committed = channel.recording.handed.length;
        const result = await removed.materializeRemovals();
        expect(
          result.results.filter((entry) => entry.status === "removed"),
        ).toHaveLength(1);
        // One schema-write transaction per removed kind.
        expect(channel.recording.handed).toHaveLength(committed + 1);
        expect(
          expectOneSessionPerHandedTransaction(channel.recording),
        ).toBeGreaterThan(0);
      } finally {
        channel.restore();
      }
    });

    it("an adopted evolution joins the caller's transaction through one session per adoption", async () => {
      const base = context.getBackend();
      // A backend without schema-write adoption refuses
      // `withEvolvedTransaction`; `adopted-evolution.ts` pins that refusal.
      if (base.adoptSchemaWriteTransaction === undefined) return;
      const channel = recordSchemaChannel(base);
      try {
        const [store] = await createAdapterStoreWithSchema(
          acyclicGraph("schema_routing_adopted", false),
          channel.backend,
        );
        await store.nodes.RoutedPerson.create({ name: "Alice" });
        const before = channel.recording.handed.length;
        const plan = await store.planEvolution(widgetExtension);
        if (plan.status !== "change") throw new Error("Expected change plan.");
        await base.transactionWithNative(async (_target, nativeTx) =>
          store.withEvolvedTransaction(nativeTx, plan, async (tx) => {
            await tx.nodes.RoutedPerson.create({ name: "Bob" });
          }),
        );
        // The isolation probe's ordinary adoption, then the schema-write one.
        expect(channel.recording.handed).toHaveLength(before + 2);
        const settled = channel.recording.handed.length;
        // Planned from the database again, the same extension is a no-op.
        const noop = await store.planEvolution(widgetExtension);
        if (noop.status !== "noop") throw new Error("Expected no-op plan.");
        await base.transactionWithNative(async (_target, nativeTx) =>
          store.withEvolvedTransaction(nativeTx, noop, async (tx) => {
            await tx.nodes.RoutedPerson.create({ name: "Carol" });
          }),
        );
        expect(channel.recording.handed).toHaveLength(settled + 1);
        expect(
          expectOneSessionPerHandedTransaction(channel.recording),
        ).toBeGreaterThan(0);
      } finally {
        channel.restore();
      }
    });
  });
}
