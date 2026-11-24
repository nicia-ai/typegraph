/**
 * Where a read enters its operation.
 *
 * A read inside a transaction is a public call like a write: it enters one
 * `Operation` of the transaction's session when it EXECUTES — not when the
 * query is built or prepared — and the session reaches it as a value the
 * query carries, never by looking anything up. A target handed in through
 * `executeOn` carries no session, so it enters through
 * `enterTargetOperation`: the root as itself, a transaction as a binding of
 * its own. A root read enters nothing.
 *
 * Operations change nothing a database can observe yet, so these cases watch
 * the mints themselves: the operation-scope module is wrapped with spies that
 * call through to the real functions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  count,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  field,
  param as parameter,
  partOf,
} from "../src";
import { projectBackendWithout } from "../src/backend/derive-backend";
import type { GraphBackend } from "../src/backend/types";
import * as preparedQueryModule from "../src/query/builder/prepared-query";
import type * as OperationScopeModule from "../src/store/operation-scope";
import {
  enterOperation,
  enterTargetOperation,
  type EntryScope,
  openTransactionSession,
  type OperationEntry,
  operationEntrySession,
  type TransactionSession,
} from "../src/store/operation-scope";
import { TRANSACTION_RUNTIME } from "../src/store/types";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend } from "./test-utils";

vi.mock("../src/store/operation-scope", async (importOriginal) => {
  const actual: typeof OperationScopeModule = await importOriginal();
  return {
    ...actual,
    enterOperation: vi.fn(actual.enterOperation),
    enterTargetOperation: vi.fn(actual.enterTargetOperation),
    openTransactionSession: vi.fn(actual.openTransactionSession),
  };
});

const enterOperationSpy = vi.mocked(enterOperation);
const enterTargetOperationSpy = vi.mocked(enterTargetOperation);
const openTransactionSessionSpy = vi.mocked(openTransactionSession);

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), age: z.number() }),
});
const knows = defineEdge("knows");
const graph = defineGraph({
  id: "read_operation_entry",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

/** The scope each `enterOperation` call since the last clear entered from. */
function enteredScopes(): readonly EntryScope[] {
  return enterOperationSpy.mock.calls.map(([scope]) => scope);
}

/** What each `enterTargetOperation` call since the last clear returned. */
function targetEntries(): readonly OperationEntry[] {
  return enterTargetOperationSpy.mock.results.map((result) => {
    if (result.type !== "return") throw new Error("mint threw");
    return result.value;
  });
}

/** What each `openTransactionSession` call since the last clear returned. */
function openedSessions(): readonly TransactionSession[] {
  return openTransactionSessionSpy.mock.results.map((result) => {
    if (result.type !== "return") throw new Error("mint threw");
    const session: TransactionSession = result.value;
    return session;
  });
}

/**
 * Asserts that, since the last clear, `enterOperation` ran `times` times and
 * every call entered from `session` itself: the same object, not an equal
 * one. A fresh session over the same transaction deep-equals the real one.
 */
function expectEnteredFrom(
  label: string,
  session: TransactionSession,
  times: number,
): void {
  const scopes = enteredScopes();
  expect({ at: label, entered: scopes.length }).toEqual({
    at: label,
    entered: times,
  });
  // `toBe`, never a deep comparison: a fresh session deep-equals this one.
  for (const scope of scopes) expect(scope).toBe(session);
}

