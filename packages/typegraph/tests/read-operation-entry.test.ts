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
} from "../src";
import { projectBackendWithout } from "../src/backend/derive-backend";
import type { GraphBackend } from "../src/backend/types";
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

  beforeEach(async () => {
    backend = createTestBackend();
    store = createStore(graph, backend);
    const created = await store.nodes.Person.create({ name: "Alice", age: 30 });
    const bob = await store.nodes.Person.create({ name: "Bob", age: 40 });
    await store.edges.knows.create(created, bob);
    alice = { kind: "Person", id: created.id };
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
        expect({ at: label, entered: enteredScopes() }).toEqual({
          at: label,
          entered: [session],
        });
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
      expect(enteredScopes()).toEqual([session, session]);
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
        expect({ at: label, entered: enteredScopes() }).toEqual({
          at: label,
          entered: [session],
        });
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
      expect(enteredScopes()).toEqual([builtIn]);
      expect(enteredScopes()).not.toContain(current);
    });

    clearMints();
    await run().catch((error: unknown) => error);
    expect(enteredScopes()).toEqual([builtIn]);
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
      expect({ at: label, entered: enteredScopes() }).toEqual({
        at: label,
        entered: opened,
      });
    }
  });
});
