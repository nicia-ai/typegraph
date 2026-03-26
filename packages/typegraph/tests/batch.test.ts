/**
 * Tests for store.batch() — pipelined query execution.
 *
 * Verifies that multiple queries execute over a single connection
 * with typed tuple results, snapshot consistency, and correct
 * handling of projections, ordering, limits, and errors.
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
import type { GraphBackend } from "../src/backend/types";
import type { Node } from "../src/store/types";
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
    expect(people[0]!.name).toBe("Bob");

    expect(skills).toHaveLength(2);
    expect(skills[0]!.name).toBe("Rust");
    expect(skills[1]!.name).toBe("TypeScript");
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
    expect(bobCompany[0]!.company).toBe("Globex");
    expect(bobCompany[0]!.role).toBe("Manager");
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
    expect(youngPeople[0]!.name).toBe("Bob");

    expect(techCompanies).toHaveLength(1);
    expect(techCompanies[0]!.name).toBe("Acme");
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
    expect(page[0]!.name).toBe("Bob"); // Second person alphabetically
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
    expect(companies[0]!.kind).toBe("worksAt");
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
    expect(bobEdges[0]!.role).toBe("Manager");
    expect(allPeople).toHaveLength(2);
    expect(bobSkillEdges).toHaveLength(1);
  });

  it("batchFindFrom excludes soft-deleted edges", async () => {
    const aliceSkills = await store.edges.hasSkill.findFrom(alice);
    await store.edges.hasSkill.delete(aliceSkills[0]!.id);

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
    expect(aliceAtAcme[0]!.role).toBe("Engineer");

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
    expect(matchingRole[0]!.role).toBe("Engineer");
    expect(wrongRole).toHaveLength(0);
  });

  it("batchFindByEndpoints excludes soft-deleted edges", async () => {
    const aliceEdges = await store.edges.worksAt.findFrom(alice);
    await store.edges.worksAt.delete(aliceEdges[0]!.id);

    const [result] = await store.batch(
      store.edges.worksAt.batchFindByEndpoints(alice, acme),
      store.edges.worksAt.batchFindFrom(bob),
    );

    expect(result).toHaveLength(0);
  });
});
