/**
 * Capture and flush statements go through an operation of the session of the
 * transaction they run in.
 *
 * A unit that opens its own transaction (the recorded capture overlay, a
 * captured autocommit write, `clear`, anchor pruning, allocation-owner
 * rotation, the recorded read overlay) opens its session where the
 * transaction opens and runs as one operation of it. A Store transaction
 * (`store.transaction`, `withTransaction`, `withRecordedTransaction`) opens
 * its session once, where it opens or joins the native transaction: the
 * statements it issues itself (an isolation check, a lock, the capture flush)
 * go through the first operation of that session, and every write of its
 * context enters an operation of the same session.
 *
 * An operation's handle is, today, the very transaction object its session
 * holds, so these cases make each operation distinguishable: `enterOperation`
 * is wrapped so every operation it mints carries a recording derivation of
 * what the session hands out, and each statement is attributed to the
 * session of the operation whose handle carried it.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import type { GraphBackend } from "../../../src/backend/types";
import * as operationScope from "../../../src/store/operation-scope";
import { requireDefined } from "../../../src/utils/presence";
import { integrationTestGraph } from "./fixtures";
import type { IntegrationTestContext } from "./test-context";

/** One statement member call through an operation's handle. */
type RoutedCall = Readonly<{
  session: operationScope.TransactionSession;
  member: string;
  phase: string;
}>;

/** The statement members a recording handle records. */
const RECORDED_MEMBERS = [
  "execute",
  "executeRaw",
  "executeStatement",
  "insertNode",
  "updateNode",
  "getNode",
  "getActiveSchema",
] as const;

type Routing = Readonly<{
  /** Every session an operation was entered from, in order of first entry. */
  sessions: operationScope.TransactionSession[];
  /** The session of every operation entered, in order. */
  entered: operationScope.TransactionSession[];
  calls: RoutedCall[];
  /** Labels the calls recorded from now on. */
  enter: (phase: string) => void;
  restore: () => void;
}>;

/**
 * Wraps `enterOperation` so every operation it mints carries a recording
 * derivation of what its session hands out.
 */
function routeOperations(): Routing {
  const sessions: operationScope.TransactionSession[] = [];
  const entered: operationScope.TransactionSession[] = [];
  const calls: RoutedCall[] = [];
  let phase = "setup";
  const enterOperation = operationScope.enterOperation;
  function recordingEnter(
    scope: operationScope.EntryScope,
  ): operationScope.OperationEntry {
    const entry = enterOperation(scope);
    const session = operationScope.operationEntrySession(entry);
    if (session === undefined) return entry;
    entered.push(session);
    if (!sessions.includes(session)) sessions.push(session);
    const transaction = operationScope.operationEntryBackend(
      entry,
    ) as GraphBackend;
    const overrides: Record<string, unknown> = {};
    for (const member of RECORDED_MEMBERS) {
      const call: unknown = transaction[member];
      if (typeof call !== "function") continue;
      overrides[member] = (...args: unknown[]): unknown => {
        calls.push({ session, member, phase });
        return Reflect.apply(call, transaction, args) as unknown;
      };
    }
    const handle = deriveBackend(
      transaction,
      overrides as Partial<GraphBackend>,
    );
    const routed: object = { ...entry, backend: handle };
    return routed as operationScope.OperationEntry;
  }
  const spy = vi
    .spyOn(operationScope, "enterOperation")
    .mockImplementation(recordingEnter);
  return {
    sessions,
    entered,
    calls,
    enter: (next) => {
      phase = next;
    },
    restore: () => {
      spy.mockRestore();
    },
  };
}

/**
 * The sessions (by order of first entry) whose operations carried a call in
 * `phase`, ascending.
 */
function sessionsRouted(routing: Routing, phase: string): readonly number[] {
  const calls = routing.calls.filter((call) => call.phase === phase);
  return [
    ...new Set(calls.map((call) => routing.sessions.indexOf(call.session))),
  ].toSorted((left, right) => left - right);
}

