/**
 * Provenance and interchange send their own statements through an operation
 * of the session of the transaction they run in.
 *
 * An operation's handle is, today, the very transaction object its session
 * holds, so a path that sent its statements to that transaction some other
 * way is indistinguishable from one that used a handle. These cases make the
 * handle distinguishable, as `read-operation-routing` does: `enterOperation`
 * is wrapped so each operation it mints carries its own recording derivation
 * of the transaction, and each path is checked, on every backend, to have
 * sent the reads and writes only it makes through such a handle, of the
 * session the transaction's other work entered from (by identity) or of the
 * one session the path opened for a transaction it opened itself.
 *
 * These stores are history stores, so the native transaction a path opens is
 * opened by the recorded capture overlay, which runs its own work (an
 * isolation check, the capture flush) as the first operation of a session of
 * its own and hands the Store a statement surface over that operation's
 * handle. Every statement of the Store's session therefore passes through the
 * overlay's recording handle too; a call is attributed to the first recording
 * handle it reaches, the operation that issued it, and the overlay's session
 * is told apart as the first one entered.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../../../src";
import { RECORDED_GRAPH_WRITE_ADVISORY_LOCK_NAMESPACE } from "../../../src/backend/advisory-lock-namespaces";
import {
  resolveWriteFencePlan,
  type WriteFenceTarget,
} from "../../../src/backend/capabilities/write-fence";
import { deriveBackend } from "../../../src/backend/derive-backend";
import type { GraphBackend } from "../../../src/backend/types";
import { openProvenanceStore } from "../../../src/graph-merge";
import { exportGraphStream } from "../../../src/interchange";
import { createRetractionCapability } from "../../../src/provenance";
import { renderSql, type SqlFragment } from "../../../src/query/sql-fragment";
import * as operationScope from "../../../src/store/operation-scope";
import type { IntegrationTestContext } from "./test-context";

/** One backend member call that went through a recording handle. */
type RoutedCall = Readonly<{
  session: operationScope.TransactionSession;
  /** The operation the call went through, in the order they were entered. */
  operation: number;
  member: string;
  /** The `kind` the call names, for the members that take one. */
  kind: string | undefined;
  /** The statement an `execute` call sent. */
  statement: SqlFragment | undefined;
}>;

/** The `kind` a recorded call names: a positional kind or a `{ kind }` query. */
function kindOf(member: string, args: readonly unknown[]): string | undefined {
  const [first, second] = args;
  if (
    (member === "getNode" || member === "getNodes") &&
    typeof second === "string"
  )
    return second;
  if (typeof first === "object" && first !== null && "kind" in first) {
    const kind: unknown = first.kind;
    return typeof kind === "string" ? kind : undefined;
  }
  return undefined;
}

type Recording = Readonly<{
  calls: RoutedCall[];
  /** The session each operation was entered from, by operation number. */
  entered: operationScope.TransactionSession[];
  /** The operations a transaction-bound internal entered itself. */
  transactionEntries: number[];
  restore: () => void;
}>;

/**
 * Wraps the entry mints (`enterOperation`, and `enterTransactionOperation`,
 * which a transaction-bound internal enters through) so every operation of a
 * session gets a handle of its own: a derivation of the session's transaction
 * that records each listed member call it carries, then calls through.
 */
