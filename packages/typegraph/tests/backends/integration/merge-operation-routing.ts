/**
 * Merge apply's and a durable Store operation's own statements go through the
 * operation they entered.
 *
 * An operation's handle is, today, the very transaction object its session
 * holds, so a call that entered the right operation and then sent its
 * statements down some other path to that same transaction is
 * indistinguishable from one that used the handle. These cases make the
 * handle distinguishable, as `read-operation-routing.ts` does for reads:
 * `enterOperation` is wrapped so every operation it mints carries its own
 * recording derivation of the transaction, and the operation a call enters
 * through its context's runtime (`enterTransactionOperation`) is labelled.
 * Each case checks, on every backend, that the call's direct statements went
 * through that one handle, of an operation of the transaction's own session
 * (by identity), and that the call still did what it does.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import type { GraphBackend } from "../../../src/backend/types";
import {
  applyMergePlanInTransaction,
  branch,
  captureStoreOperationTarget,
  operateStore,
  planMerge,
} from "../../../src/graph-merge";
import { unwrap } from "../../../src/graph-merge/result";
import { asBranchId } from "../../../src/graph-merge/types";
import { storeOperationsTableName } from "../../../src/query/compiler/schema";
import { renderSql, type SqlFragment } from "../../../src/query/sql-fragment";
import * as operationScope from "../../../src/store/operation-scope";
import { inheritRecordedTransactionBindings } from "../../../src/store/recorded-capture";
import { expectObservation } from "../../helpers/known-defect";
import type { IntegrationTestContext } from "./test-context";

const Item = defineNode("Item", { schema: z.object({ name: z.string() }) });
const links = defineEdge("links", { schema: z.object({}) });
const graph = defineGraph({
  id: "merge_operation_routing",
  nodes: { Item: { type: Item } },
  edges: { links: { type: links, from: [Item], to: [Item] } },
});

/** One statement that went through a recording handle. */
type RoutedCall = Readonly<{
  session: operationScope.TransactionSession;
  member: string;
  /** The operation was entered through a context's runtime. */
  runtime: boolean;
  /** The statement text an `execute` or `executeStatement` call sent. */
  sql: string | undefined;
}>;

// eslint-disable-next-line @typescript-eslint/no-empty-function -- A recording handle lives exactly as long as its transaction.
function recordingHandleOpen(): void {}

/** The text of the statement `member` sends with `args`, if it sends one. */
function statementText(
  member: string,
  args: readonly unknown[],
  dialect: GraphBackend["dialect"],
): string | undefined {
  if (member !== "execute" && member !== "executeStatement") return undefined;
  return renderSql(args[0] as SqlFragment, dialect).sql;
}

/**
 * Wraps the entry mints (`enterOperation`, and `enterTransactionOperation`,
 * which merge apply and a durable operation enter through) so every
 * operation of a session gets a handle of its own, a recording derivation of
 * the session's transaction, and labels the operations
 * `enterTransactionOperation` enters. Restore with the returned function.
 */
function routeOperationsThroughRecordingHandles(calls: RoutedCall[]) {
  const enterOperation = operationScope.enterOperation;
  const enterTransactionOperation = operationScope.enterTransactionOperation;
  function recordingEntry(
    entry: operationScope.OperationEntry,
    runtime: boolean,
  ): operationScope.OperationEntry {
    const entered = operationScope.operationEntrySession(entry);
    if (entered === undefined) return entry;
    const session: operationScope.TransactionSession = entered;
    const transaction = operationScope.operationEntryBackend(
      entry,
    ) as GraphBackend;
    function recorded<Arguments extends unknown[], Result>(
      member: string,
      call: (...args: Arguments) => Result,
    ): (...args: Arguments) => Result {
      return (...args) => {
        calls.push({
          session,
          member,
          runtime,
          sql: statementText(member, args, transaction.dialect),
        });
        return call.apply(transaction, args);
      };
    }
    const { executeRaw, executeStatement } = transaction;
    const handle = deriveBackend(transaction, {
      execute: recorded("execute", transaction.execute),
      ...(executeRaw === undefined ?
        {}
      : { executeRaw: recorded("executeRaw", executeRaw) }),
      ...(executeStatement === undefined ?
        {}
      : { executeStatement: recorded("executeStatement", executeStatement) }),
    });
    // As a lifetime-guarded decoration does: the capture binding of the
    // transaction (its savepoint seam, its pending writes) follows the handle,
    // which adds no lifetime of its own beyond the transaction's.
    inheritRecordedTransactionBindings(
      transaction,
      handle,
      recordingHandleOpen,
    );
    const routed: object = { ...entry, backend: handle };
    return routed as operationScope.OperationEntry;
  }
  const spies = [
    vi
      .spyOn(operationScope, "enterOperation")
      .mockImplementation((scope: operationScope.EntryScope) =>
        recordingEntry(enterOperation(scope), false),
      ),
    vi
      .spyOn(operationScope, "enterTransactionOperation")
      .mockImplementation(
        (transaction) =>
          recordingEntry(
            enterTransactionOperation(transaction),
            true,
          ) as operationScope.Operation,
      ),
  ];
  return () => {
    for (const spy of spies) spy.mockRestore();
  };
}

