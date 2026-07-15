import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  asCompiledRowsSql,
  createStore,
  createStoreWithSchema,
  createVerifiedStore,
  defineEdge,
  defineGraph,
  defineGraphExtension,
  defineNode,
  type GraphBackend,
} from "../src";
import { ConfigurationError, IdentityContradictionError } from "../src/errors";
import { exportGraph, importGraph } from "../src/interchange";
import { disjointWith } from "../src/ontology";
import { createSqlSchema } from "../src/query/compiler/schema";
import {
  createInitializedStore,
  createTestBackend,
  disableTransactions,
} from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const Author = defineNode("Author", {
  schema: z.object({ penName: z.string() }),
});
const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});
const knows = defineEdge("knows", {
  schema: z.object({}),
});

const graph = defineGraph({
  id: "identity_unit",
  nodes: {
    Person: { type: Person },
    Author: { type: Author },
    Company: { type: Company },
  },
  edges: {
    knows: { type: knows, from: [Person, Author], to: [Person] },
  },
  ontology: [disjointWith(Person, Company)],
  identity: { sameIdAcrossKinds: "fold" },
});

const disabledGraph = defineGraph({
  id: "identity_disabled_unit",
  nodes: { Person: { type: Person } },
  edges: {},
});

const disabledMigrationGraph = defineGraph({
  id: graph.id,
  nodes: graph.nodes,
  edges: graph.edges,
});