function routeOperationsThroughRecordingHandles(): Recording {
  const calls: RoutedCall[] = [];
  const entered: operationScope.TransactionSession[] = [];
  const transactionEntries: number[] = [];
  const enterOperation = operationScope.enterOperation;
  const enterTransactionOperation = operationScope.enterTransactionOperation;
  // How many recorded calls are on the stack: a handle forwards to the handle
  // beneath it synchronously, so a call made while one is already running is
  // that call passing through a lower operation's handle, not a new one.
  let forwarding = 0;
  function recordingEntry(
    entry: operationScope.OperationEntry,
  ): operationScope.OperationEntry {
    const enteredFrom = operationScope.operationEntrySession(entry);
    if (enteredFrom === undefined) return entry;
    const session: operationScope.TransactionSession = enteredFrom;
    const operation = entered.length;
    entered.push(session);
    const transaction = operationScope.operationEntryBackend(
      entry,
    ) as GraphBackend;
    /** `call`, recorded as a call of `member` through this operation. */
    function recorded<Arguments extends unknown[], Result>(
      member: string,
      call: (...args: Arguments) => Result,
    ): (...args: Arguments) => Result {
      return (...args) => {
        if (forwarding === 0) {
          calls.push({
            session,
            operation,
            member,
            kind: kindOf(member, args),
            statement:
              member === "execute" ? (args[0] as SqlFragment) : undefined,
          });
        }
        forwarding += 1;
        try {
          return call.apply(transaction, args);
        } finally {
          forwarding -= 1;
        }
      };
    }
    const { executeRaw, executeStatement, getNodes } = transaction;
    const handle = deriveBackend(transaction, {
      execute: recorded("execute", transaction.execute),
      ...(executeRaw === undefined ?
        {}
      : { executeRaw: recorded("executeRaw", executeRaw) }),
      ...(executeStatement === undefined ?
        {}
      : { executeStatement: recorded("executeStatement", executeStatement) }),
      getNode: recorded("getNode", transaction.getNode),
      ...(getNodes === undefined ?
        {}
      : { getNodes: recorded("getNodes", getNodes) }),
      findNodesByKind: recorded("findNodesByKind", transaction.findNodesByKind),
      findEdgesByKind: recorded("findEdgesByKind", transaction.findEdgesByKind),
      findEdgesConnectedTo: recorded(
        "findEdgesConnectedTo",
        transaction.findEdgesConnectedTo,
      ),
      insertNode: recorded("insertNode", transaction.insertNode),
      getActiveSchema: recorded("getActiveSchema", transaction.getActiveSchema),
    });
    const routed: object = { ...entry, backend: handle };
    return routed as operationScope.OperationEntry;
  }
  const spies = [
    vi
      .spyOn(operationScope, "enterOperation")
      .mockImplementation(
        (scope: operationScope.EntryScope, parent?: operationScope.Operation) =>
          recordingEntry(enterOperation(scope, parent)),
      ),
    vi
      .spyOn(operationScope, "enterTransactionOperation")
      .mockImplementation((transaction) => {
        transactionEntries.push(entered.length);
        return recordingEntry(
          enterTransactionOperation(transaction),
        ) as operationScope.Operation;
      }),
  ];
  return {
    calls,
    entered,
    transactionEntries,
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

function clear(recording: Recording): void {
  recording.calls.length = 0;
  recording.entered.length = 0;
  recording.transactionEntries.length = 0;
}

/**
 * The graph lock statement a read of the believed set takes on `backend`,
 * rendered, or `undefined` when its write-fence plan takes no keyed lock.
 */
function keyedGraphLockSql(
  backend: WriteFenceTarget,
  graphId: string,
): string | undefined {
  const plan = resolveWriteFencePlan(backend);
  if (plan.kind !== "lock" && plan.kind !== "row") return undefined;
  return renderSql(
    plan.sql.acquireKeyedWithIsolation(
      RECORDED_GRAPH_WRITE_ADVISORY_LOCK_NAMESPACE,
      graphId,
    ),
    backend.dialect,
  ).sql;
}

/** The distinct sessions the recorded operations were entered from. */
function distinctSessions(
  recording: Recording,
): readonly operationScope.TransactionSession[] {
  return [...new Set(recording.entered)];
}

/** The recorded calls that name `kind`, as `member:kind`. */
function callsNaming(
  recording: Recording,
  kinds: readonly string[],
): readonly RoutedCall[] {
  return recording.calls.filter(
    (call) => call.kind !== undefined && kinds.includes(call.kind),
  );
}

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

const routingGraph = defineGraph({
  id: "provenance_operation_routing",
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

const provenanceConfig = {
  source: { kind: "Source" },
  justification: { kind: "Justification" },
  fact: { kinds: ["Fact"] },
  premiseOf: { kind: "premiseOf" },
  derives: { kind: "derives" },
} as const;

/**
 * The edge kinds only provenance's support reads scan by kind. A write the
 * transaction makes (a source update, a fact close) never reads them so.
 */
const SUPPORT_EDGE_KINDS = ["premiseOf", "derives"] as const;

async function seededProvenance(context: IntegrationTestContext) {
  const store = await context.createHistoryStore(routingGraph);
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
  return {
    store,
    source,
    fact,
    provenance: createRetractionCapability(store, provenanceConfig),
  };
}

export function registerProvenanceInterchangeOperationRoutingIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("provenance and interchange operation routing", () => {
    it("a retraction transition reads through an operation of the session its transaction opened", async () => {
      const { store, source, provenance } = await seededProvenance(context);
      const recording = routeOperationsThroughRecordingHandles();
      try {
        clear(recording);
        const report = await provenance.retract(source);
        const [session, ...others] = distinctSessions(recording);
        const transitionReads = callsNaming(recording, [
          "Source",
          ...SUPPORT_EDGE_KINDS,
        ]);
        expect({
          died: report.died.map((fact) => fact.id),
          // The one session of the transition's transaction: the capture
          // overlay opens it and hands it to the Store.
          sessions: distinctSessions(recording).length,
          otherSessions: others.length,
          // The transition's own source read and support reads went through
          // a handle, of the session the transition's transaction opened.
          sourceRead: transitionReads.some(
            (call) => call.member === "getNode" && call.kind === "Source",
          ),
          supportReads: callsNaming(recording, SUPPORT_EDGE_KINDS).length > 0,
          ofThatSession: transitionReads.every(
            (call) => call.session === session,
          ),
        }).toEqual({
          died: ["fact"],
          sessions: 1,
          otherSessions: 0,
          sourceRead: true,
          supportReads: true,
          ofThatSession: true,
        });
        // The transition's reads share ONE operation: the one the transition
        // entered itself, not another operation of the session (the
        // transaction context's, say).
        const supportOperations = new Set(
          callsNaming(recording, SUPPORT_EDGE_KINDS).map(
            (call) => call.operation,
          ),
        );
        const [supportOperation] = supportOperations;
        expect({
          supportOperations: supportOperations.size,
          enteredByTheTransition:
            supportOperation !== undefined &&
            recording.transactionEntries.includes(supportOperation),
          sourceReadThere: recording.calls.some(
            (call) =>
              call.operation === supportOperation &&
              call.member === "getNode" &&
              call.kind === "Source",
          ),
        }).toEqual({
          supportOperations: 1,
          enteredByTheTransition: true,
          sourceReadThere: true,
        });
        expect(store.graphId).toBe(routingGraph.id);
      } finally {
        recording.restore();
      }
    });

    it("holding() reads through one operation of the session of the transaction it opens", async () => {
      const { store, provenance } = await seededProvenance(context);
      // The lock is matched by its statement: a lock sent some other way is
      // simply not recorded, so "every recorded call" cannot see it.
      const lockSql = keyedGraphLockSql(store.backend, store.graphId);
      const recording = routeOperationsThroughRecordingHandles();
      try {
        clear(recording);
        const believed = await provenance.holding();
        const supportOperations = new Set(
          callsNaming(recording, SUPPORT_EDGE_KINDS).map(
            (call) => call.operation,
          ),
        );
        // The transaction's one session: the capture overlay's own operation
        // (the first), the transaction's opener, its context, and holding()'s
        // own operation, entered last.
        const holdingOperation = recording.entered.length - 1;
        const storeCalls = recording.calls.filter(
          (call) => call.operation !== 0,
        );
        expect({
          believed: believed.map((fact) => fact.id),
          sessions: distinctSessions(recording).length,
          supportOperations: [...supportOperations],
          // On a backend whose plan takes a keyed lock, the graph lock went
          // through the operation the support reads went through.
          graphLocks: recording.calls
            .filter(
              (call) =>
                call.statement !== undefined &&
                renderSql(call.statement, store.backend.dialect).sql ===
                  lockSql,
            )
            .map((call) => call.operation),
          throughTheOperation: storeCalls.every(
            (call) => call.operation === holdingOperation,
          ),
        }).toEqual({
          believed: ["fact"],
          sessions: 1,
          supportOperations: [holdingOperation],
          graphLocks: lockSql === undefined ? [] : [holdingOperation],
          throughTheOperation: true,
        });
      } finally {
        recording.restore();
      }
    });

    it("holding(tx) and assertHolds(tx) read through operations of the caller's transaction session", async () => {
      const { store, fact, provenance } = await seededProvenance(context);
      const recording = routeOperationsThroughRecordingHandles();
      try {
        await store.transaction(async (tx) => {
          clear(recording);
          await tx.nodes.Source.create(
            { label: "unrelated", retracted: false },
            { id: "unrelated" },
          );
          // The session this transaction's own writes enter from.
          const [session] = recording.entered;
          if (session === undefined)
            throw new Error("the write entered no operation of a session");

          clear(recording);
          const believed = await provenance.holding(tx);
          const holdingObserved = {
            believed: believed.map((reference) => reference.id),
            supportReads: callsNaming(recording, SUPPORT_EDGE_KINDS).length > 0,
            ofThisSession: recording.entered.every(
              (entered) => entered === session,
            ),
          };

          clear(recording);
          const held = await provenance.assertHolds(tx, [fact]);
          const assertObserved = {
            held: held.map((survived) => survived.fact.id),
            // The closure's reads name the fact and the role kinds; none of
            // them is a fence statement.
            closureReads:
              callsNaming(recording, ["Fact", ...SUPPORT_EDGE_KINDS]).length >
              0,
            ofThisSession: recording.entered.every(
              (entered) => entered === session,
            ),
          };

          expect({ holdingObserved, assertObserved }).toEqual({
            holdingObserved: {
              believed: ["fact"],
              supportReads: true,
              ofThisSession: true,
            },
            assertObserved: {
              held: ["fact"],
              closureReads: true,
              ofThisSession: true,
            },
          });
        });
      } finally {
        recording.restore();
      }
    });

    it("an export streams through one operation of the session of the snapshot transaction it opens", async () => {
      const { store } = await seededProvenance(context);
      const interactive =
        store.backend.capabilities.execution.interactiveTransactions;
      const recording = routeOperationsThroughRecordingHandles();
      try {
        clear(recording);
        const chunks: unknown[] = [];
        for await (const chunk of exportGraphStream(store)) chunks.push(chunk);
        // The snapshot transaction's one session: the capture overlay's own
        // operation is the first, the export's the second.
        const exportCalls = recording.calls.filter(
          (call) => call.operation !== 0,
        );
        expect({
          exported: chunks.length > 0,
          operations: recording.entered.length,
          sessions: distinctSessions(recording).length,
          routed: exportCalls.length > 0,
          throughTheOperation: exportCalls.every(
            (call) => call.operation === 1,
          ),
        }).toEqual({
          exported: true,
          // A backend without interactive transactions exports from the
          // root, which enters nothing.
          operations: interactive ? 2 : 0,
          sessions: interactive ? 1 : 0,
          routed: interactive,
          throughTheOperation: true,
        });
      } finally {
        recording.restore();
      }
    });

    it("the provenance sidecar claim writes its marker through the one operation of the session its transaction opens", async () => {
      const { store } = await seededProvenance(context);
      const recording = routeOperationsThroughRecordingHandles();
      try {
        clear(recording);
        await openProvenanceStore(store);
        const markers = recording.calls.filter(
          (call) => call.member === "insertNode",
        );
        const [marker] = markers;
        expect({
          markers: markers.length,
          // The claim's inspection read the sidecar's active schema through
          // the same operation before it wrote.
          inspected:
            marker !== undefined &&
            recording.calls.some(
              (call) =>
                call.operation === marker.operation &&
                call.member === "getActiveSchema",
            ),
          enteredFromItsSession:
            marker === undefined ? 0 : (
              recording.entered.filter(
                (session) => session === recording.entered[marker.operation],
              ).length
            ),
        }).toEqual({ markers: 1, inspected: true, enteredFromItsSession: 1 });
      } finally {
        recording.restore();
      }
    });
  });
}