/** What the recorded calls say about one call's routing. */
function routing(
  calls: readonly RoutedCall[],
  session: operationScope.TransactionSession,
) {
  const runtime = calls.filter((call) => call.runtime);
  return {
    // The call's own statements went through the operation it entered...
    routedThroughItsOperation: runtime.length > 0,
    // ...of this transaction's own session: the same object, not a session
    // over the same transaction.
    ofThisSession: calls.every((call) => call.session === session),
  };
}

export function registerMergeOperationRoutingIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("merge and durable operation routing", () => {
    it("an adopted merge apply sends its own statements through the operation it entered in the caller's session", async () => {
      const target = await context.createStore(graph, {
        revisionTracking: true,
      });
      await target.nodes.Item.create({ name: "kept" }, { id: "kept" });
      const source = unwrap(
        await branch(target, () => context.createIsolatedBackend(), {
          id: asBranchId("routing"),
        }),
      );
      await source.store.nodes.Item.create({ name: "added" }, { id: "added" });
      await source.store.edges.links.create(
        { kind: "Item", id: "kept" },
        { kind: "Item", id: "added" },
        {},
      );
      const artifact = unwrap(await planMerge(target, [source]));

      const calls: RoutedCall[] = [];
      const restore = routeOperationsThroughRecordingHandles(calls);
      try {
        const observed = await target.transaction(async (tx) => {
          // A read learns the session: the apply refuses a transaction that
          // already wrote.
          calls.length = 0;
          await tx
            .query()
            .from("Item", "item")
            .select((ctx) => ctx.item.name)
            .execute();
          const session = calls[0]?.session;
          if (session === undefined)
            throw new Error("the read entered no operation of a session");

          calls.length = 0;
          const report = await applyMergePlanInTransaction(
            target,
            tx,
            artifact,
          );
          return {
            nodes: report.merged.nodes,
            edges: report.merged.edges,
            ...routing(calls, session),
          };
        });
        expect(observed).toEqual({
          nodes: 1,
          edges: 1,
          routedThroughItsOperation: true,
          ofThisSession: true,
        });
      } finally {
        restore();
      }
      const names = await target
        .query()
        .from("Item", "item")
        .orderBy("item", "name")
        .select((ctx) => ctx.item.name)
        .execute();
      expect(names).toEqual(["added", "kept"]);
    });

    it("a durable Store operation sends its own statements through the operation it entered in the session it opened", async () => {
      const store = await context.createHistoryStore(graph);
      if (store.backend.capabilities.durableStoreOperations !== true) return;
      const request = {
        target: await captureStoreOperationTarget(store),
        idempotencyKey: "routing",
        metadata: { caller: "routing" },
        mutation: { id: "created" },
      };

      const calls: RoutedCall[] = [];
      const restore = routeOperationsThroughRecordingHandles(calls);
      let observed: unknown;
      let hostSession: operationScope.TransactionSession | undefined;
      try {
        const outcome = unwrap(
          await operateStore(store, request, async (tx) => {
            // A read learns the session of the transaction the call opened.
            const before = calls.length;
            await tx
              .query()
              .from("Item", "item")
              .select((ctx) => ctx.item.name)
              .execute();
            const session = calls[before]?.session;
            if (session === undefined)
              throw new Error("the read entered no operation of a session");
            hostSession = session;
            await tx.nodes.Item.create({ name: "created" }, { id: "created" });
            observed = routing(calls, session);
            return { id: "created" };
          }),
        );
        expect(outcome.outcome).toBe("applied");
      } finally {
        restore();
      }
      expect(observed).toEqual({
        routedThroughItsOperation: true,
        ofThisSession: true,
      });
      // The evidence row is written at pre-commit through the target the
      // Store hands its pre-commit hook: the capture channel, which belongs
      // to the capture-and-flush family. Until that family converts (#984)
      // the INSERT goes through no operation handle at all.
      const ledger = storeOperationsTableName(store.revisionSchema);
      expectObservation({
        lane: { dialect: store.backend.dialect },
        observed: {
          evidenceInserts: calls
            .filter(
              (call) =>
                call.sql?.startsWith("INSERT INTO ") === true &&
                call.sql.includes(ledger),
            )
            .map((call) => ({
              throughItsOperation: call.runtime,
              ofThisSession: call.session === hostSession,
            })),
        },
        correct: {
          evidenceInserts: [{ throughItsOperation: true, ofThisSession: true }],
        },
        defects: [{ label: "#984", on: {}, today: { evidenceInserts: [] } }],
      });
    });

    it("a history-enabled adopted merge apply takes and releases its savepoint through the capture channel", async () => {
      const target = await context.createHistoryStore(graph);
      await target.nodes.Item.create({ name: "kept" }, { id: "kept" });
      const source = unwrap(
        await branch(target, () => context.createIsolatedBackend(), {
          id: asBranchId("routing-history"),
        }),
      );
      await source.store.nodes.Item.create({ name: "added" }, { id: "added" });
      const artifact = unwrap(await planMerge(target, [source]));

      /** The savepoint statements a call sent through an operation handle. */
      const savepointStatements = (
        calls: readonly RoutedCall[],
        session: operationScope.TransactionSession,
      ) =>
        calls
          .filter(
            (call) => call.sql?.includes("typegraph_merge_apply") === true,
          )
          .map((call) => ({
            statement: call.sql?.split(" ")[0],
            throughItsOperation: call.runtime,
            ofThisSession: call.session === session,
          }));

      /** The session a read inside `tx` enters its operation from. */
      const readSession = async (
        tx: Parameters<Parameters<typeof target.transaction>[0]>[0],
        calls: RoutedCall[],
      ): Promise<operationScope.TransactionSession> => {
        calls.length = 0;
        await tx
          .query()
          .from("Item", "item")
          .select((ctx) => ctx.item.name)
          .execute();
        const session = calls[0]?.session;
        if (session === undefined)
          throw new Error("the read entered no operation of a session");
        calls.length = 0;
        return session;
      };

      const calls: RoutedCall[] = [];
      const restore = routeOperationsThroughRecordingHandles(calls);
      try {
        // Applied: the savepoint is taken and released.
        const applied = await target.transaction(async (tx) => {
          const session = await readSession(tx, calls);
          const report = await applyMergePlanInTransaction(
            target,
            tx,
            artifact,
          );
          return {
            nodes: report.merged.nodes,
            savepoint: savepointStatements(calls, session),
          };
        });
        expect(applied.nodes).toBe(1);
        // SAVEPOINT and RELEASE run on the raw target beneath the capture
        // binding, the capture channel of the capture-and-flush family:
        // until it converts (#984) they go through no operation handle.
        expectObservation({
          lane: { dialect: target.backend.dialect },
          observed: applied.savepoint,
          correct: [
            {
              statement: "SAVEPOINT",
              throughItsOperation: true,
              ofThisSession: true,
            },
            {
              statement: "RELEASE",
              throughItsOperation: true,
              ofThisSession: true,
            },
          ],
          defects: [{ label: "#984", on: {}, today: [] }],
        });
      } finally {
        restore();
      }
      const names = await target
        .query()
        .from("Item", "item")
        .orderBy("item", "name")
        .select((ctx) => ctx.item.name)
        .execute();
      expect(names).toEqual(["added", "kept"]);
    });
  });
}
