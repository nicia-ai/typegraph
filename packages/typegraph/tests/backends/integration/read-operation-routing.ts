/**
 * A transaction read's statements go through the operation it entered.
 *
 * An operation's handle is, today, the very transaction object its session
 * holds, so a read that entered the right operation and then sent its
 * statements down some other path to that same transaction is
 * indistinguishable from one that used the handle. These cases make the
 * handle distinguishable: `enterOperation` is wrapped so each operation it
 * mints carries its own recording derivation of the transaction, and each
 * read is checked, on every backend, to have sent its statements through the
 * handles minted for that call, each of an operation of the transaction's own
 * session (by identity), with the rows the database returned.
 */
import { describe, expect, it, vi } from "vitest";

import { count, param as parameter } from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import type { GraphBackend } from "../../../src/backend/types";
import * as operationScope from "../../../src/store/operation-scope";
import { integrationTestGraph } from "./fixtures";
import type { IntegrationTestContext } from "./test-context";

/** One statement or read member call that went through a recording handle. */
type RoutedCall = Readonly<{
  session: operationScope.TransactionSession;
  member: string;
}>;

/**
 * Wraps `enterOperation` so every operation of a session gets a handle of its
 * own: a derivation of the session's transaction that records each statement
 * and read member call it carries, then calls through. Restore with the
 * returned spy's `mockRestore()`.
 */
function routeOperationsThroughRecordingHandles(
  calls: RoutedCall[],
  sessions: operationScope.TransactionSession[],
) {
  const enterOperation = operationScope.enterOperation;
  function recordingEnter(
    scope: operationScope.EntryScope,
  ): operationScope.OperationEntry {
    const entry = enterOperation(scope);
    const entered = operationScope.operationEntrySession(entry);
    if (entered === undefined) return entry;
    const session: operationScope.TransactionSession = entered;
    sessions.push(session);
    const transaction = operationScope.operationEntryBackend(
      entry,
    ) as GraphBackend;
    /** `call`, recorded as a call of `member` through this operation. */
    function recorded<Arguments extends unknown[], Result>(
      member: string,
      call: (...args: Arguments) => Result,
    ): (...args: Arguments) => Result {
      return (...args) => {
        calls.push({ session, member });
        return call.apply(transaction, args);
      };
    }
    const executeRaw = transaction.executeRaw;
    const handle = deriveBackend(transaction, {
      execute: recorded("execute", transaction.execute),
      ...(executeRaw === undefined ?
        {}
      : { executeRaw: recorded("executeRaw", executeRaw) }),
      getNode: recorded("getNode", transaction.getNode),
      findNodesByKind: recorded("findNodesByKind", transaction.findNodesByKind),
      getActiveSchema: recorded("getActiveSchema", transaction.getActiveSchema),
    });
    const routed: object = { ...entry, backend: handle };
    return routed as operationScope.OperationEntry;
  }
  return vi
    .spyOn(operationScope, "enterOperation")
    .mockImplementation(recordingEnter);
}

