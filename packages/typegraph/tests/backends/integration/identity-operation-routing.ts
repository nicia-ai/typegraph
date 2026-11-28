/**
 * A transaction identity call's statements go through the operation it
 * entered.
 *
 * An operation's handle is, today, the very transaction object its session
 * holds, so an identity call that entered the right operation and then sent
 * its statements down some other path to that same transaction (the facade's
 * own context, a node loader built over the transaction) is indistinguishable
 * from one that used the handle. These cases make the handle
 * distinguishable: `enterOperation` is wrapped so each operation it mints
 * carries its own recording derivation of the transaction, and each
 * `tx.identity` call, read or write, is checked on every backend to have sent
 * its statements only through handles of operations of the transaction's own
 * session (by identity), exactly one operation per call, with the answer the
 * database gave.
 */
import { describe, expect, it, vi } from "vitest";

import { deriveBackend } from "../../../src/backend/derive-backend";
import type { GraphBackend } from "../../../src/backend/types";
import { renderSql, type SqlFragment } from "../../../src/query/sql-fragment";
import * as operationScope from "../../../src/store/operation-scope";
import { integrationTestGraph } from "./fixtures";
import type { IntegrationTestContext } from "./test-context";

/** One statement or read member call that went through a recording handle. */
type RoutedCall = Readonly<{
  operation: number;
  session: operationScope.TransactionSession;
  member: string;
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
 * Wraps `enterOperation` so every operation of a session gets a handle of its
 * own: a derivation of the session's transaction that records each statement
 * and read member call it carries, then calls through. `operations` receives
 * the session of each operation minted. Restore with the returned spy's
 * `mockRestore()`.
 */
function routeOperationsThroughRecordingHandles(
  calls: RoutedCall[],
  operations: operationScope.TransactionSession[],
) {
  const enterOperation = operationScope.enterOperation;
  function recordingEnter(
    scope: operationScope.EntryScope,
    parent?: operationScope.Operation,
  ): operationScope.OperationEntry {
    const entry = enterOperation(scope, parent);
    const entered = operationScope.operationEntrySession(entry);
    if (entered === undefined) return entry;
    const session: operationScope.TransactionSession = entered;
    const operation = operations.push(session);
    /**
     * A recording derivation of `transaction`: each statement and read
     * member call it carries is recorded as a call through this operation.
     */
    function recordingHandle(transaction: GraphBackend): GraphBackend {
      function recorded<Arguments extends unknown[], Result>(
        member: string,
        call: (...args: Arguments) => Result,
      ): (...args: Arguments) => Result {
        return (...args) => {
          calls.push({
            operation,
            session,
            member,
            sql: statementText(member, args, transaction.dialect),
          });
          return call.apply(transaction, args);
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
      const { getNodes } = transaction;
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
        getNode: recorded("getNode", transaction.getNode),
        ...(getNodes === undefined ?
          {}
        : { getNodes: recorded("getNodes", getNodes) }),
        findNodesByKind: recorded(
          "findNodesByKind",
          transaction.findNodesByKind,
        ),
        getActiveSchema: recorded(
          "getActiveSchema",
          transaction.getActiveSchema,
        ),
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
  return vi
    .spyOn(operationScope, "enterOperation")
    .mockImplementation(recordingEnter);
}

export function registerIdentityOperationRoutingIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("transaction identity routing", () => {
    it("every tx.identity call sends its statements through the handle of the one operation it entered", async () => {
      const store = await context.createStore(integrationTestGraph);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const carol = await store.nodes.Person.create({ name: "Carol" });
      const a = { kind: "Person" as const, id: alice.id };
      const b = { kind: "Person" as const, id: bob.id };
      const c = { kind: "Person" as const, id: carol.id };

      const calls: RoutedCall[] = [];
      const operations: operationScope.TransactionSession[] = [];
      const entered = routeOperationsThroughRecordingHandles(calls, operations);
      try {
        await store.transaction(async (tx) => {
          operations.length = 0;
          await tx.nodes.Person.create({ name: "Dave" });
          // The session this transaction's own writes enter from.
          const session = operations[0];
          if (session === undefined)
            throw new Error("the write entered no operation of a session");

          const sorted = [alice.id, bob.id].toSorted();
          const identityCalls: readonly (readonly [
            string,
            () => Promise<unknown>,
            unknown,
          ])[] = [
            [
              "assertSame",
              () =>
                tx.identity.assertSame(a, b).then((result) => result.action),
              "created",
            ],
            [
              "assertDifferent",
              () =>
                tx.identity
                  .assertDifferent(a, c)
                  .then((result) => result.action),
              "created",
            ],
            [
              "membersOf",
              () =>
                tx.identity
                  .membersOf(a)
                  .then((members) => members.map((member) => member.id)),
              sorted,
            ],
            [
              "representativeOf",
              () =>
                tx.identity.representativeOf(b).then((member) => member?.id),
              sorted[0],
            ],
            [
              "nodesOf",
              () =>
                tx.identity
                  .nodesOf(a)
                  .then((nodes) => nodes.map((node) => node.id).toSorted()),
              sorted,
            ],
            ["areSame", () => tx.identity.areSame(a, b), true],
            ["areDifferent", () => tx.identity.areDifferent(a, c), true],
            [
              "assertionsOf",
              () =>
                tx.identity
                  .assertionsOf(a)
                  .then((assertions) =>
                    assertions
                      .map((assertion) => assertion.relation)
                      .toSorted(),
                  ),
              ["different", "same"],
            ],
            [
              "explainSame",
              () => tx.identity.explainSame(a, b).then((path) => path?.length),
              1,
            ],
            ...(store.backend.capabilities.windowFunctions ?
              ([
                [
                  "classes",
                  () =>
                    tx.identity
                      .classes({ limit: 10 })
                      .then(
                        (page) =>
                          page.classes.find(
                            (identityClass) => identityClass.members.length > 1,
                          )?.members.length,
                      ),
                  2,
                ],
              ] as const)
            : []),
            [
              "retractDifferentAssertion",
              () =>
                tx.identity
                  .retractDifferentAssertion(a, c)
                  .then((retracted) => retracted?.relation),
              "different",
            ],
            [
              "retractSameAssertion",
              () =>
                tx.identity
                  .retractSameAssertion(a, b)
                  .then((retracted) => retracted?.relation),
              "same",
            ],
          ];

          const observed: unknown[] = [];
          const routedCalls = new Map<string, number>();
          for (const [label, call] of identityCalls) {
            calls.length = 0;
            operations.length = 0;
            const result = await call();
            routedCalls.set(label, calls.length);
            observed.push({
              at: label,
              result,
              // One operation per call, of this transaction's own session:
              // the same object, not a session over the same transaction.
              operations: operations.length,
              ofThisSession: operations.every((entry) => entry === session),
              // Some statement went through the recording handle, and every
              // one through the handle of the operation this call entered.
              routed: calls.length > 0,
              throughItsOperation: calls.every(
                (routed) =>
                  routed.operation === 1 && routed.session === session,
              ),
            });
          }
          expect(observed).toEqual(
            identityCalls.map(([label, , expected]) => ({
              at: label,
              result: expected,
              operations: 1,
              ofThisSession: true,
              routed: true,
              throughItsOperation: true,
            })),
          );
          // nodesOf hydrates the members it resolved through the same
          // handle: it routes strictly more than the membership read alone.
          expect(routedCalls.get("nodesOf") ?? 0).toBeGreaterThan(
            routedCalls.get("membersOf") ?? 0,
          );
        });
      } finally {
        entered.mockRestore();
      }
    });

    it("a history transaction's identity write goes through the operation its call entered", async () => {
      const store = await context.createHistoryStore(integrationTestGraph);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const a = { kind: "Person" as const, id: alice.id };
      const b = { kind: "Person" as const, id: bob.id };

      const calls: RoutedCall[] = [];
      const operations: operationScope.TransactionSession[] = [];
      const entered = routeOperationsThroughRecordingHandles(calls, operations);
      try {
        const observed = await store.transaction(async (tx) => {
          operations.length = 0;
          await tx.nodes.Person.create({ name: "Dave" });
          const session = operations[0];
          if (session === undefined)
            throw new Error("the write entered no operation of a session");
          const routes: Record<string, readonly string[]> = {};
          for (const [label, call] of [
            ["assertSame", () => tx.identity.assertSame(a, b)],
            [
              "retractSameAssertion",
              () => tx.identity.retractSameAssertion(a, b),
            ],
          ] as const) {
            calls.length = 0;
            operations.length = 0;
            await call();
            // Where each statement that writes an identity relation went.
            routes[label] = [
              ...new Set(
                calls
                  .filter(
                    (routed) =>
                      routed.sql !== undefined &&
                      /^\s*(insert|update|delete)\b/i.test(routed.sql) &&
                      /identity/i.test(routed.sql),
                  )
                  .map((routed) => {
                    if (routed.session !== session) {
                      return "an operation of another session";
                    }
                    return routed.operation === 1 ?
                        "its operation"
                      : "another operation of its session";
                  }),
              ),
            ];
          }
          return routes;
        });
        // A history Store's identity writes go beneath the capture surface,
        // through the operation the identity call entered.
        expect(observed).toEqual({
          assertSame: ["its operation"],
          retractSameAssertion: ["its operation"],
        });
      } finally {
        entered.mockRestore();
      }
    });
  });
}
