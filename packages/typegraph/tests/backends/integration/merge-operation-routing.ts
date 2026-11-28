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
function routeOperationsThroughRecordingHandles(
  calls: RoutedCall[],
  entered: operationScope.TransactionSession[] = [],
) {
  const enterOperation = operationScope.enterOperation;
  const enterTransactionOperation = operationScope.enterTransactionOperation;
  // How many recorded calls are on the stack: a handle forwards to the handle
  // beneath it synchronously, so a call made while one is already running is
  // that call passing through a lower operation's handle, not a new one.
  let forwarding = 0;
  function recordingEntry(
    entry: operationScope.OperationEntry,
    runtime: boolean,
  ): operationScope.OperationEntry {
    const enteredFrom = operationScope.operationEntrySession(entry);
    if (enteredFrom === undefined) return entry;
    const session: operationScope.TransactionSession = enteredFrom;
    entered.push(session);
    /** A recording derivation of `transaction`, through this operation. */
    function recordingHandle(transaction: GraphBackend): GraphBackend {
      function recorded<Arguments extends unknown[], Result>(
        member: string,
        call: (...args: Arguments) => Result,
      ): (...args: Arguments) => Result {
        return (...args) => {
          if (forwarding === 0) {
            calls.push({
              session,
              member,
              runtime,
              sql: statementText(member, args, transaction.dialect),
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
      // A history capture surface refuses raw statement members on read, so
      // a member it refuses is left as it is rather than wrapped.
      function member<Key extends "executeRaw" | "executeStatement">(
        key: Key,
      ): GraphBackend[Key] | undefined {
        try {
          return transaction[key];
        } catch {
          return undefined;
        }
      }
      const executeRaw = member("executeRaw");
      const executeStatement = member("executeStatement");
      return deriveBackend(transaction, {
        execute: recorded("execute", transaction.execute),
        ...(executeRaw === undefined ?
          {}
        : { executeRaw: recorded("executeRaw", executeRaw) }),
        ...(executeStatement === undefined ?
          {}
        : {
            executeStatement: recorded("executeStatement", executeStatement),
          }),
      });
    }
    const transaction = operationScope.operationEntryBackend(
      entry,
    ) as GraphBackend;
    const handle = recordingHandle(transaction);
    // The session's undecorated holding, as the operation holds it, records
    // through this operation too: where it is a different object from the
    // handle (a history session's capture surface), its own derivation.
    const control = operationScope.operationEntryControl(entry) as GraphBackend;
    const routed: object = {
      ...entry,
      backend: handle,
      control: control === transaction ? handle : recordingHandle(control),
    };
    return routed as operationScope.OperationEntry;
  }
  const spies = [
    vi
      .spyOn(operationScope, "enterOperation")
      .mockImplementation(
        (scope: operationScope.EntryScope, parent?: operationScope.Operation) =>
          recordingEntry(enterOperation(scope, parent), false),
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

/** Where one recorded statement went, relative to the call's own session. */
function routeOf(
  call: RoutedCall,
  session: operationScope.TransactionSession,
): string {
  if (call.session !== session) return "an operation of another session";
  return call.runtime ? "its operation" : "another operation of its session";
}

/** What the recorded calls say about one call's routing. */
function routing(
  calls: readonly RoutedCall[],
  session: operationScope.TransactionSession,
) {
  return {
    // The call's own statements went through the operation it entered...
    routedThroughItsOperation: calls.some(
      (call) => routeOf(call, session) === "its operation",
    ),
    // ...of this transaction's own session: the same object, not a session
    // over the same transaction. A history store's capture overlay runs its
    // own work (isolation check, capture flush, pre-commit hook) in the same
    // session: it opens it and hands it to the Store.
    ofThisSession: calls.every(
      (call) => routeOf(call, session) !== "an operation of another session",
    ),
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
      const entered: operationScope.TransactionSession[] = [];
      const restore = routeOperationsThroughRecordingHandles(calls, entered);
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
      const entered: operationScope.TransactionSession[] = [];
      const restore = routeOperationsThroughRecordingHandles(calls, entered);
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
      // The evidence row is written at pre-commit, by the operation the
      // durable call entered, beneath the capture surface of its session.
      const ledger = storeOperationsTableName(store.revisionSchema);
      expect({
        evidenceInserts: calls
          .filter(
            (call) =>
              call.sql?.trimStart().startsWith("INSERT INTO ") === true &&
              call.sql.includes(ledger),
          )
          .map((call) =>
            hostSession === undefined ? "no session" : (
              routeOf(call, hostSession)
            ),
          ),
      }).toEqual({ evidenceInserts: ["its operation"] });
    });

    it("a history-enabled adopted merge apply takes and releases its savepoint through the operation it entered", async () => {
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
            through: routeOf(call, session),
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
      const entered: operationScope.TransactionSession[] = [];
      const restore = routeOperationsThroughRecordingHandles(calls, entered);
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
        // SAVEPOINT and RELEASE run beneath the capture surface, through the
        // operation the apply entered.
        expect(applied.savepoint).toEqual([
          { statement: "SAVEPOINT", through: "its operation" },
          { statement: "RELEASE", through: "its operation" },
        ]);
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
