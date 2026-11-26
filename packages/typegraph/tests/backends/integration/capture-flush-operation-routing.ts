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
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../../../src";
import { RECORDED_GRAPH_WRITE_ADVISORY_LOCK_NAMESPACE } from "../../../src/backend/advisory-lock-namespaces";
import { deriveBackend } from "../../../src/backend/derive-backend";
import type { GraphBackend } from "../../../src/backend/types";
import { isSqlFragment, sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import * as operationScope from "../../../src/store/operation-scope";
import * as writeTransaction from "../../../src/store/operations/write-transaction";
import { withTransactionPreCommitHook } from "../../../src/store/recorded-capture";
import { requireDefined } from "../../../src/utils/presence";
import { integrationTestGraph } from "./fixtures";
import type { IntegrationTestContext } from "./test-context";
import {
  createEngineNativeBackend,
  runsEngineNativeScenarios,
} from "./transaction-statement-budget";

/** One statement member call through an operation's handle. */
type RoutedCall = Readonly<{
  session: operationScope.TransactionSession;
  member: string;
  phase: string;
  /** The statement's SQL text and parameters, when the member carries one. */
  text: string;
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
  "lockSchemaVersionForWrite",
] as const;

type Routing = Readonly<{
  /** Every session an operation was entered from, in order of first entry. */
  sessions: operationScope.TransactionSession[];
  /** The handle every operation entered handed out, in order of entry. */
  handles: object[];
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
  const handles: object[] = [];
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
        calls.push({
          session,
          member,
          phase,
          text: statementText(transaction, args),
        });
        return Reflect.apply(call, transaction, args) as unknown;
      };
    }
    const handle = deriveBackend(
      transaction,
      overrides as Partial<GraphBackend>,
    );
    handles.push(handle);
    const routed: object = { ...entry, backend: handle };
    return routed as operationScope.OperationEntry;
  }
  const spy = vi
    .spyOn(operationScope, "enterOperation")
    .mockImplementation(recordingEnter);
  return {
    sessions,
    handles,
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
 * A statement member call's SQL text and parameters: a raw string as given, a
 * query as the transaction compiles it, and nothing for a typed member.
 */
function statementText(
  transaction: GraphBackend,
  args: readonly unknown[],
): string {
  const [statement, params] = args;
  if (typeof statement === "string") {
    return `${statement} ${JSON.stringify(params ?? [])}`;
  }
  if (!isSqlFragment(statement) || transaction.compileSql === undefined) {
    return "";
  }
  const compiled = transaction.compileSql(statement);
  return `${compiled.sql} ${JSON.stringify(compiled.params)}`;
}

/** The recorded graph write lock's statement: its advisory key namespace. */
function isGraphWriteLock(call: RoutedCall): boolean {
  return call.text.includes(RECORDED_GRAPH_WRITE_ADVISORY_LOCK_NAMESPACE);
}

/** The recorded-capture isolation check: an isolation read and no lock. */
function isIsolationCheck(call: RoutedCall): boolean {
  return call.text.includes("transaction_isolation") && !isGraphWriteLock(call);
}

/** The schema-version lock a schema-managed write takes. */
function isSchemaLock(call: RoutedCall): boolean {
  return call.member === "lockSchemaVersionForWrite";
}

/** A capture flush statement: one that writes a recorded node version. */
function isRecordedNodeWrite(call: RoutedCall): boolean {
  return /insert into\s+\S*recorded_nodes/i.test(call.text);
}

/**
 * The sessions (by order of first entry) whose operations carried a call in
 * `phase` (and, given `matching`, one it matches), ascending.
 */
function sessionsRouted(
  routing: Routing,
  phase: string,
  matching: (call: RoutedCall) => boolean = () => true,
): readonly number[] {
  const calls = routing.calls.filter(
    (call) => call.phase === phase && matching(call),
  );
  return [
    ...new Set(calls.map((call) => routing.sessions.indexOf(call.session))),
  ].toSorted((left, right) => left - right);
}

const PRE_COMMIT_MARKER = "routed-pre-commit";
const ENGINE_INSTANT_MARKER = "routed-engine-instant";

/** A statement that carries `marker`, so its route can be picked out. */
function markerStatement(marker: string) {
  return asCompiledRowsSql(sql`SELECT ${marker} AS marker`);
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
    it("a history transaction has one session, which its writes enter and the capture flush goes through the overlay's operation of", async () => {
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
          // The overlay opens the session and hands it to the Store.
          writesOfTheSession: writes.map(
            (session) => session === routing.sessions[0],
          ),
          // The overlay's isolation check, on PostgreSQL.
          isolation: sessionsRouted(routing, "setup", isIsolationCheck),
          callback: sessionsRouted(routing, "callback"),
          flush: sessionsRouted(routing, "after callback"),
          flushWrites: sessionsRouted(
            routing,
            "after callback",
            isRecordedNodeWrite,
          ),
          recorded: outcome.receipt.recorded !== undefined,
        }).toEqual({
          sessions: 1,
          isolation: store.backend.dialect === "postgres" ? [0] : [],
          writesOfTheSession: writes.map(() => true),
          // The write goes through its operation of that session, which hands
          // out the capture surface the overlay bound it over.
          callback: [0],
          // The capture flush, once the callback settled, goes through the
          // overlay's own operation of it.
          flush: [0],
          flushWrites: [0],
          recorded: true,
        });
        expect(writes.length).toBeGreaterThan(0);
      } finally {
        routing.restore();
      }
    });

    it("a history Store's own write opens one session, the capture overlay's", async () => {
      const store = await context.createHistoryStore(
        routedGraph("capture_routing_root_write"),
      );
      const routing = routeOperations();
      try {
        routing.enter("write");
        await store.nodes.RoutedItem.create({ label: "root" });
        expect({
          sessions: routing.sessions.length,
          write: sessionsRouted(routing, "write"),
          flushWrites: sessionsRouted(routing, "write", isRecordedNodeWrite),
        }).toEqual({
          // The write opens its transaction through the capture overlay,
          // which opens the transaction's one session and hands it to the
          // write; the capture flush goes through that session too.
          sessions: 1,
          write: [0],
          flushWrites: [0],
        });
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
          // The isolation check and the graph lock (statements on PostgreSQL,
          // the writer slot on SQLite) and the schema lock.
          before: sessionsRouted(routing, "before callback"),
          // The isolation check, on PostgreSQL, and the schema lock.
          isolation: sessionsRouted(
            routing,
            "before callback",
            isIsolationCheck,
          ),
          schemaLock: sessionsRouted(routing, "before callback", isSchemaLock),
          // The recorded graph lock's own statement, on PostgreSQL.
          graphLock: sessionsRouted(
            routing,
            "before callback",
            isGraphWriteLock,
          ),
          callback: sessionsRouted(routing, "callback"),
          // The capture flush.
          flush: sessionsRouted(routing, "after callback"),
          flushWrites: sessionsRouted(
            routing,
            "after callback",
            isRecordedNodeWrite,
          ),
          recorded: outcome.receipt.recorded !== undefined,
        }).toEqual({
          sessions: 1,
          writesOfTheSession: writes.map(() => true),
          before: [0],
          isolation: backend.dialect === "postgres" ? [0] : [],
          schemaLock: [0],
          graphLock: backend.dialect === "postgres" ? [0] : [],
          callback: [0],
          flush: [0],
          flushWrites: [0],
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
          isolation: sessionsRouted(routing, "write", isIsolationCheck),
          // The flush's own statements, not only the write's.
          flushWrites: sessionsRouted(routing, "write", isRecordedNodeWrite),
          members: [
            ...new Set(routing.calls.map((call) => call.member)),
          ].includes("insertNode"),
        }).toEqual({
          sessions: 1,
          operations: 1,
          write: [0],
          isolation: store.backend.dialect === "postgres" ? [0] : [],
          flushWrites: [0],
          members: true,
        });
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
        // Two sessions over the read transaction: the one the capture
        // overlay opens and hands the recorded read overlay above it, and
        // the one the algorithm opens over the read overlay's surface. Each
        // statement the algorithm sends goes through an operation of each,
        // and the read overlay's own origin checks through the first.
        const perSession = routing.sessions.map(
          (session) =>
            routing.calls.filter((call) => call.session === session).length,
        );
        expect({
          found: components.some((component) => component.size === 2),
          sessions: routing.sessions.length,
          everySessionRouted: perSession.every((count) => count > 0),
        }).toEqual({ found: true, sessions: 2, everySessionRouted: true });
      } finally {
        routing.restore();
      }
    });

    it("a store-owned transaction runs its pre-commit hook through the first operation of the session that issues it", async () => {
      const backend = context.getBackend();
      const [plain] = await createAdapterStoreWithSchema(
        routedGraph("capture_routing_precommit"),
        backend,
      );
      const history = await context.createHistoryStore(
        routedGraph("capture_routing_precommit_history"),
      );
      const observed: unknown[] = [];
      for (const [label, store] of [
        ["plain", plain],
        ["history", history],
      ] as const) {
        const routing = routeOperations();
        try {
          const options = withTransactionPreCommitHook(
            undefined,
            async ({ backend: target }) => {
              routing.enter("pre-commit");
              await target.execute(markerStatement(PRE_COMMIT_MARKER));
              routing.enter("after pre-commit");
            },
          );
          await store.transaction(async (tx) => {
            await tx.nodes.RoutedItem.create({ label });
          }, options);
          observed.push({
            at: label,
            hook: sessionsRouted(routing, "pre-commit", (call) =>
              call.text.includes(PRE_COMMIT_MARKER),
            ),
          });
        } finally {
          routing.restore();
        }
      }
      // A plain Store's attempt settles the hook itself; the history Store's
      // capture overlay claims it and fires it after its flush. Each goes
      // through the first operation of the session that issues it.
      expect(observed).toEqual([
        { at: "plain", hook: [0] },
        { at: "history", hook: [0] },
      ]);
    });

    it("a store-owned transaction's write session issues its own statements through the first operation of its session", async () => {
      const backend = context.getBackend();
      const [store] = await createAdapterStoreWithSchema(
        routedGraph("capture_routing_revision"),
        backend,
        { revisionTracking: true },
      );
      const routing = routeOperations();
      // The write session's own statements are not the routing handles'
      // operations, so its end-of-callback revision advance cannot be
      // observed through them here: the opener it is handed is checked
      // instead, and `tests/write-transaction-session-opener.test.ts` shows
      // that its own statements go through that opener.
      const withWriteTransactionSession =
        writeTransaction.withWriteTransactionSession;
      const openers: unknown[] = [];
      const spy = vi
        .spyOn(writeTransaction, "withWriteTransactionSession")
        .mockImplementation((session, target, opener, ...rest) => {
          openers.push(opener);
          return withWriteTransactionSession(session, target, opener, ...rest);
        });
      try {
        await store.transaction(async (tx) => {
          await tx.nodes.RoutedItem.create({ label: "tracked" });
        });
        expect({
          sessions: routing.sessions.length,
          openerIsTheFirstOperation: openers.map(
            (opener) => opener === routing.handles[0],
          ),
        }).toEqual({ sessions: 1, openerIsTheFirstOperation: [true] });
      } finally {
        spy.mockRestore();
        routing.restore();
      }
    });

    it("an engine-native transaction reads its pending instant through the first operation of its session", async (ctx) => {
      if (!runsEngineNativeScenarios(context)) ctx.skip();
      const engine = await PGlite.create();
      try {
        const backend = await createEngineNativeBackend(
          engine,
          async (session) => {
            await session.execute(markerStatement(ENGINE_INSTANT_MARKER));
            return {
              revision: "engine-routing-r1",
              recordedAt: "2026-01-01T00:00:00.000Z",
            };
          },
        );
        const [store] = await createAdapterStoreWithSchema(
          routedGraph("capture_routing_engine_native"),
          backend,
          { history: true },
        );
        const observed: unknown[] = [];
        for (const [label, run] of [
          [
            "store-owned",
            () =>
              store.transactionWithReceipt(async (tx) => {
                await tx.nodes.RoutedItem.create({ label: "owned" });
              }),
          ],
          [
            "adopted",
            () =>
              backend.transactionWithNative((_tx, native) =>
                store.withRecordedTransaction(native, async (tx) => {
                  await tx.nodes.RoutedItem.create({ label: "adopted" });
                }),
              ),
          ],
        ] as const) {
          const routing = routeOperations();
          try {
            routing.enter("transaction");
            const outcome = await run();
            observed.push({
              at: label,
              recorded: outcome.receipt.recorded !== undefined,
              instant: sessionsRouted(routing, "transaction", (call) =>
                call.text.includes(ENGINE_INSTANT_MARKER),
              ),
            });
          } finally {
            routing.restore();
          }
        }
        expect(observed).toEqual([
          { at: "store-owned", recorded: true, instant: [0] },
          { at: "adopted", recorded: true, instant: [0] },
        ]);
      } finally {
        await engine.close();
      }
    });
  });
}
