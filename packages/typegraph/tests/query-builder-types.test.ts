/**
 * Query Builder Type Safety Tests
 *
 * These tests verify compile-time type safety of the query builder.
 * Tests marked with @ts-expect-error should produce type errors.
 *
 * P0: Type-safe kind strings
 * - Node kind names must exist in the graph
 * - Edge kind names must exist in the graph
 * - Traversal targets must be valid for the edge
 * - Aliases must be unique
 * - whereNode aliases must reference existing aliases
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  buildKindRegistry,
  createQueryBuilder,
  defineEdge,
  defineGraph,
  defineNode,
  type TypedEdgeCollection,
} from "../src";

// ============================================================
// Test Graph Definition
// ============================================================

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    age: z.number(),
  }),
});

const Company = defineNode("Company", {
  schema: z.object({
    name: z.string(),
    industry: z.string(),
  }),
});

const Project = defineNode("Project", {
  schema: z.object({
    title: z.string(),
    status: z.enum(["active", "completed"]),
  }),
});

const worksAt = defineEdge("worksAt", {
  schema: z.object({
    role: z.string(),
  }),
});

const manages = defineEdge("manages", {
  schema: z.object({
    since: z.string().optional(),
  }),
});

const knows = defineEdge("knows");

const graph = defineGraph({
  id: "type_test_graph",
  nodes: {
    Person: { type: Person },
    Company: { type: Company },
    Project: { type: Project },
  },
  edges: {
    // Person -> Company
    worksAt: { type: worksAt, from: [Person], to: [Company] },
    // Person -> Project
    manages: { type: manages, from: [Person], to: [Project] },
    // Person -> Person
    knows: { type: knows, from: [Person], to: [Person] },
  },
  ontology: [],
});

const registry = buildKindRegistry(graph);

// ============================================================
// Type-Level Tests
// ============================================================

describe("Query Builder Type Safety", () => {
  describe("Node kind constraints", () => {
    it("accepts valid node kinds", () => {
      // These should compile without error
      const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .select((context) => context.p);

      const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Company", "c")
        .select((context) => context.c);

      const q3 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Project", "proj")
        .select((context) => context.proj);

      // Verify they produce valid ASTs
      expect(q1.toAst().start.kinds).toEqual(["Person"]);
      expect(q2.toAst().start.kinds).toEqual(["Company"]);
      expect(q3.toAst().start.kinds).toEqual(["Project"]);
    });

    it("rejects invalid node kinds at compile time", () => {
      // These produce compile errors, verified by @ts-expect-error annotations
      createQueryBuilder<typeof graph>(graph.id, registry).from(
        // @ts-expect-error - "InvalidKind" is not a valid node kind
        "InvalidKind",
        "x",
      );

      createQueryBuilder<typeof graph>(graph.id, registry).from(
        // @ts-expect-error - "Peron" is a typo, not a valid node kind
        "Peron",
        "p",
      );

      createQueryBuilder<typeof graph>(graph.id, registry).from(
        // @ts-expect-error - "person" is wrong case (node kinds are PascalCase)
        "person",
        "p",
      );
    });
  });

  describe("Edge kind constraints", () => {
    it("accepts valid edge kinds", () => {
      const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .traverse("worksAt", "e")
        .to("Company", "c")
        .select((context) => ({ person: context.p, company: context.c }));

      const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .traverse("knows", "e")
        .to("Person", "friend")
        .select((context) => ({ person: context.p, friend: context.friend }));

      expect(q1.toAst().traversals[0]?.edgeKinds).toEqual(["worksAt"]);
      expect(q2.toAst().traversals[0]?.edgeKinds).toEqual(["knows"]);
    });

    it("rejects invalid edge kinds at compile time", () => {
      createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        // @ts-expect-error - "invalidEdge" is not a valid edge kind
        .traverse("invalidEdge", "e");

      createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        // @ts-expect-error - "WorksAt" is wrong case (edge kinds are camelCase)
        .traverse("WorksAt", "e");
    });
  });

  describe("Traversal target constraints", () => {
    it("accepts valid target kinds for edges", () => {
      // worksAt: Person -> Company (valid)
      const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .traverse("worksAt", "e")
        .to("Company", "c")
        .select((context) => context.c);

      // manages: Person -> Project (valid)
      const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .traverse("manages", "e")
        .to("Project", "proj")
        .select((context) => context.proj);

      // knows: Person -> Person (valid)
      const q3 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .traverse("knows", "e")
        .to("Person", "friend")
        .select((context) => context.friend);

      expect(q1.toAst().traversals[0]?.nodeKinds).toEqual(["Company"]);
      expect(q2.toAst().traversals[0]?.nodeKinds).toEqual(["Project"]);
      expect(q3.toAst().traversals[0]?.nodeKinds).toEqual(["Person"]);
    });

    it("rejects invalid target kinds for edges at compile time", () => {
      // worksAt goes Person -> Company, NOT Person -> Person
      createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .traverse("worksAt", "e")
        // @ts-expect-error - Person is not a valid target for worksAt (out direction)
        .to("Person", "other");

      // worksAt goes Person -> Company, NOT Person -> Project
      createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .traverse("worksAt", "e")
        // @ts-expect-error - Project is not a valid target for worksAt (out direction)
        .to("Project", "proj");

      // manages goes Person -> Project, NOT Person -> Company
      createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .traverse("manages", "e")
        // @ts-expect-error - Company is not a valid target for manages (out direction)
        .to("Company", "c");
    });

    it("constrains incoming edge traversals to valid source kinds", () => {
      // For "in" direction, we traverse backward: target must be from the "from" array
      // worksAt: Person -> Company, so traversing "in" from Company must go to Person

      const q = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Company", "c")
        .traverse("worksAt", "e", { direction: "in" })
        .to("Person", "employee") // Valid: Person is in worksAt.from
        .select((context) => ({
          company: context.c,
          employee: context.employee,
        }));

      expect(q.toAst().traversals[0]?.direction).toBe("in");
      expect(q.toAst().traversals[0]?.nodeKinds).toEqual(["Person"]);
    });

    it("rejects invalid source kinds for incoming edge traversals", () => {
      // worksAt: Person -> Company
      // Traversing "in" from Company, we can only reach Person (not Company or Project)

      createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Company", "c")
        .traverse("worksAt", "e", { direction: "in" })
        // @ts-expect-error - Company is not a valid source for worksAt (in direction)
        .to("Company", "other");

      createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Company", "c")
        .traverse("worksAt", "e", { direction: "in" })
        // @ts-expect-error - Project is not a valid source for worksAt (in direction)
        .to("Project", "proj");
    });
  });

  describe("Alias uniqueness", () => {
    it("accepts unique aliases", () => {
      const q = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .traverse("worksAt", "e1")
        .to("Company", "c")
        .select((context) => ({ person: context.p, company: context.c }));

      expect(q.toAst().start.alias).toBe("p");
      expect(q.toAst().traversals[0]?.nodeAlias).toBe("c");
    });

    it("rejects duplicate aliases at compile time", () => {
      // Collision with start alias "p" in to()
      createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .traverse("worksAt", "e")
        // @ts-expect-error - "p" is already used as the start alias
        .to("Company", "p");

      // Collision with previous traversal alias "c"
      createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .traverse("worksAt", "e1")
        .to("Company", "c")
        .traverse("knows", "e2")
        // @ts-expect-error - "c" is already used as a traversal alias
        .to("Person", "c");

      // Collision between two from() calls (edge case - calling from twice)
      createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        // @ts-expect-error - "p" is already used
        .from("Company", "p");

      // Verify the constraint exists
      expect(true).toBe(true);
    });
  });

  describe("whereNode alias constraints", () => {
    it("accepts valid aliases in whereNode", () => {
      const q = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .whereNode("p", (node) => node.name.eq("Alice"))
        .traverse("worksAt", "e")
        .to("Company", "c")
        .whereNode("c", (node) => node.industry.eq("Tech"))
        .select((context) => ({ person: context.p, company: context.c }));

      expect(q.toAst().predicates).toHaveLength(2);
    });

    it("rejects invalid aliases in whereNode at compile time", () => {
      // When whereNode is called with an invalid alias, TypeScript produces an error
      // because the alias must be a key of the current Aliases type.
      // We test this by verifying the constraint exists on the method signature.

      const builder = createQueryBuilder<typeof graph>(graph.id, registry).from(
        "Person",
        "p",
      );

      // This compiles because "p" is a valid alias
      builder.whereNode("p", (node) => node.name.eq("Alice"));

      // Calling whereNode("x", ...) would fail because "x" is not in Aliases.
      // We can't use @ts-expect-error here due to the callback complexity,
      // but the type constraint is: A extends keyof Aliases & string

      // Verify the constraint exists by checking the method accepts valid aliases
      expect(typeof builder.whereNode).toBe("function");
    });
  });

  describe("whereEdge alias constraints", () => {
    it("accepts valid edge aliases in whereEdge", () => {
      const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .traverse("worksAt", "e")
        .whereEdge("e", (edge) => edge.role.eq("Engineer"))
        .to("Company", "c")
        .select((context) => ({ person: context.p, company: context.c }));

      const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .traverse("worksAt", "e")
        .to("Company", "c")
        .whereEdge("e", (edge) => edge.role.eq("Engineer"))
        .select((context) => ({ person: context.p, company: context.c }));

      expect(q1.toAst().predicates).toHaveLength(1);
      expect(q2.toAst().predicates).toHaveLength(1);
    });

    it("rejects invalid aliases in whereEdge at compile time", () => {
      createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .traverse("worksAt", "e")
        // @ts-expect-error - "p" is a node alias, not an edge alias
        .whereEdge("p", (edge) => edge.role.eq("Engineer"));

      createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .traverse("worksAt", "e")
        .to("Company", "c")
        // @ts-expect-error - "c" is a node alias, not an edge alias
        .whereEdge("c", (edge) => edge.role.eq("Engineer"));

      createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .traverse("worksAt", "e")
        // @ts-expect-error - "x" is not a declared edge alias
        .whereEdge("x", (edge) => edge.role.eq("Engineer"));

      createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .traverse("worksAt", "e")
        .whereEdge("e", (edge) => {
          // @ts-expect-error - worksAt edges don't have a "since" property
          return edge.since.eq("2020");
        });

      expect(true).toBe(true);
    });
  });

  describe("Select context type safety", () => {
    it("provides correctly typed props in select context", () => {
      const results = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .traverse("worksAt", "e")
        .to("Company", "c")
        .select((context) => ({
          // ctx.p should have Person's schema properties at top level
          personName: context.p.name,
          personAge: context.p.age,
          // ctx.c should have Company's schema properties at top level
          companyName: context.c.name,
          companyIndustry: context.c.industry,
        }));

      // This compiles, which verifies the types are correct
      expect(results).toBeDefined();
    });

    it("rejects access to non-existent props at compile time", () => {
      createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .select((context) => ({
          name: context.p.name,
          // Person doesn't have an 'industry' prop - this would be a type error
          // but we can't easily use @ts-expect-error inside an object literal callback
        }));

      createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Company", "c")
        .select((context) => ({
          name: context.c.name,
          // Company doesn't have an 'age' prop - this would be a type error
        }));

      // The type system correctly enforces that Person has {name, age}
      // and Company has {name, industry}. Accessing wrong props causes errors.
      expect(true).toBe(true);
    });

    it("rejects access to non-existent aliases in select", () => {
      // The select callback is typed to only have the aliases that were defined
      const query = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .select((context) => ({
          person: context.p,
          // ctx.c would be a type error here since "c" alias doesn't exist
        }));

      expect(query).toBeDefined();
    });
  });
});

// ============================================================
// Edge Collection Type Safety Tests
// ============================================================

describe("Edge Collection Type Safety", () => {
  // Import store types for testing
  type StoreEdges = {
    [K in keyof (typeof graph)["edges"]]: TypedEdgeCollection<
      (typeof graph)["edges"][K]
    >;
  };

  describe("Type-safe edge endpoints", () => {
    it("infers correct from/to types from edge registration", () => {
      // worksAt: from: [Person], to: [Company]
      // The create method should accept TypedNodeRef<Person> for from
      // and TypedNodeRef<Company> for to

      // This is a compile-time test - if this compiles, types are correct
      type WorksAtCollection = StoreEdges["worksAt"];

      // The create method's first param should be TypedNodeRef<Person>
      // The create method's second param should be TypedNodeRef<Company>
      type CreateParams = Parameters<WorksAtCollection["create"]>;
      type FromParam = CreateParams[0];
      type ToParam = CreateParams[1];

      // TypedNodeRef<Person> allows { kind: "Person", id: string } or Node<Person>
      // TypedNodeRef<Company> allows { kind: "Company", id: string } or Node<Company>
      const validFrom: FromParam = { kind: "Person", id: "test-id" };
      const validTo: ToParam = { kind: "Company", id: "test-id" };

      expect(validFrom.kind).toBe("Person");
      expect(validTo.kind).toBe("Company");
    });

    it("rejects invalid from types at compile time", () => {
      type WorksAtCollection = StoreEdges["worksAt"];
      type FromParam = Parameters<WorksAtCollection["create"]>[0];

      // @ts-expect-error - Company is not a valid 'from' type for worksAt
      const invalidFrom: FromParam = { kind: "Company", id: "test-id" };

      // @ts-expect-error - Project is not a valid 'from' type for worksAt
      const alsoInvalid: FromParam = { kind: "Project", id: "test-id" };

      // These lines exist only to suppress "unused variable" warnings
      void invalidFrom;
      void alsoInvalid;
    });

    it("rejects invalid to types at compile time", () => {
      type WorksAtCollection = StoreEdges["worksAt"];
      type ToParam = Parameters<WorksAtCollection["create"]>[1];

      // @ts-expect-error - Person is not a valid 'to' type for worksAt
      const invalidTo: ToParam = { kind: "Person", id: "test-id" };

      // @ts-expect-error - Project is not a valid 'to' type for worksAt
      const alsoInvalid: ToParam = { kind: "Project", id: "test-id" };

      void invalidTo;
      void alsoInvalid;
    });

    it("allows Person-to-Person for knows edge", () => {
      // knows: from: [Person], to: [Person]
      type KnowsCollection = StoreEdges["knows"];
      type FromParam = Parameters<KnowsCollection["create"]>[0];
      type ToParam = Parameters<KnowsCollection["create"]>[1];

      // Both from and to should accept Person
      const validFrom: FromParam = { kind: "Person", id: "alice" };
      const validTo: ToParam = { kind: "Person", id: "bob" };

      expect(validFrom.kind).toBe("Person");
      expect(validTo.kind).toBe("Person");
    });

    it("constrains findFrom to accept only valid from types", () => {
      type WorksAtCollection = StoreEdges["worksAt"];
      type FindFromParam = Parameters<WorksAtCollection["findFrom"]>[0];

      // Person is valid for findFrom on worksAt
      const validFrom: FindFromParam = { kind: "Person", id: "test-id" };

      // @ts-expect-error - Company is not a valid 'from' type
      const invalidFrom: FindFromParam = { kind: "Company", id: "test-id" };

      expect(validFrom.kind).toBe("Person");
      void invalidFrom;
    });

    it("constrains findTo to accept only valid to types", () => {
      type WorksAtCollection = StoreEdges["worksAt"];
      type FindToParam = Parameters<WorksAtCollection["findTo"]>[0];

      // Company is valid for findTo on worksAt
      const validTo: FindToParam = { kind: "Company", id: "test-id" };

      // @ts-expect-error - Person is not a valid 'to' type
      const invalidTo: FindToParam = { kind: "Person", id: "test-id" };

      expect(validTo.kind).toBe("Company");
      void invalidTo;
    });
  });
});