describe("Operational Identity", () => {
  it("fails with the stable capability code on non-transactional drivers", () => {
    const backend = disableTransactions(createTestBackend());

    expect(() => createStore(graph, backend)).toThrow(
      expect.objectContaining({
        name: "ConfigurationError",
        details: expect.objectContaining({
          code: "IDENTITY_REQUIRES_ATOMIC_BACKEND",
        }),
      }),
    );
  });

  it("does no identity SQL for disabled graph node writes", async () => {
    const base = createTestBackend();
    let executeCalls = 0;
    let statementCalls = 0;
    const backend: GraphBackend = {
      ...base,
      execute(query) {
        executeCalls += 1;
        return base.execute(query);
      },
      async executeStatement(query) {
        statementCalls += 1;
        await base.executeStatement?.(query);
      },
    };
    const store = createStore(disabledGraph, backend);

    await store.nodes.Person.create({ name: "Alice" }, { id: "alice" });

    expect(executeCalls).toBe(0);
    expect(statementCalls).toBe(0);
    expect(() =>
      createStore(disabledGraph, disableTransactions(base)),
    ).not.toThrow(ConfigurationError);
  });

  it("advances revision once per transaction and zero times for closure rebuild", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const [store] = await createStoreWithSchema(graph, createTestBackend(), {
        revisionTracking: true,
      });
      const first = await store.nodes.Person.create({ name: "First" });
      const second = await store.nodes.Person.create({ name: "Second" });
      const third = await store.nodes.Person.create({ name: "Third" });
      const fourth = await store.nodes.Person.create({ name: "Fourth" });
      const before = await store.revisionNow();
      expect(before).toBeDefined();

      await store.transaction(async (tx) => {
        await tx.identity.assertSame(first, second);
        await tx.identity.assertDifferent(third, fourth);
      });
      const after = await store.revisionNow();
      expect(Date.parse(after!) - Date.parse(before!)).toBe(1);

      const [sameAssertion] = await store.identity.assertionsOf(first);
      expect(sameAssertion).toBeDefined();
      await store.identity.retractAssertion(sameAssertion!.id);
      const afterRetraction = await store.revisionNow();
      expect(Date.parse(afterRetraction!) - Date.parse(after!)).toBe(1);

      await store.rebuildIdentityClosure();
      expect(await store.revisionNow()).toBe(afterRetraction);
    } finally {
      vi.useRealTimers();
    }
  });

  it("captures identity after-images at the assertion commit instant", async () => {
    const [store] = await createStoreWithSchema(graph, createTestBackend(), {
      history: true,
    });
    const person = await store.nodes.Person.create({ name: "Alice" });
    const author = await store.nodes.Author.create({ penName: "A." });
    const assertion = await store.identity.assertSame(person, author);
    const assertionCommit = await store.recordedNow();
    expect(assertionCommit).toBeDefined();
    const schema = createSqlSchema(store.backend.tableNames);
    const rows = await store.backend.execute<{ recorded_from: string }>(
      asCompiledRowsSql(sql`
        SELECT recorded_from
        FROM ${schema.recordedIdentityAssertionsTable}
        WHERE graph_id = ${store.graphId} AND id = ${assertion.id}
      `),
    );
    expect(new Date(rows[0]!.recorded_from).toISOString()).toBe(
      assertionCommit,
    );

    await store.identity.retractAssertion(assertion.id);
    expect(await store.identity.assertionsOf(person)).toEqual([]);
    expect(
      await store.asOfRecorded(assertionCommit!).identity.assertionsOf(person),
    ).toEqual([assertion]);
  });

  it("validates and materializes existing same-id groups during enablement", async () => {
    const backend = createTestBackend();
    const [disabledStore] = await createStoreWithSchema(
      disabledMigrationGraph,
      backend,
    );
    await disabledStore.nodes.Person.create({ name: "Alice" }, { id: "alice" });
    await disabledStore.nodes.Author.create({ penName: "A." }, { id: "alice" });

    const [enabledStore, result] = await createStoreWithSchema(graph, backend);
    expect(result.status).toBe("migrated");
    expect(
      await enabledStore.identity.membersOf({ kind: "Person", id: "alice" }),
    ).toEqual([
      { kind: "Author", id: "alice" },
      { kind: "Person", id: "alice" },
    ]);

    const [verified] = await createVerifiedStore(graph, backend);
    expect(
      await verified.identity.areSame(
        { kind: "Person", id: "alice" },
        { kind: "Author", id: "alice" },
      ),
    ).toBe(true);
  });

  it("rejects contradictory existing groups before committing enablement", async () => {
    const backend = createTestBackend();
    const [disabledStore] = await createStoreWithSchema(
      disabledMigrationGraph,
      backend,
    );
    await disabledStore.nodes.Person.create({ name: "Alice" }, { id: "alice" });
    await disabledStore.nodes.Author.create({ penName: "A." }, { id: "alice" });
    const contradictory = defineGraph({
      id: graph.id,
      nodes: graph.nodes,
      edges: graph.edges,
      ontology: [disjointWith(Person, Author)],
      identity: { sameIdAcrossKinds: "fold" },
    });

    await expect(
      createStoreWithSchema(contradictory, backend),
    ).rejects.toMatchObject({
      name: "ConfigurationError",
      details: expect.objectContaining({
        code: "IDENTITY_SCHEMA_CONTRADICTION",
      }),
    });
    const activeSchema = await backend.getActiveSchema(graph.id);
    expect(activeSchema?.version).toBe(1);
  });

  it("cascades extension-kind identity truth during removeKinds", async () => {
    const extensionGraph = defineGraph({
      id: "identity_remove_kind",
      nodes: { Person: { type: Person } },
      edges: {},
      identity: { sameIdAcrossKinds: "fold" },
    });
    const [store] = await createStoreWithSchema(
      extensionGraph,
      createTestBackend(),
      { history: true },
    );
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
    );
    const person = await evolved.nodes.Person.create({ name: "Alice" });
    const tag = await evolved.getNodeCollectionOrThrow("Tag").create({
      label: "author",
    });
    await evolved.identity.assertSame(person, tag as never);
    const beforeRemoval = await evolved.recordedNow();
    expect(beforeRemoval).toBeDefined();

    const removed = await evolved.removeKinds(["Tag"]);
    const afterRemoval = await removed.recordedNow();
    expect(afterRemoval).toBeDefined();

    expect(await removed.identity.assertionsOf(person)).toEqual([]);
    expect(await removed.identity.membersOf(person)).toEqual([
      { kind: "Person", id: person.id },
    ]);
    expect(
      await removed.asOfRecorded(beforeRemoval!).identity.assertionsOf(person),
    ).toHaveLength(1);
    expect(
      await removed.asOfRecorded(afterRemoval!).identity.assertionsOf(person),
    ).toEqual([]);
  });

  it("rejects ontology evolution that contradicts an existing identity class", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend);
    const person = await store.nodes.Person.create({ name: "Alice" });
    const author = await store.nodes.Author.create({ penName: "A." });
    await store.identity.assertSame(person, author);

    await expect(
      store.evolve(
        defineGraphExtension({
          ontology: [
            { metaEdge: "disjointWith", from: "Person", to: "Author" },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      name: "ConfigurationError",
      details: expect.objectContaining({
        code: "IDENTITY_SCHEMA_CONTRADICTION",
      }),
    });
    const activeSchema = await backend.getActiveSchema(graph.id);
    expect(activeSchema?.version).toBe(1);
  });

  it("folds same ids, supports explicit assertions, and splits on retraction", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    const person = await store.nodes.Person.create(
      { name: "Alice" },
      { id: "alice" },
    );
    const author = await store.nodes.Author.create(
      { penName: "A." },
      { id: "alice" },
    );
    const other = await store.nodes.Person.create(
      { name: "Alicia" },
      { id: "other" },
    );

    expect(await store.identity.membersOf(person)).toEqual([
      { kind: "Author", id: "alice" },
      { kind: "Person", id: "alice" },
    ]);
    const assertion = await store.identity.assertSame(author, other);
    expect(await store.identity.areSame(person, other)).toBe(true);

    await store.identity.retractAssertion(assertion.id);
    expect(await store.identity.areSame(person, other)).toBe(false);
    expect(await store.identity.membersOf(other)).toEqual([
      { kind: "Person", id: "other" },
    ]);
  });

  it("pins singleton, missing, invisible, and self-assertion behavior", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    const person = await store.nodes.Person.create({ name: "Alice" });
    const missing = { kind: "Person", id: "missing" } as const;

    expect(await store.identity.membersOf(person)).toEqual([
      { kind: "Person", id: person.id },
    ]);
    expect(await store.identity.representativeOf(person)).toEqual({
      kind: "Person",
      id: person.id,
    });
    expect(await store.identity.areSame(person, person)).toBe(true);
    expect(await store.identity.areDifferent(person, person)).toBe(false);
    expect(await store.identity.membersOf(missing)).toEqual([]);
    expect(await store.identity.representativeOf(missing)).toBeUndefined();
    expect(await store.identity.areSame(person, missing)).toBe(false);
    expect(await store.identity.areDifferent(person, missing)).toBe(false);
    await expect(
      store.identity.assertSame(person, person),
    ).rejects.toMatchObject({
      name: "ValidationError",
      details: expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "IDENTITY_SELF_ASSERTION" }),
        ]),
      }),
    });
  });

  it("rejects contradictions and detaches identity on node deletion", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    const person = await store.nodes.Person.create(
      { name: "Alice" },
      { id: "alice" },
    );
    const company = await store.nodes.Company.create(
      { name: "Acme" },
      { id: "acme" },
    );

    await expect(
      store.identity.assertSame(person, company),
    ).rejects.toBeInstanceOf(IdentityContradictionError);
    const different = await store.identity.assertDifferent(person, company);
    expect(await store.identity.areDifferent(person, company)).toBe(true);

    await store.nodes.Person.delete(person.id);
    expect(await store.identity.representativeOf(person)).toBeUndefined();
    expect(await store.identity.assertionsOf(company)).toEqual([]);
    await expect(
      store.identity.retractAssertion(different.id),
    ).resolves.toBeUndefined();
  });

  it("reconstructs explicit and folded membership at an as-of coordinate", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    const person = await store.nodes.Person.create(
      { name: "Alice" },
      { id: "alice" },
    );
    const author = await store.nodes.Author.create(
      { penName: "A." },
      { id: "alice" },
    );
    const other = await store.nodes.Person.create(
      { name: "Alicia" },
      { id: "other" },
    );
    const assertion = await store.identity.assertSame(author, other);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const beforeRetraction = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 2));
    await store.identity.retractAssertion(assertion.id);

    expect(
      await store.asOf(beforeRetraction).identity.membersOf(person),
    ).toEqual([
      { kind: "Author", id: "alice" },
      { kind: "Person", id: "alice" },
      { kind: "Person", id: "other" },
    ]);
    expect(await store.identity.areSame(person, other)).toBe(false);
  });

  it("conducts historical identity through a soft-deleted invisible bridge", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    const first = await store.nodes.Person.create(
      { name: "First" },
      { id: "a-first" },
    );
    const bridge = await store.nodes.Person.create(
      { name: "Bridge" },
      { id: "bridge" },
    );
    const far = await store.nodes.Person.create(
      { name: "Far" },
      { id: "z-far" },
    );
    await store.identity.assertSame(first, bridge);
    await store.identity.assertSame(bridge, far);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const beforeDelete = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 2));
    await store.nodes.Person.delete(bridge.id);

    expect(await store.asOf(beforeDelete).identity.membersOf(first)).toEqual([
      { kind: "Person", id: first.id },
      { kind: "Person", id: far.id },
    ]);
  });

  it("round-trips state verbatim into an empty target and preserves target truth on reimport", async () => {
    const source = await createInitializedStore(graph, createTestBackend());
    const sourcePerson = await source.nodes.Person.create(
      { name: "Alice" },
      { id: "alice" },
    );
    const sourceAuthor = await source.nodes.Author.create(
      { penName: "A." },
      { id: "author" },
    );
    const sourceAssertion = await source.identity.assertSame(
      sourcePerson,
      sourceAuthor,
    );
    const state = await exportGraph(source, { includeTemporal: true });

    const target = await createInitializedStore(graph, createTestBackend());
    const first = await importGraph(target, state, { onConflict: "skip" });
    expect(first.identity).toEqual({ created: 1, skipped: 0 });
    expect(await target.identity.assertionsOf(sourcePerson)).toEqual([
      sourceAssertion,
    ]);

    const second = await importGraph(target, state, { onConflict: "skip" });
    expect(second.identity).toEqual({ created: 0, skipped: 1 });
    expect(await target.identity.assertionsOf(sourcePerson)).toEqual([
      sourceAssertion,
    ]);
  });

  it("advances revision exactly once for a state import with identity", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const source = await createInitializedStore(graph, createTestBackend());
      const person = await source.nodes.Person.create(
        { name: "Alice" },
        { id: "import-person" },
      );
      const author = await source.nodes.Author.create(
        { penName: "A." },
        { id: "import-author" },
      );
      await source.identity.assertSame(person, author);
      const state = await exportGraph(source, { includeTemporal: true });

      const [target] = await createStoreWithSchema(graph, createTestBackend(), {
        revisionTracking: true,
      });
      await target.nodes.Person.create(
        { name: "Existing" },
        { id: "existing" },
      );
      const before = await target.revisionNow();
      expect(before).toBeDefined();

      await importGraph(target, state, { onConflict: "skip" });

      const after = await target.revisionNow();
      expect(Date.parse(after!) - Date.parse(before!)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("exports and restores ended assertions only in archival mode", async () => {
    const source = await createInitializedStore(graph, createTestBackend());
    const person = await source.nodes.Person.create(
      { name: "Alice" },
      { id: "alice" },
    );
    const author = await source.nodes.Author.create(
      { penName: "A." },
      { id: "author" },
    );
    const assertion = await source.identity.assertSame(person, author);
    await source.identity.retractAssertion(assertion.id);

    const state = await exportGraph(source);
    const archive = await exportGraph(source, { identityMode: "archival" });
    expect(state.identity?.assertions).toEqual([]);
    expect(archive.identity?.assertions).toHaveLength(1);

    const target = await createInitializedStore(graph, createTestBackend());
    const result = await importGraph(target, archive, { onConflict: "skip" });
    expect(result.identity).toEqual({ created: 1, skipped: 0 });
    const restoredArchive = await exportGraph(target, {
      identityMode: "archival",
    });
    expect(restoredArchive.identity).toEqual(archive.identity);
  });

  it("expands one traversal through visible identity members without duplicating physical edges", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    const person = await store.nodes.Person.create(
      { name: "Alice" },
      { id: "alice" },
    );
    const author = await store.nodes.Author.create(
      { penName: "A." },
      { id: "author" },
    );
    const friend = await store.nodes.Person.create(
      { name: "Bob" },
      { id: "bob" },
    );
    const assertion = await store.identity.assertSame(person, author);
    const physicalEdge = await store.edges.knows.create(
      author,
      friend,
      {},
      {
        id: "author-knows-bob",
      },
    );

    const ordinary = await store
      .query()
      .from("Person", "person")
      .whereNode("person", (node) => node.name.eq("Alice"))
      .traverse("knows", "edge", { expand: "none" })
      .to("Person", "friend")
      .select((context) => ({ edge: context.edge, friend: context.friend }))
      .execute();
    const expanded = await store
      .query()
      .from("Person", "person")
      .whereNode("person", (node) => node.name.eq("Alice"))
      .traverse("knows", "edge", {
        expand: "none",
        includeIdentityMembers: true,
      })
      .to("Person", "friend")
      .select((context) => ({ edge: context.edge, friend: context.friend }))
      .execute();

    expect(ordinary).toEqual([]);
    expect(expanded).toHaveLength(1);
    expect(expanded[0]?.edge.id).toBe(physicalEdge.id);
    expect(expanded[0]?.edge.fromId).toBe(author.id);
    expect(expanded[0]?.friend.id).toBe(friend.id);

    await new Promise((resolve) => setTimeout(resolve, 2));
    const beforeRetraction = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 2));
    await store.identity.retractAssertion(assertion.id);
    expect(
      await store
        .query()
        .from("Person", "person")
        .whereNode("person", (node) => node.name.eq("Alice"))
        .traverse("knows", "edge", {
          expand: "none",
          includeIdentityMembers: true,
        })
        .to("Person", "friend")
        .select((context) => context.friend.id)
        .execute(),
    ).toEqual([]);
    expect(
      await store
        .asOf(beforeRetraction)
        .query()
        .from("Person", "person")
        .whereNode("person", (node) => node.name.eq("Alice"))
        .traverse("knows", "edge", {
          expand: "none",
          includeIdentityMembers: true,
        })
        .to("Person", "friend")
        .select((context) => context.friend.id)
        .execute(),
    ).toEqual([friend.id]);
  });

  it("expands identity membership on recursive traversal hops", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    const person = await store.nodes.Person.create(
      { name: "Alice" },
      { id: "alice" },
    );
    const author = await store.nodes.Author.create(
      { penName: "A." },
      { id: "author" },
    );
    const bob = await store.nodes.Person.create({ name: "Bob" }, { id: "bob" });
    const carol = await store.nodes.Person.create(
      { name: "Carol" },
      { id: "carol" },
    );
    await store.identity.assertSame(person, author);
    await store.edges.knows.create(author, bob, {}, { id: "author-bob" });
    await store.edges.knows.create(bob, carol, {}, { id: "bob-carol" });

    const results = await store
      .query()
      .from("Person", "person")
      .whereNode("person", (node) => node.name.eq("Alice"))
      .traverse("knows", "edge", {
        expand: "none",
        includeIdentityMembers: true,
      })
      .recursive()
      .to("Person", "friend")
      .select((context) => context.friend.id)
      .execute();

    expect(results).toContain(bob.id);
    expect(results).toContain(carol.id);
  });
});
