/**
 * Backend-interaction contracts, asserted by tracing WHERE work happens
 * rather than only what state results:
 *
 * - Read-path contract: the found path of every getOrCreate never opens a
 *   write transaction and never calls a write method.
 * - Atomicity contract: every mutation's row and sidecar writes (uniques,
 *   fulltext) happen inside a transaction, never on the root connection.
 * - Hook contract: an operation whose transaction fails at COMMIT reports
 *   through `onError` and never through `onOperationEnd`, for every hooked
 *   node and edge operation — hooks wrap the transaction, so success means
 *   durably committed.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  searchable,
} from "../src";
import { dumpObservableState } from "./state-snapshot";
import { createTestBackend } from "./test-utils";
import {
  createCommitFailingBackend,
  createTracingBackend,
  InjectedCommitFailure,
} from "./trace-backend";

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    email: z.string(),
    bio: searchable({ language: "english" }),
  }),
});

const knows = defineEdge("knows", {
  schema: z.object({ weight: z.number() }),
});

const graph = defineGraph({
  id: "backend_contracts",
  nodes: {
    Person: {
      type: Person,
      onDelete: "cascade",
      unique: [
        {
          name: "person_email",
          fields: ["email"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {
    knows: { type: knows, from: [Person], to: [Person] },
  },
});

const WRITE_METHOD_PATTERN =
  /insertNode|updateNode|deleteNode|hardDeleteNode|insertEdge|updateEdge|deleteEdge|hardDeleteEdge|insertUnique|deleteUnique|upsertFulltext|deleteFulltext|upsertEmbedding|deleteEmbedding/;

function writeCalls(calls: readonly string[]): string[] {
  return calls.filter((call) => WRITE_METHOD_PATTERN.test(call));
}

async function seedPair(store: {
  nodes: {
    Person: {
      create: (
        props: { name: string; email: string; bio: string },
        options: { id: string },
      ) => Promise<unknown>;
    };
  };
}) {
  await store.nodes.Person.create(
    { name: "A", email: "a@example.com", bio: "alpha" },
    { id: "person-a" },
  );
  await store.nodes.Person.create(
    { name: "B", email: "b@example.com", bio: "beta" },
    { id: "person-b" },
  );
}

describe("read-path contract: found paths perform no write work", () => {
  it("node getOrCreateByConstraint found path opens no transaction", async () => {
    const trace = createTracingBackend(createTestBackend());
    const [store] = await createStoreWithSchema(graph, trace.backend);
    await seedPair(store);

    trace.reset();
    const result = await store.nodes.Person.getOrCreateByConstraint(
      "person_email",
      { name: "A", email: "a@example.com", bio: "alpha" },
    );
    expect(result.action).toBe("found");
    expect(trace.calls.filter((call) => call.includes("transaction"))).toEqual(
      [],
    );
    expect(writeCalls(trace.calls)).toEqual([]);
  });

  it("edge getOrCreateByEndpoints found path opens no transaction", async () => {
    const trace = createTracingBackend(createTestBackend());
    const [store] = await createStoreWithSchema(graph, trace.backend);
    await seedPair(store);
    await store.edges.knows.getOrCreateByEndpoints(
      { kind: "Person", id: "person-a" } as never,
      { kind: "Person", id: "person-b" } as never,
      { weight: 1 },
    );

    trace.reset();
    const found = await store.edges.knows.getOrCreateByEndpoints(
      { kind: "Person", id: "person-a" } as never,
      { kind: "Person", id: "person-b" } as never,
      { weight: 1 },
    );
    expect(found.action).toBe("found");
    expect(trace.calls.filter((call) => call.includes("transaction"))).toEqual(
      [],
    );
    expect(writeCalls(trace.calls)).toEqual([]);
  });
});

describe("atomicity contract: writes happen only inside transactions", () => {
  it("row and sidecar writes for every mutation carry the tx prefix", async () => {
    const trace = createTracingBackend(createTestBackend());
    const [store] = await createStoreWithSchema(graph, trace.backend);

    trace.reset();
    const created = await store.nodes.Person.create(
      { name: "A", email: "a@example.com", bio: "alpha" },
      { id: "person-a" },
    );
    await store.nodes.Person.create(
      { name: "B", email: "b@example.com", bio: "beta" },
      { id: "person-b" },
    );
    await store.nodes.Person.update(created.id, { name: "A2" });
    await store.edges.knows.create(
      { kind: "Person", id: "person-a" } as never,
      { kind: "Person", id: "person-b" } as never,
      { weight: 1 },
      { id: "knows-1" },
    );
    await store.edges.knows.update("knows-1" as never, { weight: 2 });
    await store.edges.knows.delete("knows-1" as never);
    await store.nodes.Person.delete(created.id);

    const rootWrites = writeCalls(trace.calls).filter(
      (call) => !call.startsWith("tx."),
    );
    expect(rootWrites).toEqual([]);
    // Sanity: the trace actually observed sidecar writes inside transactions.
    expect(writeCalls(trace.calls).includes("tx.insertUnique")).toBe(true);
  });
});

describe("hook contract: success is reported only after COMMIT", () => {
  type HookEvents = string[];

  async function buildStore() {
    const failing = createCommitFailingBackend(createTestBackend());
    const events: HookEvents = [];
    const [store] = await createStoreWithSchema(graph, failing.backend, {
      hooks: {
        onOperationStart: (ctx) => {
          events.push(`start:${ctx.operation}:${ctx.entity}`);
        },
        onOperationEnd: (ctx) => {
          events.push(`end:${ctx.operation}:${ctx.entity}`);
        },
        onError: (ctx, error) => {
          events.push(`error:${error.name}`);
        },
      },
    });
    await seedPair(store);
    await store.edges.knows.create(
      { kind: "Person", id: "person-a" } as never,
      { kind: "Person", id: "person-b" } as never,
      { weight: 1 },
      { id: "knows-1" },
    );
    return { store, failing, events };
  }

  type Matrix = readonly Readonly<{
    name: string;
    run: (
      store: Awaited<ReturnType<typeof buildStore>>["store"],
    ) => Promise<unknown>;
  }>[];

  const operations: Matrix = [
    {
      name: "node create",
      run: (store) =>
        store.nodes.Person.create(
          { name: "C", email: "c@example.com", bio: "gamma" },
          { id: "person-c" },
        ),
    },
    {
      name: "node update",
      run: (store) =>
        store.nodes.Person.update("person-a" as never, { name: "A2" }),
    },
    {
      name: "node delete",
      run: (store) => store.nodes.Person.delete("person-a" as never),
    },
    {
      name: "node hardDelete",
      run: (store) => store.nodes.Person.hardDelete("person-a" as never),
    },
    {
      name: "node getOrCreateByConstraint (creating)",
      run: (store) =>
        store.nodes.Person.getOrCreateByConstraint("person_email", {
          name: "D",
          email: "d@example.com",
          bio: "delta",
        }),
    },
    {
      name: "edge create",
      run: (store) =>
        store.edges.knows.create(
          { kind: "Person", id: "person-b" } as never,
          { kind: "Person", id: "person-a" } as never,
          { weight: 3 },
          { id: "knows-2" },
        ),
    },
    {
      name: "edge update",
      run: (store) =>
        store.edges.knows.update("knows-1" as never, { weight: 9 }),
    },
    {
      name: "edge delete",
      run: (store) => store.edges.knows.delete("knows-1" as never),
    },
    {
      name: "edge hardDelete",
      run: (store) => store.edges.knows.hardDelete("knows-1" as never),
    },
    {
      name: "edge getOrCreateByEndpoints (creating)",
      run: (store) =>
        store.edges.knows.getOrCreateByEndpoints(
          { kind: "Person", id: "person-b" } as never,
          { kind: "Person", id: "person-a" } as never,
          { weight: 5 },
        ),
    },
  ];

  it("operations inside store.transaction defer success hooks to COMMIT", async () => {
    const { store, failing, events } = await buildStore();
    events.length = 0;

    failing.arm();
    await expect(
      store.transaction(async (tx) => {
        await tx.nodes.Person.create(
          { name: "C", email: "c@example.com", bio: "gamma" },
          { id: "person-c" },
        );
      }),
    ).rejects.toThrow(InjectedCommitFailure);
    failing.disarm();

    // The nested create completed inside the transaction, but the commit
    // failed: its success must be converted into onError, never reported as
    // onOperationEnd.
    expect(events).toContain("start:create:node");
    expect(events.some((event) => event.startsWith("end:"))).toBe(false);
    expect(events).toContain("error:InjectedCommitFailure");

    events.length = 0;
    await store.transaction(async (tx) => {
      await tx.nodes.Person.create(
        { name: "C", email: "c@example.com", bio: "gamma" },
        { id: "person-c" },
      );
      // Completed inside the callback, but not yet committed: no end event.
      expect(events.some((event) => event.startsWith("end:"))).toBe(false);
    });
    expect(events).toContain("end:create:node");
  });

  for (const operation of operations) {
    it(`${operation.name}: commit failure reports onError, never onOperationEnd, and rolls back`, async () => {
      const { store, failing, events } = await buildStore();
      const before = await dumpObservableState(store);
      events.length = 0;

      failing.arm();
      await expect(operation.run(store)).rejects.toThrow(InjectedCommitFailure);
      failing.disarm();

      expect(events.some((event) => event.startsWith("start:"))).toBe(true);
      expect(events.some((event) => event.startsWith("end:"))).toBe(false);
      expect(events).toContain("error:InjectedCommitFailure");

      // The rollback was real: nothing observable changed.
      const after = await dumpObservableState(store);
      expect(after).toEqual(before);
    });
  }
});
