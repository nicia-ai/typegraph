/**
 * Tests for store.batch() — several queries run in sequence against one
 * target. Not pipelined: at least one statement per query, and two when a
 * query's selective-field mapping falls back after its statement has run.
 *
 * Verifies typed tuple results and correct handling of projections,
 * ordering, limits, and errors.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  type Store,
} from "../src";
import { deriveBackend } from "../src/backend/derive-backend";
import type { GraphBackend } from "../src/backend/types";
import type { EmbeddableOneStatementRead } from "../src/query/builder/types";
import type { Node } from "../src/store/types";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend } from "./test-utils";

// ============================================================
// Test Schema
// ============================================================

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    age: z.number().int().optional(),
  }),
});

const Company = defineNode("Company", {
  schema: z.object({
    name: z.string(),
    industry: z.string().optional(),
  }),
});

const Skill = defineNode("Skill", {
  schema: z.object({
    name: z.string(),
    level: z.number().int().optional(),
  }),
});

const worksAt = defineEdge("worksAt", {
  schema: z.object({
    role: z.string(),
  }),
});

const hasSkill = defineEdge("hasSkill", {
  schema: z.object({}),
});

const graph = defineGraph({
  id: "batch_test",
  nodes: {
    Person: { type: Person },
    Company: { type: Company },
    Skill: { type: Skill },
  },
  edges: {
    worksAt: { type: worksAt, from: [Person], to: [Company] },
    hasSkill: { type: hasSkill, from: [Person], to: [Skill] },
  },
});

type TestGraph = typeof graph;

// ============================================================
// Tests
// ============================================================

describe("store.batch()", () => {
  let backend: GraphBackend;
  let store: Store<TestGraph>;
  let alice: Node<typeof Person>;
  let bob: Node<typeof Person>;
  let acme: Node<typeof Company>;
  let globex: Node<typeof Company>;
  let ts: Node<typeof Skill>;

  beforeEach(async () => {
    backend = createTestBackend();
    store = createStore(graph, backend);

    // Seed data
    alice = await store.nodes.Person.create({ name: "Alice", age: 30 });
    bob = await store.nodes.Person.create({ name: "Bob", age: 25 });
    acme = await store.nodes.Company.create({
      name: "Acme",
      industry: "Tech",
    });
    globex = await store.nodes.Company.create({
      name: "Globex",
      industry: "Manufacturing",
    });
    ts = await store.nodes.Skill.create({
      name: "TypeScript",
      level: 9,
    });
    const rust = await store.nodes.Skill.create({ name: "Rust", level: 7 });

    await store.edges.worksAt.create(alice, acme, { role: "Engineer" });
    await store.edges.worksAt.create(bob, globex, { role: "Manager" });
    await store.edges.hasSkill.create(alice, ts);
    await store.edges.hasSkill.create(alice, rust);
    await store.edges.hasSkill.create(bob, ts);
  });

  it("executes two queries and returns typed tuple", async () => {
    const [people, companies] = await store.batch(
      store
        .query()
        .from("Person", "p")
        .select((ctx) => ({ id: ctx.p.id, name: ctx.p.name })),
      store
        .query()
        .from("Company", "c")
        .select((ctx) => ({ id: ctx.c.id, name: ctx.c.name })),
    );

    expect(people).toHaveLength(2);
    expect(companies).toHaveLength(2);

    const personNames = people.map((person) => person.name).toSorted();
    expect(personNames).toEqual(["Alice", "Bob"]);

    const companyNames = companies.map((company) => company.name).toSorted();
    expect(companyNames).toEqual(["Acme", "Globex"]);
  });

  it("executes three queries with different projections", async () => {
    const [people, companies, skills] = await store.batch(
      store
        .query()
        .from("Person", "p")
        .select((ctx) => ({ name: ctx.p.name, age: ctx.p.age })),
      store
        .query()
        .from("Company", "c")
        .select((ctx) => ({ name: ctx.c.name, industry: ctx.c.industry })),
      store
        .query()
        .from("Skill", "s")
        .select((ctx) => ({ name: ctx.s.name, level: ctx.s.level })),
    );

    expect(people).toHaveLength(2);
    expect(companies).toHaveLength(2);
    expect(skills).toHaveLength(2);

    const alice = people.find((person) => person.name === "Alice");
    expect(alice?.age).toBe(30);

    const acme = companies.find((company) => company.name === "Acme");
    expect(acme?.industry).toBe("Tech");

    const ts = skills.find((skill) => skill.name === "TypeScript");
    expect(ts?.level).toBe(9);
  });

  it("respects per-query ordering and limits", async () => {
    const [people, skills] = await store.batch(
      store
        .query()
        .from("Person", "p")
        .select((ctx) => ({ name: ctx.p.name }))
        .orderBy("p", "name", "desc")
        .limit(1),
      store
        .query()
        .from("Skill", "s")
        .select((ctx) => ({ name: ctx.s.name }))
        .orderBy("s", "name", "asc"),
    );

    expect(people).toHaveLength(1);
    expect(requireDefined(people[0]).name).toBe("Bob");

    expect(skills).toHaveLength(2);
    expect(requireDefined(skills[0]).name).toBe("Rust");
    expect(requireDefined(skills[1]).name).toBe("TypeScript");
  });

  it("handles queries with traversals", async () => {
    const [aliceSkills, bobCompany] = await store.batch(
      store
        .query()
        .from("Person", "p")
        .whereNode("p", (person) => person.name.eq("Alice"))
        .traverse("hasSkill", "e")
        .to("Skill", "s")
        .select((ctx) => ({ skill: ctx.s.name })),
      store
        .query()
        .from("Person", "p")
        .whereNode("p", (person) => person.name.eq("Bob"))
        .traverse("worksAt", "e")
        .to("Company", "c")
        .select((ctx) => ({ company: ctx.c.name, role: ctx.e.role })),
    );

    expect(aliceSkills).toHaveLength(2);
    const skillNames = aliceSkills.map((row) => row.skill).toSorted();
    expect(skillNames).toEqual(["Rust", "TypeScript"]);

    expect(bobCompany).toHaveLength(1);
    expect(requireDefined(bobCompany[0]).company).toBe("Globex");
    expect(requireDefined(bobCompany[0]).role).toBe("Manager");
  });

  it("handles empty result sets", async () => {
    const [noMatch, allPeople] = await store.batch(
      store
        .query()
        .from("Person", "p")
        .whereNode("p", (person) => person.name.eq("Nobody"))
        .select((ctx) => ({ name: ctx.p.name })),
      store
        .query()
        .from("Person", "p")
        .select((ctx) => ({ name: ctx.p.name })),
    );

    expect(noMatch).toHaveLength(0);
    expect(allPeople).toHaveLength(2);
  });

  it("preserves result order matching input query order", async () => {
    const [companies, people] = await store.batch(
      store
        .query()
        .from("Company", "c")
        .select((ctx) => ({ name: ctx.c.name })),
      store
        .query()
        .from("Person", "p")
        .select((ctx) => ({ name: ctx.p.name })),
    );

    // First result is companies, second is people
    const companyNames = companies.map((company) => company.name).toSorted();
    expect(companyNames).toEqual(["Acme", "Globex"]);

    const personNames = people.map((person) => person.name).toSorted();
    expect(personNames).toEqual(["Alice", "Bob"]);
  });

  it("works with full node projections", async () => {
    const [people, companies] = await store.batch(
      store
        .query()
        .from("Person", "p")
        .select((ctx) => ctx.p),
      store
        .query()
        .from("Company", "c")
        .select((ctx) => ctx.c),
    );

    expect(people).toHaveLength(2);
    expect(companies).toHaveLength(2);

    // Full node includes kind, id, meta, and props
    for (const person of people) {
      expect(person.kind).toBe("Person");
      expect(person.id).toBeDefined();
      expect(person.name).toBeDefined();
      expect(person.meta.createdAt).toBeDefined();
    }
  });

  it("handles per-query filtering with different predicates", async () => {
    const [youngPeople, techCompanies] = await store.batch(
      store
        .query()
        .from("Person", "p")
        .whereNode("p", (person) => person.age.lt(30))
        .select((ctx) => ({ name: ctx.p.name })),
      store
        .query()
        .from("Company", "c")
        .whereNode("c", (company) => company.industry.eq("Tech"))
        .select((ctx) => ({ name: ctx.c.name })),
    );

    expect(youngPeople).toHaveLength(1);
    expect(requireDefined(youngPeople[0]).name).toBe("Bob");

    expect(techCompanies).toHaveLength(1);
    expect(requireDefined(techCompanies[0]).name).toBe("Acme");
  });

  it("handles offset in addition to limit", async () => {
    const [page] = await store.batch(
      store
        .query()
        .from("Person", "p")
        .select((ctx) => ({ name: ctx.p.name }))
        .orderBy("p", "name", "asc")
        .limit(1)
        .offset(1),
      store
        .query()
        .from("Skill", "s")
        .select((ctx) => ({ name: ctx.s.name })),
    );

    expect(page).toHaveLength(1);
    expect(requireDefined(page[0]).name).toBe("Bob"); // Second person alphabetically
  });

  // ============================================================
  // Edge collection batchFind*
  // ============================================================

  it("batches edge batchFindFrom with fluent queries", async () => {
    const [skills, companies] = await store.batch(
      store.edges.hasSkill.batchFindFrom(alice),
      store.edges.worksAt.batchFindFrom(alice),
    );

    expect(skills).toHaveLength(2);
    expect(companies).toHaveLength(1);
    expect(requireDefined(companies[0]).kind).toBe("worksAt");
  });

  it("batches edge batchFindTo lookups", async () => {
    const [hasSkillEdges] = await store.batch(
      store.edges.hasSkill.batchFindTo(ts),
      store
        .query()
        .from("Skill", "s")
        .select((ctx) => ({ name: ctx.s.name })),
    );

    // Alice and Bob both have TypeScript
    expect(hasSkillEdges).toHaveLength(2);
  });

  it("batchFind returns empty array when no edges match", async () => {
    const [toAcme, toGlobex] = await store.batch(
      store.edges.worksAt.batchFindTo(acme),
      store.edges.worksAt.batchFindTo(globex),
    );

    expect(toAcme).toHaveLength(1); // Alice works at Acme
    expect(toGlobex).toHaveLength(1); // Bob works at Globex

    // Create a company with no edges
    const orphan = await store.nodes.Company.create({ name: "Orphan" });
    const [noEdges] = await store.batch(
      store.edges.worksAt.batchFindTo(orphan),
      store.edges.worksAt.batchFindTo(acme),
    );

    expect(noEdges).toHaveLength(0);
  });

  it("mixes edge queries with fluent queries in a single batch", async () => {
    const [bobEdges, allPeople, bobSkillEdges] = await store.batch(
      store.edges.worksAt.batchFindFrom(bob),
      store
        .query()
        .from("Person", "p")
        .select((ctx) => ({ name: ctx.p.name })),
      store.edges.hasSkill.batchFindFrom(bob),
    );

    expect(bobEdges).toHaveLength(1);
    expect(requireDefined(bobEdges[0]).role).toBe("Manager");
    expect(allPeople).toHaveLength(2);
    expect(bobSkillEdges).toHaveLength(1);
  });

  it("batchFindFrom excludes soft-deleted edges", async () => {
    const aliceSkills = await store.edges.hasSkill.findFrom(alice);
    await store.edges.hasSkill.delete(requireDefined(aliceSkills[0]).id);

    const [remaining] = await store.batch(
      store.edges.hasSkill.batchFindFrom(alice),
      store
        .query()
        .from("Skill", "s")
        .select((ctx) => ({ name: ctx.s.name })),
    );

    expect(remaining).toHaveLength(1);
  });

  it("batches batchFindByEndpoints lookups", async () => {
    const [aliceAtAcme, bobAtAcme] = await store.batch(
      store.edges.worksAt.batchFindByEndpoints(alice, acme),
      store.edges.worksAt.batchFindByEndpoints(bob, acme),
    );

    // Alice works at Acme — 1 result
    expect(aliceAtAcme).toHaveLength(1);
    expect(requireDefined(aliceAtAcme[0]).role).toBe("Engineer");

    // Bob does not work at Acme — 0 results
    expect(bobAtAcme).toHaveLength(0);
  });

  it("batchFindByEndpoints passes matchOn and props options", async () => {
    const [matchingRole, wrongRole] = await store.batch(
      store.edges.worksAt.batchFindByEndpoints(alice, acme, {
        matchOn: ["role"],
        props: { role: "Engineer" },
      }),
      store.edges.worksAt.batchFindByEndpoints(alice, acme, {
        matchOn: ["role"],
        props: { role: "CEO" },
      }),
    );

    expect(matchingRole).toHaveLength(1);
    expect(requireDefined(matchingRole[0]).role).toBe("Engineer");
    expect(wrongRole).toHaveLength(0);
  });

  it("batchFindByEndpoints excludes soft-deleted edges", async () => {
    const aliceEdges = await store.edges.worksAt.findFrom(alice);
    await store.edges.worksAt.delete(requireDefined(aliceEdges[0]).id);

    const [result] = await store.batch(
      store.edges.worksAt.batchFindByEndpoints(alice, acme),
      store.edges.worksAt.batchFindFrom(bob),
    );

    expect(result).toHaveLength(0);
  });
});

describe("store.batchOnce()", () => {
  it("refuses invalid sharing options even for an empty batch", async () => {
    const store = createStore(graph, createTestBackend());
    await expect(
      store.batchOnce(() => [], { shareSubgraphs: "yes" as never }),
    ).rejects.toThrow("shareSubgraphs must be a boolean");
  });

  it("accepts empty, singleton, and runtime-sized readonly inputs", async () => {
    const starts: string[] = [];
    const store = createStore(graph, createTestBackend(), {
      hooks: { onQueryStart: (ctx) => starts.push(ctx.sql) },
    });
    await store.nodes.Person.create({ name: "Alice" });
    starts.length = 0;

    await expect(store.batchOnce(() => [])).resolves.toEqual([]);
    expect(starts).toHaveLength(0);

    const [people] = await store.batchOnce(() => [
      store
        .query()
        .from("Person", "person")
        .select((ctx) => ctx.person.name),
    ]);
    const typedPeople: readonly string[] = people;
    expect(typedPeople).toEqual(["Alice"]);
    expect(starts).toHaveLength(1);

    starts.length = 0;
    const aliases = ["first", "second", "third"] as const;
    const runtimeReads = aliases.map((alias) =>
      store
        .query()
        .from("Person", alias)
        .select((ctx) => ctx[alias].name),
    );
    const results = await store.batchOnce(() => runtimeReads);
    const typedResults: readonly (readonly string[])[] = results;
    expect(typedResults).toEqual([["Alice"], ["Alice"], ["Alice"]]);
    expect(starts).toHaveLength(1);
  });

  it.each([false, true])(
    "refuses graph and execution-target rebinding before SQL (shareSubgraphs=%s)",
    async (shareSubgraphs) => {
      const starts: string[] = [];
      const backend = createTestBackend();
      const store = createStore(graph, backend, {
        hooks: { onQueryStart: (ctx) => starts.push(ctx.sql) },
      });
      const otherGraph = defineGraph({
        id: "other_batch_graph",
        nodes: graph.nodes,
        edges: graph.edges,
      });
      const otherGraphStore = createStore(otherGraph, backend);
      const otherTargetStore = createStore(graph, createTestBackend());

      const wrongGraphRead = otherGraphStore
        .query()
        .from("Person", "person")
        .select((ctx) => ctx.person.name);
      await expect(
        store.batchOnce(() => [wrongGraphRead], { shareSubgraphs }),
      ).rejects.toThrow("different graphs");

      const wrongTargetRead = otherTargetStore
        .query()
        .from("Person", "person")
        .select((ctx) => ctx.person.name);
      await expect(
        store.batchOnce(() => [wrongTargetRead], { shareSubgraphs }),
      ).rejects.toThrow("different database or transaction target");
      expect(starts).toHaveLength(0);
    },
  );

  it("refuses a set operation whose right operand has foreign provenance", () => {
    const backend = createTestBackend();
    const store = createStore(graph, backend);
    const otherGraph = defineGraph({
      id: "foreign_set_graph",
      nodes: graph.nodes,
      edges: graph.edges,
    });
    const otherGraphStore = createStore(otherGraph, backend);
    const otherTargetStore = createStore(graph, createTestBackend());
    const left = store
      .query()
      .from("Person", "person")
      .select((ctx) => ctx.person.name);

    expect(() =>
      left.union(
        otherGraphStore
          .query()
          .from("Person", "person")
          .select((ctx) => ctx.person.name) as never,
      ),
    ).toThrow("different graphs");
    expect(() =>
      left.union(
        otherTargetStore
          .query()
          .from("Person", "person")
          .select((ctx) => ctx.person.name),
      ),
    ).toThrow("different execution targets");
  });

  it("does not let a transaction-bound query escape into a Store batch", async () => {
    const store = createStore(graph, createTestBackend());
    let transactionRead:
      EmbeddableOneStatementRead<readonly string[]> | undefined;
    await store.transaction((tx) => {
      transactionRead = tx
        .query()
        .from("Person", "person")
        .select((ctx) => ctx.person.name);
      return Promise.resolve();
    });

    await expect(
      store.batchOnce(() => [requireDefined(transactionRead)]),
    ).rejects.toThrow("different database or transaction target");
  });

  it("refuses batches beyond the portable planning budget before compiling", async () => {
    const starts: string[] = [];
    const store = createStore(graph, createTestBackend(), {
      hooks: { onQueryStart: (ctx) => starts.push(ctx.sql) },
    });
    const read = store
      .query()
      .from("Person", "person")
      .select((ctx) => ctx.person.name);
    const reads = Array.from({ length: 501 }, () => read);

    await expect(store.batchOnce(() => reads)).rejects.toThrow(
      "at most 500 reads",
    );
    expect(starts).toHaveLength(0);
  });

  it("refuses an unsupported member before executing any member", async () => {
    const starts: string[] = [];
    const store = createStore(graph, createTestBackend(), {
      hooks: { onQueryStart: (ctx) => starts.push(ctx.sql) },
    });
    const supported = store
      .query()
      .from("Person", "person")
      .select((ctx) => ctx.person.name);
    const unsupported = {
      executeOn: () => Promise.resolve(["unreachable"]),
    };

    await expect(
      store.batchOnce(() => [supported, unsupported] as never),
    ).rejects.toThrow("cannot be embedded");
    expect(starts).toHaveLength(0);
  });

  it("refuses a combined statement beyond the backend bind budget", async () => {
    const starts: string[] = [];
    const backend = createTestBackend();
    const constrainedBackend = deriveBackend(backend, {
      capabilities: {
        ...backend.capabilities,
        maxBindParameters: 1,
      },
    });
    const store = createStore(graph, constrainedBackend, {
      hooks: { onQueryStart: (ctx) => starts.push(ctx.sql) },
    });

    await expect(
      store.batchOnce(() => [
        store
          .query()
          .from("Person", "person")
          .select((ctx) => ctx.person.id),
      ]),
    ).rejects.toThrow("bind-parameter budget");
    expect(starts).toHaveLength(0);
  });

  it("refuses a nonempty batch when the target lacks window functions", async () => {
    const starts: string[] = [];
    const backend = createTestBackend();
    const constrainedBackend = deriveBackend(backend, {
      capabilities: { ...backend.capabilities, windowFunctions: false },
    });
    const store = createStore(graph, constrainedBackend, {
      hooks: { onQueryStart: (ctx) => starts.push(ctx.sql) },
    });

    await expect(
      store.batchOnce(() => [
        store
          .query()
          .from("Person", "person")
          .select((ctx) => ctx.person.id),
      ]),
    ).rejects.toThrow("window-function support");
    expect(starts).toHaveLength(0);
  });

  it("returns independently typed results through exactly one statement", async () => {
    const starts: string[] = [];
    const backend = createTestBackend();
    const store = createStore(graph, backend, {
      hooks: {
        onQueryStart: (ctx) => {
          starts.push(ctx.sql);
        },
      },
    });
    await store.nodes.Person.create({ name: "Alice", age: 30 });
    await store.nodes.Person.create({ name: "Bob", age: 25 });
    await store.nodes.Company.create({ name: "Acme", industry: "Tech" });

    const [people, companies] = await store.batchOnce(() => [
      store
        .query()
        .from("Person", "p")
        .select((ctx) => ({ name: ctx.p.name, age: ctx.p.age }))
        .orderBy("p", "name", "desc"),
      store
        .query()
        .from("Company", "c")
        .select((ctx) => ctx.c),
    ]);

    expect(people).toEqual([
      { name: "Bob", age: 25 },
      { name: "Alice", age: 30 },
    ]);
    expect(companies).toHaveLength(1);
    expect(requireDefined(companies[0]).name).toBe("Acme");
    expect(starts).toHaveLength(1);
    expect(requireDefined(starts[0])).toContain(
      'ROW_NUMBER() OVER (ORDER BY "typegraph_batch_source_0"."typegraphbatchorder0" DESC NULLS FIRST)',
    );
    expect(requireDefined(starts[0])).not.toContain(
      '"typegraphbatchorder0" IS NULL',
    );
  });

  it("preserves each member's supported temporal coordinate", async () => {
    const store = createStore(graph, createTestBackend());
    await store.nodes.Person.create({ name: "Alice" });

    const [current, historical] = await store.batchOnce(() => [
      store
        .query()
        .from("Person", "currentPerson")
        .temporal("current")
        .select((ctx) => ctx.currentPerson.name),
      store
        .query()
        .from("Person", "historicalPerson")
        .temporal("asOf", new Date().toISOString())
        .select((ctx) => ctx.historicalPerson.name),
    ]);

    expect(current).toEqual(["Alice"]);
    expect(historical).toEqual(["Alice"]);
  });

  it("preserves empty and traversal result sets", async () => {
    const backend = createTestBackend();
    const store = createStore(graph, backend);
    const person = await store.nodes.Person.create({ name: "Alice" });
    const skill = await store.nodes.Skill.create({ name: "TypeScript" });
    await store.edges.hasSkill.create(person, skill);

    const [missing, skills] = await store.batchOnce(() => [
      store
        .query()
        .from("Company", "c")
        .whereNode("c", (company) => company.name.eq("Missing"))
        .select((ctx) => ctx.c.name),
      store
        .query()
        .from("Person", "p")
        .whereNode("p", (candidate) => candidate.id.eq(person.id))
        .traverse("hasSkill", "edge")
        .to("Skill", "skill")
        .select((ctx) => ({ name: ctx.skill.name })),
    ]);

    expect(missing).toEqual([]);
    expect(skills).toEqual([{ name: "TypeScript" }]);
  });

  it("returns projections wider than one SQLite JSON object call", async () => {
    const backend = createTestBackend();
    const store = createStore(graph, backend);
    await store.nodes.Person.create({ name: "Alice" });

    const [wideRows] = await store.batchOnce(() => [
      store
        .query()
        .from("Person", "person")
        .select((ctx) =>
          Object.fromEntries(
            Array.from({ length: 81 }, (_, index) => [
              `value${index}`,
              ctx.person.name,
            ]),
          ),
        ),
      store
        .query()
        .from("Company", "company")
        .select((ctx) => ctx.company.name),
    ]);

    expect(wideRows).toHaveLength(1);
    expect(wideRows[0]?.["value0"]).toBe("Alice");
    expect(wideRows[0]?.["value80"]).toBe("Alice");
  });
});
