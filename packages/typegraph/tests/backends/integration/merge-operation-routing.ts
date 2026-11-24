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
import * as operationScope from "../../../src/store/operation-scope";
import * as runtimePort from "../../../src/store/runtime-port";
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
}>;

/**
 * Wraps `enterOperation` so every operation of a session gets a handle of its
 * own, a recording derivation of the session's transaction, and labels the
 * operations `enterTransactionOperation` enters. Restore with the returned
 * function.
 */
function routeOperationsThroughRecordingHandles(calls: RoutedCall[]) {
  const enterOperation = operationScope.enterOperation;
  const enterTransactionOperation = runtimePort.enterTransactionOperation;
  let enteringThroughRuntime = false;
  function recordingEnter(
    scope: operationScope.EntryScope,
  ): operationScope.OperationEntry {
    const entry = enterOperation(scope);
    const entered = operationScope.operationEntrySession(entry);
    if (entered === undefined) return entry;
    const session: operationScope.TransactionSession = entered;
    const runtime = enteringThroughRuntime;
    const transaction = operationScope.operationEntryBackend(
      entry,
    ) as GraphBackend;
    function recorded<Arguments extends unknown[], Result>(
      member: string,
      call: (...args: Arguments) => Result,
    ): (...args: Arguments) => Result {
      return (...args) => {
        calls.push({ session, member, runtime });
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
    const routed: object = { ...entry, backend: handle };
    return routed as operationScope.OperationEntry;
  }
  const entered = vi
    .spyOn(operationScope, "enterOperation")
    .mockImplementation(recordingEnter);
  const throughRuntime = vi
    .spyOn(runtimePort, "enterTransactionOperation")
    .mockImplementation((transaction) => {
      enteringThroughRuntime = true;
      try {
        return enterTransactionOperation(transaction);
      } finally {
        enteringThroughRuntime = false;
      }
    });
  return () => {
    entered.mockRestore();
    throughRuntime.mockRestore();
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
    });
  });
}