export function registerReadOperationRoutingIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("transaction read routing", () => {
    it("every read inside a transaction sends its statements through the handle of the operation it entered", async () => {
      const hooked: string[] = [];
      const store = await context.createStore(integrationTestGraph, {
        hooks: {
          onQueryStart: (event) => {
            hooked.push(event.sql);
          },
        },
      });
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      await store.nodes.Person.create({ name: "Carol" });
      await store.edges.knows.create(alice, bob, {});

      const calls: RoutedCall[] = [];
      const sessions: operationScope.TransactionSession[] = [];
      const entered = routeOperationsThroughRecordingHandles(calls, sessions);
      try {
        await store.transaction(async (tx) => {
          sessions.length = 0;
          await tx.nodes.Person.create({ name: "Dave" });
          await tx.nodes.Person.create({ name: "Erin" });
          // The session this transaction's own writes enter from.
          const session = sessions[0];
          if (session === undefined)
            throw new Error("the write entered no operation of a session");

          const people = tx
            .query()
            .from("Person", "p")
            .orderBy("p", "name")
            .select((ctx) => ctx.p.name);
          const byName = tx
            .query()
            .from("Person", "p")
            .whereNode("p", (p) => p.name.eq(parameter("name")))
            .select((ctx) => ctx.p.name)
            .prepare();
          const names = tx
            .query()
            .from("Person", "p")
            .orderBy("p", "name")
            .project((ctx) => ({ name: ctx.p.name }));
          const headcount = tx
            .query()
            .from("Person", "p")
            .aggregate({ people: count("p") });
          const peopleNamed = tx
            .query()
            .from("Person", "p")
            .whereNode("p", (p) => p.name.eq(parameter("name")))
            .aggregate({ people: count("p") })
            .prepare();
          const everyone = ["Alice", "Bob", "Carol", "Dave", "Erin"];

          const reads: readonly (readonly [
            string,
            () => Promise<unknown>,
            unknown,
            "hooked" | "unhooked",
          ])[] = [
            ["query execute", () => people.execute(), everyone, "hooked"],
            ["query count", () => people.count(), 5, "hooked"],
            [
              "query paginate",
              () => people.paginate({ first: 2 }).then((page) => page.data),
              ["Alice", "Bob"],
              "hooked",
            ],
            [
              "query stream, three pages",
              async () => {
                const streamed: string[] = [];
                for await (const name of people.stream({ batchSize: 2 }))
                  streamed.push(name);
                return streamed;
              },
              everyone,
              "hooked",
            ],
            [
              "prepared query",
              () => byName.execute({ name: "Bob" }),
              ["Bob"],
              "hooked",
            ],
            [
              "projection execute",
              () => names.execute().then((rows) => rows.map((row) => row.name)),
              everyone,
              "hooked",
            ],
            [
              "relation execute",
              () =>
                names
                  .asRelation()
                  .execute()
                  .then((rows) => rows.map((row) => row.name)),
              everyone,
              "hooked",
            ],
            [
              "aggregate execute",
              () => headcount.execute(),
              [{ people: 5 }],
              "hooked",
            ],
            ["aggregate count", () => headcount.count(), 1, "hooked"],
            ["aggregate exists", () => headcount.exists(), true, "hooked"],
            [
              "prepared aggregate",
              () => peopleNamed.execute({ name: "Bob" }),
              [{ people: 1 }],
              "hooked",
            ],
            [
              "prepared aggregate, bound",
              () => peopleNamed.bind({ name: "Dave" }).execute(),
              [{ people: 1 }],
              "hooked",
            ],
            [
              "neighbors",
              () =>
                tx
                  .neighbors(alice, { edges: ["knows"] })
                  .then((neighbors) =>
                    neighbors.map((neighbor) => neighbor.node.id),
                  ),
              [bob.id],
              "hooked",
            ],
            [
              "countNeighbors",
              () => tx.countNeighbors(alice, { edges: ["knows"] }),
              1,
              "hooked",
            ],
            [
              "subgraph",
              () =>
                tx
                  .subgraph(alice, { edges: ["knows"], maxDepth: 1 })
                  .then((unit) => unit.nodes.length),
              2,
              "hooked",
            ],
            ...(store.backend.capabilities.windowFunctions ?
              ([
                [
                  "batchOnce",
                  async () => {
                    const [counted, queried] = await tx.batchOnce((read) => [
                      read.countNeighbors(alice, { edges: ["knows"] }),
                      people,
                    ]);
                    return { counted, queried };
                  },
                  { counted: 1, queried: everyone },
                  "hooked",
                ],
              ] as const)
            : []),
            [
              "describe",
              () =>
                tx
                  .describe()
                  .then(
                    (description) =>
                      description.statistics.nodes.find(
                        (population) => population.kind === "Person",
                      )?.count,
                  ),
              5,
              "unhooked",
            ],
            [
              "validateStore",
              () =>
                tx
                  .validateStore({ entity: "node", kind: "Person" })
                  .then((page) => page.scannedCount),
              5,
              "unhooked",
            ],
            [
              "tx.backend getNode",
              () =>
                tx.backend
                  .getNode(store.graphId, "Person", bob.id)
                  .then((row) => row?.id),
              bob.id,
              "unhooked",
            ],
          ];

          const observed: unknown[] = [];
          for (const [label, read, _expected, observation] of reads) {
            calls.length = 0;
            hooked.length = 0;
            const result = await read();
            observed.push({
              at: label,
              result,
              // Some statement went through a recording handle, and every
              // one did through an operation of this transaction's own
              // session: the same object, not a session over the same
              // transaction.
              routed: calls.length > 0,
              ofThisSession: calls.every((call) => call.session === session),
              // A hook-observed read: each statement the hooks saw is one the
              // handles carried, so none went around them.
              ...(observation === "hooked" && {
                aroundTheHandles: hooked.length - calls.length,
              }),
            });
          }
          expect(observed).toEqual(
            reads.map(([label, , expected, observation]) => ({
              at: label,
              result: expected,
              routed: true,
              ofThisSession: true,
              ...(observation === "hooked" && { aroundTheHandles: 0 }),
            })),
          );
        });
      } finally {
        entered.mockRestore();
      }
    });
  });
}