function clearMints(): void {
  enterOperationSpy.mockClear();
  enterTargetOperationSpy.mockClear();
  openTransactionSessionSpy.mockClear();
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

function peopleQuery(store: GraphStore) {
  return store
    .query()
    .from("Person", "p")
    .orderBy("p", "name")
    .select((ctx) => ({ name: ctx.p.name }));
}

type GraphStore = ReturnType<typeof createStore<typeof graph>>;

describe("a read enters its operation at execution", () => {
  let backend: GraphBackend;
  let store: GraphStore;
  let alice: Readonly<{ kind: "Person"; id: string }>;
  let aliceNode: Awaited<ReturnType<GraphStore["nodes"]["Person"]["create"]>>;

  beforeEach(async () => {
    backend = createTestBackend();
    store = createStore(graph, backend);
    const created = await store.nodes.Person.create({ name: "Alice", age: 30 });
    const bob = await store.nodes.Person.create({ name: "Bob", age: 40 });
    await store.edges.knows.create(created, bob);
    alice = { kind: "Person", id: created.id };
    aliceNode = created;
    clearMints();
  });

  afterEach(() => {
    clearMints();
  });

  it("every terminal inside a transaction enters one operation of that transaction's session per call, and building or preparing enters none", async () => {
    await store.transaction(async (tx) => {
      const session = await sessionOf(() =>
        tx.nodes.Person.create({ name: "Carol", age: 50 }),
      );

      clearMints();
      const people = tx
        .query()
        .from("Person", "p")
        .orderBy("p", "name")
        .select((ctx) => ({ name: ctx.p.name }));
      const byName = tx
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq(parameter("name")))
        .select((ctx) => ({ name: ctx.p.name }))
        .prepare();
      const names = tx
        .query()
        .from("Person", "p")
        .project((ctx) => ({ name: ctx.p.name }));
      const preparedNames = tx
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq(parameter("name")))
        .project((ctx) => ({ name: ctx.p.name }))
        .prepare();
      const relation = names.asRelation();
      const preparedRelation = tx
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq(parameter("name")))
        .project((ctx) => ({ name: ctx.p.name }))
        .asRelation()
        .prepare();
      const ages = tx
        .query()
        .from("Person", "p")
        .groupBy("p", "name")
        .aggregate({ name: field("p", "name"), people: count("p") });
      const union = people.unionAll(
        tx
          .query()
          .from("Person", "p")
          .orderBy("p", "name")
          .select((ctx) => ({ name: ctx.p.name })),
      );
      expect({
        at: "building and preparing",
        entered: enteredScopes(),
      }).toEqual({
        at: "building and preparing",
        entered: [],
      });

      const terminals: readonly (readonly [string, () => Promise<unknown>])[] =
        [
          ["query execute", () => people.execute()],
          ["query first", () => people.first()],
          ["query count", () => people.count()],
          ["query exists", () => people.exists()],
          ["query paginate", () => people.paginate({ first: 10 })],
          ["query page", () => people.page({ first: 10 }).execute()],
          [
            "query stream (one page)",
            async () => {
              for await (const row of people.stream({ batchSize: 10 }))
                void row;
            },
          ],
          ["prepared query", () => byName.execute({ name: "Alice" })],
          ["projection execute", () => names.execute()],
          ["projection first", () => names.first()],
          ["projection count", () => names.count()],
          ["projection exists", () => names.exists()],
          [
            "prepared projection",
            () => preparedNames.execute({ name: "Alice" }),
          ],
          ["relation execute", () => relation.execute()],
          ["relation first", () => relation.first()],
          ["relation count", () => relation.count()],
          ["relation exists", () => relation.exists()],
          [
            "prepared relation",
            () => preparedRelation.execute({ name: "Alice" }),
          ],
          ["aggregate execute", () => ages.execute()],
          ["aggregate first", () => ages.first()],
          ["aggregate count", () => ages.count()],
          ["union execute", () => union.execute()],
        ];
      for (const [label, run] of terminals) {
        clearMints();
        await run();
        expectEnteredFrom(label, session, 1);
        expect({ at: label, targets: targetEntries() }).toEqual({
          at: label,
          targets: [],
        });
      }

      // A prepared query enters one operation per execution, never one it
      // kept from an earlier execution or from prepare().
      clearMints();
      await byName.execute({ name: "Alice" });
      await byName.execute({ name: "Bob" });
      expectEnteredFrom("prepared query, twice", session, 2);
    });
  });

  it("each tx.backend read member enters one operation of the transaction's session per call", async () => {
    await store.transaction(async (tx) => {
      const session = await sessionOf(() =>
        tx.nodes.Person.create({ name: "Carol", age: 50 }),
      );
      const reads: readonly (readonly [string, () => Promise<unknown>])[] = [
        ["getActiveSchema", () => tx.backend.getActiveSchema(graph.id)],
        [
          "findNodesByKind",
          () =>
            tx.backend.findNodesByKind({ graphId: graph.id, kind: "Person" }),
        ],
        [
          "countNodesByKind",
          () =>
            tx.backend.countNodesByKind({ graphId: graph.id, kind: "Person" }),
        ],
        ["getNode", () => tx.backend.getNode(graph.id, "Person", "missing")],
        [
          "getNodes",
          () => {
            const getNodes = tx.backend.getNodes;
            if (getNodes === undefined) throw new Error("no getNodes");
            return getNodes(graph.id, "Person", ["missing"]);
          },
        ],
      ];
      for (const [label, read] of reads) {
        clearMints();
        await read();
        expectEnteredFrom(label, session, 1);
      }
    });
  });

  it("a query enters the session it was built in, whichever transaction is open when it executes", async () => {
    let built:
      | Readonly<{ session: TransactionSession; run: () => Promise<unknown> }>
      | undefined;
    await store.transaction(async (tx) => {
      const session = await sessionOf(() =>
        tx.nodes.Person.create({ name: "Carol", age: 50 }),
      );
      const query = tx
        .query()
        .from("Person", "p")
        .select((ctx) => ({ name: ctx.p.name }));
      built = { session, run: () => query.execute() };
    });
    const { session: builtIn, run } = built ?? {};
    if (builtIn === undefined || run === undefined) throw new Error("unbuilt");

    await store.transaction(async (tx) => {
      const current = await sessionOf(() =>
        tx.nodes.Person.create({ name: "Dave", age: 60 }),
      );
      clearMints();
      // Whether the ended transaction still answers is the driver's business;
      // the operation is entered before any statement either way.
      await run().catch((error: unknown) => error);
      expectEnteredFrom("inside another transaction", builtIn, 1);
      expect(enteredScopes()).not.toContain(current);
    });

    clearMints();
    await run().catch((error: unknown) => error);
    expectEnteredFrom("after it ended", builtIn, 1);
  });

  it("a root read enters nothing and opens no session", async () => {
    const people = store
      .query()
      .from("Person", "p")
      .select((ctx) => ({ name: ctx.p.name }));
    const prepared = store
      .query()
      .from("Person", "p")
      .whereNode("p", (p) => p.name.eq(parameter("name")))
      .select((ctx) => ({ name: ctx.p.name }))
      .prepare();
    const names = store
      .query()
      .from("Person", "p")
      .project((ctx) => ({ name: ctx.p.name }));
    clearMints();

    await people.execute();
    await people.count();
    await prepared.execute({ name: "Alice" });
    await names.execute();
    await names.asRelation().execute();

    expect(enterOperationSpy).not.toHaveBeenCalled();
    expect(enterTargetOperationSpy).not.toHaveBeenCalled();
    expect(openTransactionSessionSpy).not.toHaveBeenCalled();
  });

  describe("executeOn takes an outside target through its public signature", () => {
    it("a root backend runs as itself, entered once per call", async () => {
      const query = peopleQuery(store);
      const aggregate = store
        .query()
        .from("Person", "p")
        .aggregate({ people: count("p") });
      clearMints();
      expect(await query.executeOn(backend)).toEqual([
        { name: "Alice" },
        { name: "Bob" },
      ]);
      expect(targetEntries()).toEqual([backend]);
      // The aggregate adapts to a relation and runs the relation's executeOn
      // work on the entry it made, rather than entering a second one.
      clearMints();
      expect(await aggregate.executeOn(backend)).toEqual([{ people: 2 }]);
      expect(targetEntries()).toEqual([backend]);
      expect(enterOperationSpy).not.toHaveBeenCalled();
    });

    it("an engine transaction the caller opened joins as a binding of its own, once per call", async () => {
      const query = peopleQuery(store);
      const aggregate = store
        .query()
        .from("Person", "p")
        .aggregate({ people: count("p") });
      clearMints();
      await backend.transaction(async (engineTransaction) => {
        await engineTransaction.insertNode({
          graphId: graph.id,
          kind: "Person",
          id: "engine-only",
          props: { name: "Erin", age: 70 },
        });
        // It runs inside the caller's transaction: it sees the row the
        // caller has not committed.
        expect(await query.executeOn(engineTransaction)).toEqual([
          { name: "Alice" },
          { name: "Bob" },
          { name: "Erin" },
        ]);
        expect(await query.executeOn(engineTransaction)).toHaveLength(3);
        const sessions = targetEntries().map((entry) =>
          operationEntrySession(entry),
        );
        // One entry per call, each the first operation of a new session.
        expect(sessions).toHaveLength(2);
        expect(sessions[0]).toBeDefined();
        expect(sessions[1]).toBeDefined();
        expect(sessions[0]).not.toBe(sessions[1]);

        // A relation-backed read refuses a target outside its provenance
        // before it enters anything.
        clearMints();
        await expect(aggregate.executeOn(engineTransaction)).rejects.toThrow(
          "A relation cannot execute on a different database or transaction target.",
        );
        expect(enterTargetOperationSpy).not.toHaveBeenCalled();
      });
    });

    it("another Store's transaction joins as a binding of its own, not as that Store's session", async () => {
      const other = createStore(graph, backend);
      const query = peopleQuery(store);
      await other.transaction(async (tx) => {
        const otherSession = await sessionOf(() =>
          tx.nodes.Person.create({ name: "Frank", age: 80 }),
        );
        clearMints();
        expect(
          await query.executeOn(tx[TRANSACTION_RUNTIME].backend),
        ).toContainEqual({ name: "Frank" });
        const [entry] = targetEntries();
        if (entry === undefined) throw new Error("no entry");
        const session = operationEntrySession(entry);
        expect(session).toBeDefined();
        expect(session).not.toBe(otherSession);
      });
    });

    it("store.batch() opens the session of the transaction it opens, and each item joins through executeOn", async () => {
      clearMints();
      const [people, knowsFromAlice] = await store.batch(
        peopleQuery(store),
        store.edges.knows.batchFindFrom(alice),
      );
      expect(people).toHaveLength(2);
      expect(knowsFromAlice).toHaveLength(1);
      // The batch's own entry, then one per item.
      const sessions = targetEntries().map((entry) =>
        operationEntrySession(entry),
      );
      expect(sessions).toHaveLength(3);
      expect(new Set(sessions).size).toBe(3);
      for (const session of sessions) expect(session).toBeDefined();
    });
  });

  it("an iterative algorithm enters one operation of the session of the read transaction it opens", async () => {
    const inlineStore = createStore(
      graph,
      projectBackendWithout(backend, ["executeTemporaryStatement"]),
    );
    for (const [label, algorithms] of [
      ["working table", store.algorithms],
      ["inline", inlineStore.algorithms],
    ] as const) {
      clearMints();
      const reached = await algorithms.reachable(alice, {
        edges: ["knows"],
        maxHops: 2,
      });
      expect({ at: label, depths: reached.map((node) => node.depth) }).toEqual({
        at: label,
        depths: [0, 1],
      });
      const opened = openedSessions();
      expect({ at: label, opened: opened.length }).toEqual({
        at: label,
        opened: 1,
      });
      expectEnteredFrom(label, requireDefined(opened[0]), 1);
    }
  });

  it("batchOnce, neighbors, countNeighbors, subgraph, describe and validateStore inside a transaction each enter one operation of its session per call", async () => {
    await store.transaction(async (tx) => {
      const session = await sessionOf(() =>
        tx.nodes.Person.create({ name: "Carol", age: 50 }),
      );
      const reads: readonly (readonly [string, () => Promise<unknown>])[] = [
        [
          "batchOnce",
          () =>
            tx.batchOnce((read) => [
              read.neighbors(aliceNode, { edges: ["knows"] }),
              read.countNeighbors(aliceNode, { edges: ["knows"] }),
              read.subgraph(aliceNode, { edges: ["knows"], maxDepth: 2 }),
              tx
                .query()
                .from("Person", "p")
                .select((ctx) => ({ name: ctx.p.name })),
            ]),
        ],
        ["neighbors", () => tx.neighbors(aliceNode, { edges: ["knows"] })],
        [
          "countNeighbors",
          () => tx.countNeighbors(aliceNode, { edges: ["knows"] }),
        ],
        [
          "subgraph",
          () => tx.subgraph(aliceNode, { edges: ["knows"], maxDepth: 2 }),
        ],
        ["describe", () => tx.describe()],
        [
          "validateStore",
          () => tx.validateStore({ entity: "node", kind: "Person" }),
        ],
      ];
      const observed: unknown[] = [];
      for (const [label, read] of reads) {
        clearMints();
        await read();
        const scopes = enteredScopes();
        observed.push({
          at: label,
          entered: scopes.length,
          // Identity, not equality: a fresh session over the same
          // transaction deep-equals this one.
          ofThisSession: scopes.every((scope) => scope === session),
          targets: targetEntries().length,
        });
      }
      expect(observed).toEqual(
        reads.map(([label]) => ({
          at: label,
          entered: 1,
          ofThisSession: true,
          targets: 0,
        })),
      );
    });
  });

  it("a refusal that needs no statement happens before any operation is entered, on every terminal", async () => {
    const otherBackend = createTestBackend();
    await store.transaction(async (tx) => {
      const unbound = tx
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq(parameter("name")))
        .orderBy("p", "name")
        .select((ctx) => ({ name: ctx.p.name }));
      const unboundProjection = tx
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq(parameter("name")))
        .project((ctx) => ({ name: ctx.p.name }));
      const unboundRelation = unboundProjection.asRelation();
      const unboundAggregate = tx
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq(parameter("name")))
        .groupBy("p", "name")
        .aggregate({ name: field("p", "name"), people: count("p") });
      const unboundUnion = unbound.unionAll(
        tx
          .query()
          .from("Person", "p")
          .orderBy("p", "name")
          .select((ctx) => ({ name: ctx.p.name })),
      );
      const people = tx
        .query()
        .from("Person", "p")
        .orderBy("p", "name")
        .select((ctx) => ({ name: ctx.p.name }));
      const prepared = unbound.prepare();
      const preparedProjection = unboundProjection.prepare();
      const preparedRelation = unboundRelation.prepare();
      const refusals: readonly (readonly [string, () => Promise<unknown>])[] = [
        ["query execute", () => unbound.execute()],
        ["query first", () => unbound.first()],
        ["query count", () => unbound.count()],
        ["query exists", () => unbound.exists()],
        ["query paginate", () => unbound.paginate({ first: 10 })],
        ["query paginate, bad limit", () => people.paginate({ first: -1 })],
        [
          "query stream",
          async () => {
            for await (const row of unbound.stream({ batchSize: 10 })) void row;
          },
        ],
        [
          "query stream, bad batch size",
          async () => {
            for await (const row of people.stream({ batchSize: -1 })) void row;
          },
        ],
        ["query executeOn", () => unbound.executeOn(backend)],
        ["prepared query, missing binding", () => prepared.execute({})],
        ["projection execute", () => unboundProjection.execute()],
        ["projection first", () => unboundProjection.first()],
        ["projection count", () => unboundProjection.count()],
        ["projection exists", () => unboundProjection.exists()],
        ["projection executeOn", () => unboundProjection.executeOn(backend)],
        [
          "prepared projection, missing binding",
          () => preparedProjection.execute({}),
        ],
        ["relation execute", () => unboundRelation.execute()],
        ["relation first", () => unboundRelation.first()],
        ["relation count", () => unboundRelation.count()],
        ["relation exists", () => unboundRelation.exists()],
        ["relation executeOn", () => unboundRelation.executeOn(backend)],
        [
          "relation executeOn, foreign target",
          () =>
            tx
              .query()
              .from("Person", "p")
              .project((ctx) => ({ name: ctx.p.name }))
              .asRelation()
              .executeOn(otherBackend),
        ],
        [
          "prepared relation, missing binding",
          () => preparedRelation.execute({}),
        ],
        ["aggregate execute", () => unboundAggregate.execute()],
        ["aggregate first", () => unboundAggregate.first()],
        ["aggregate count", () => unboundAggregate.count()],
        ["aggregate executeOn", () => unboundAggregate.executeOn(backend)],
        ["union execute", () => unboundUnion.execute()],
        ["union executeOn", () => unboundUnion.executeOn(backend)],
        [
          "batchOnce, bad option",
          () =>
            tx.batchOnce(() => [people], {
              shareSubgraphs: "yes" as unknown as boolean,
            }),
        ],
        ["batchOnce, unbound query", () => tx.batchOnce(() => [unbound])],
        [
          "neighbors, bad limit",
          () => tx.neighbors(aliceNode, { edges: ["knows"], limit: -1 }),
        ],
        [
          "subgraph, bad depth",
          () => tx.subgraph(aliceNode, { edges: ["knows"], maxDepth: -1 }),
        ],
        [
          "validateStore, unknown kind",
          () => tx.validateStore({ entity: "node", kind: "Nobody" }),
        ],
        [
          "validateStore, bad page size",
          () =>
            tx.validateStore({ entity: "node", kind: "Person", pageSize: 0 }),
        ],
      ];
      const observed: unknown[] = [];
      for (const [label, refuse] of refusals) {
        clearMints();
        // A synchronous throw counts as a refusal too.
        const outcome = await Promise.resolve()
          .then(refuse)
          .then(
            () => "resolved",
            (error: unknown) => error,
          );
        observed.push({
          at: label,
          refused: outcome instanceof Error,
          entered: enterOperationSpy.mock.calls.length,
          targets: enterTargetOperationSpy.mock.calls.length,
          sessions: openTransactionSessionSpy.mock.calls.length,
        });
      }
      expect(observed).toEqual(
        refusals.map(([label]) => ({
          at: label,
          refused: true,
          entered: 0,
          targets: 0,
          sessions: 0,
        })),
      );
    });
  });

  it("a stream enters one operation per page: each page is its own statement, and other calls interleave between pages", async () => {
    await store.transaction(async (tx) => {
      const session = await sessionOf(() =>
        tx.nodes.Person.create({ name: "Carol", age: 50 }),
      );
      await tx.nodes.Person.create({ name: "Dave", age: 60 });
      await tx.nodes.Person.create({ name: "Erin", age: 70 });
      const people = tx
        .query()
        .from("Person", "p")
        .orderBy("p", "name")
        .select((ctx) => ({ name: ctx.p.name }));

      clearMints();
      const streamed: string[] = [];
      // The calls the loop body makes between pages; each enters its own.
      let interleaved = 0;
      for await (const row of people.stream({ batchSize: 2 })) {
        streamed.push(row.name);
        // Five rows in pages of two: a call between the pages, and one
        // after the last page's rows.
        if (streamed.length % 2 === 0) {
          await tx
            .query()
            .from("Person", "p")
            .select((ctx) => ctx.p.id)
            .count();
          interleaved += 1;
        }
      }
      expect(streamed).toEqual(["Alice", "Bob", "Carol", "Dave", "Erin"]);
      expect(interleaved).toBe(2);
      // Three pages and two interleaved calls: five operations, all of this
      // transaction's session, none held across the awaits between pages.
      expectEnteredFrom("three pages", session, 3 + interleaved);
    });
  });

  it("a prepared query is fixed at construction: changing the configuration it was built from changes nothing", async () => {
    const otherBackend = createTestBackend();
    const otherStore = createStore(graph, otherBackend);
    await otherStore.nodes.Person.create({ name: "Zed", age: 99 });
    // The configurations the Store hands the constructor, recorded as the
    // real class receives them.
    const { PreparedQuery } = preparedQueryModule;
    const configs: preparedQueryModule.PreparedQueryConfig<unknown>[] = [];
    const constructed = vi
      .spyOn(preparedQueryModule, "PreparedQuery")
      .mockImplementation(
        class RecordingPreparedQuery<R> extends PreparedQuery<R> {
          constructor(config: preparedQueryModule.PreparedQueryConfig<R>) {
            configs.push(config);
            super(config);
          }
        },
      );
    try {
      store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.age.gte(parameter("age")))
        .orderBy("p", "name")
        .select((ctx) => ({ name: ctx.p.name }))
        .prepare();
      const config = requireDefined(configs[0]);
      // A caller that builds its own prepared query from a configuration
      // object it keeps, and later reuses that object for another database.
      const reused: {
        -readonly [Key in keyof typeof config]: (typeof config)[Key];
      } = { ...config };
      const fixed = new PreparedQuery(reused);
      reused.backend = otherBackend;
      expect(await fixed.execute({ age: 0 })).toEqual([
        { name: "Alice" },
        { name: "Bob" },
      ]);

      // Inside a transaction the configuration also carries the session's
      // operation source; replacing it afterwards leaves the session the
      // query was prepared in.
      await store.transaction(async (tx) => {
        const session = await sessionOf(() =>
          tx.nodes.Person.create({ name: "Carol", age: 50 }),
        );
        configs.length = 0;
        tx.query()
          .from("Person", "p")
          .whereNode("p", (p) => p.age.gte(parameter("age")))
          .orderBy("p", "name")
          .select((ctx) => ({ name: ctx.p.name }))
          .prepare();
        const txConfig = requireDefined(configs[0]);
        const carried: Record<PropertyKey, unknown> = { ...txConfig };
        const sourceKeys = Object.getOwnPropertySymbols(carried);
        expect(sourceKeys).toHaveLength(1);
        const fixedInTx = new PreparedQuery(carried as typeof txConfig);
        let replacedEntered = 0;
        for (const key of sourceKeys)
          carried[key] = () => {
            replacedEntered += 1;
            return otherBackend;
          };
        carried["backend"] = otherBackend;
        clearMints();
        expect(await fixedInTx.execute({ age: 0 })).toEqual([
          { name: "Alice" },
          { name: "Bob" },
          { name: "Carol" },
        ]);
        expect(replacedEntered).toBe(0);
        expectEnteredFrom("prepared in the transaction", session, 1);
      });
    } finally {
      constructed.mockRestore();
    }
  });

  it("a composition subgraph inside a transaction runs its closure walk and fetches under the one operation it enters", async () => {
    const Album = defineNode("Album", {
      schema: z.object({ title: z.string() }),
    });
    const Track = defineNode("Track", {
      schema: z.object({ title: z.string() }),
    });
    const trackOf = defineEdge("trackOf");
    const albums = defineGraph({
      id: "read_operation_entry_composition",
      nodes: { Album: { type: Album }, Track: { type: Track } },
      edges: {
        trackOf: {
          type: trackOf,
          from: [Track],
          to: [Album],
          cardinality: "one",
        },
      },
      ontology: [partOf(Track, Album, { via: trackOf })],
    });
    const albumStore = createStore(albums, createTestBackend());
    const album = await albumStore.nodes.Album.create({ title: "A" });
    const track = await albumStore.nodes.Track.create({ title: "T" });
    await albumStore.edges.trackOf.create(track, album);
    await albumStore.transaction(async (tx) => {
      const session = await sessionOf(() =>
        tx.nodes.Track.create({ title: "U" }),
      );
      clearMints();
      const unit = await tx.subgraph(album, { edges: [], composition: true });
      expect(new Set(unit.nodes.map((node) => node.id))).toEqual(
        new Set([album.id, track.id]),
      );
      expectEnteredFrom("composition subgraph", session, 1);
    });
  });
});