const RoutedItem = defineNode("RoutedItem", {
  schema: z.object({ label: z.string() }),
});
const routedLink = defineEdge("routedLink");

function routedGraph(id: string) {
  return defineGraph({
    id,
    nodes: { RoutedItem: { type: RoutedItem } },
    edges: {
      routedLink: { type: routedLink, from: [RoutedItem], to: [RoutedItem] },
    },
  });
}

export function registerCaptureFlushOperationRoutingIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("capture and flush operation routing", () => {
    it("a history transaction's writes enter its one session, and the capture flush goes through the overlay's operation", async () => {
      const store = await context.createHistoryStore(integrationTestGraph);
      const routing = routeOperations();
      try {
        const writes: operationScope.TransactionSession[] = [];
        const outcome = await store.transactionWithReceipt(async (tx) => {
          routing.enter("callback");
          const before = routing.entered.length;
          await tx.nodes.Person.create({ name: "Routed" });
          writes.push(...routing.entered.slice(before));
          routing.enter("after callback");
        });
        expect({
          sessions: routing.sessions.length,
          // The overlay's session first, then the Store's.
          writesOfTheStoreSession: writes.map(
            (session) => session === routing.sessions[1],
          ),
          callback: sessionsRouted(routing, "callback"),
          flush: sessionsRouted(routing, "after callback"),
          recorded: outcome.receipt.recorded !== undefined,
        }).toEqual({
          sessions: 2,
          writesOfTheStoreSession: writes.map(() => true),
          // The write goes through its operation of the Store session, whose
          // surface the Store bound over the transaction the overlay's
          // operation handed it.
          callback: [0, 1],
          // The capture flush, once the callback settled, goes through the
          // overlay's own operation and nothing else.
          flush: [0],
          recorded: true,
        });
        expect(writes.length).toBeGreaterThan(0);
      } finally {
        routing.restore();
      }
    });

    it("withRecordedTransaction issues its own statements and its writes through one session it opens where it joins", async () => {
      const backend = context.getBackend();
      const [store] = await createAdapterStoreWithSchema(
        routedGraph("capture_routing_adopted"),
        backend,
        { history: true },
      );
      const routing = routeOperations();
      try {
        const writes: operationScope.TransactionSession[] = [];
        routing.enter("before callback");
        const outcome = await backend.transactionWithNative((_tx, native) =>
          store.withRecordedTransaction(native, async (tx) => {
            routing.enter("callback");
            const before = routing.entered.length;
            await tx.nodes.RoutedItem.create({ label: "adopted" });
            writes.push(...routing.entered.slice(before));
            routing.enter("after callback");
          }),
        );
        expect({
          sessions: routing.sessions.length,
          writesOfTheSession: writes.map(
            (session) => session === routing.sessions[0],
          ),
          // The isolation check and the schema and graph locks: statements
          // on PostgreSQL, the writer slot on SQLite.
          before: sessionsRouted(routing, "before callback"),
          callback: sessionsRouted(routing, "callback"),
          // The capture flush.
          flush: sessionsRouted(routing, "after callback"),
          recorded: outcome.receipt.recorded !== undefined,
        }).toEqual({
          sessions: 1,
          writesOfTheSession: writes.map(() => true),
          before: backend.dialect === "postgres" ? [0] : [],
          callback: [0],
          flush: [0],
          recorded: true,
        });
        expect(writes.length).toBeGreaterThan(0);
      } finally {
        routing.restore();
      }
    });

    it("withTransaction's context and writes enter the one session it opens where it joins", async () => {
      const backend = context.getBackend();
      const [store] = await createAdapterStoreWithSchema(
        routedGraph("capture_routing_joined"),
        backend,
      );
      const routing = routeOperations();
      try {
        await backend.transactionWithNative(async (_tx, native) => {
          const tx = store.withTransaction(native);
          await tx.nodes.RoutedItem.create({ label: "joined" });
          await tx.nodes.RoutedItem.create({ label: "joined again" });
        });
        // The context's own operation and each write's: one session.
        expect({
          sessions: routing.sessions.length,
          operations: routing.entered.length,
          entered: routing.entered.every(
            (session) => session === routing.sessions[0],
          ),
        }).toEqual({ sessions: 1, operations: 3, entered: true });
      } finally {
        routing.restore();
      }
    });

    it("a captured backend write runs its write and its flush as one operation of the session it opens", async () => {
      const graph = routedGraph("capture_routing_autocommit");
      const store = await context.createHistoryStore(graph);
      const routing = routeOperations();
      try {
        routing.enter("write");
        // The history backend's own write member: the capture overlay wraps
        // it in a transaction of its own, with the flush.
        await store.backend.insertNode({
          graphId: graph.id,
          kind: "RoutedItem",
          id: "captured",
          props: { label: "captured" },
        });
        expect({
          sessions: routing.sessions.length,
          operations: routing.entered.length,
          write: sessionsRouted(routing, "write"),
          members: [
            ...new Set(routing.calls.map((call) => call.member)),
          ].includes("insertNode"),
        }).toEqual({ sessions: 1, operations: 1, write: [0], members: true });
      } finally {
        routing.restore();
      }
    });

    it("clear, anchor pruning and owner rotation each run as one operation of the session they open", async () => {
      const store = await context.createHistoryStore(integrationTestGraph);
      await store.nodes.Person.create({ name: "Before" });
      const observed: unknown[] = [];
      for (const [label, unit] of [
        [
          "pruneRecordedInstants",
          () =>
            store.pruneRecordedInstants("9999-12-31T23:59:59.999Z", {
              limit: 10,
            }),
        ],
        [
          "rotateAllocationOwner",
          async () =>
            store.rotateAllocationOwner(await store.allocationOwner()),
        ],
        ["clear", () => store.clear()],
      ] as const) {
        const routing = routeOperations();
        try {
          routing.enter("unit");
          await unit();
          observed.push({
            at: label,
            sessions: routing.sessions.length,
            operations: routing.entered.length,
            unit: sessionsRouted(routing, "unit"),
          });
        } finally {
          routing.restore();
        }
      }
      const interactive =
        store.backend.capabilities.execution.interactiveTransactions;
      expect(observed).toEqual(
        ["pruneRecordedInstants", "rotateAllocationOwner", "clear"].map(
          (label) =>
            interactive ?
              { at: label, sessions: 1, operations: 1, unit: [0] }
            : { at: label, sessions: 0, operations: 0, unit: [] },
        ),
      );
    });

    it("a recorded view's read transaction runs through an operation of each layer that opens or joins it", async () => {
      const store = await context.createHistoryStore(
        routedGraph("capture_routing_view"),
      );
      const alice = await store.nodes.RoutedItem.create({ label: "alice" });
      const bob = await store.nodes.RoutedItem.create({ label: "bob" });
      await store.edges.routedLink.create(alice, bob, {});
      const anchor = requireDefined(await store.recordedNow());
      const view = store.asOfRecorded(anchor);
      const routing = routeOperations();
      try {
        routing.enter("read");
        const components = await view.algorithms.weaklyConnectedComponents({
          edges: ["routedLink"],
        });
        // Three units, each opening a session where it opens or joins the
        // read transaction: the capture overlay under the recorded read
        // overlay under the algorithm. Each statement the algorithm sends
        // goes through an operation of each of the three, and the read
        // overlay's own origin checks through two of them.
        const perSession = routing.sessions.map(
          (session) =>
            routing.calls.filter((call) => call.session === session).length,
        );
        expect({
          found: components.some((component) => component.size === 2),
          sessions: routing.sessions.length,
          everySessionRouted: perSession.every((count) => count > 0),
        }).toEqual({ found: true, sessions: 3, everySessionRouted: true });
      } finally {
        routing.restore();
      }
    });
  });
}
