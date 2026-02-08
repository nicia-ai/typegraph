import { beforeEach, describe, expect, it } from "vitest";

import { seedPeopleCompaniesForEdgePropertySelection } from "./seed-helpers";
import { type IntegrationTestContext } from "./test-context";

export function registerEdgePropertyIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Edge Property Selection and Filtering", () => {
    beforeEach(async () => {
      const store = context.getStore();
      await seedPeopleCompaniesForEdgePropertySelection(store);
    });

    it("selects edge properties in the select callback", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .traverse("worksAt", "e")
        .to("Company", "c")
        .select((ctx) => ({
          person: ctx.p.name,
          company: ctx.c.name,
          role: ctx.e.role,
          salary: ctx.e.salary,
        }))
        .execute();

      expect(results).toHaveLength(3);

      const alice = results.find((result) => result.person === "Alice");
      expect(alice?.company).toBe("Acme Corp");
      expect(alice?.role).toBe("Engineer");
      expect(alice?.salary).toBe(120_000);

      const bob = results.find((result) => result.person === "Bob");
      expect(bob?.company).toBe("Globex");
      expect(bob?.role).toBe("Analyst");
      expect(bob?.salary).toBe(80_000);
    });

    it("selects edge id and kind", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("worksAt", "e")
        .to("Company", "c")
        .select((ctx) => ({
          person: ctx.p.name,
          edgeId: ctx.e.id,
          edgeKind: ctx.e.kind,
        }))
        .execute();

      expect(results).toHaveLength(1);
      expect(results[0]?.edgeId).toBeDefined();
      expect(typeof results[0]?.edgeId).toBe("string");
      expect(results[0]?.edgeKind).toBe("worksAt");
    });

    it("selects edge fromId and toId", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("worksAt", "e")
        .to("Company", "c")
        .select((ctx) => ({
          personId: ctx.p.id,
          companyId: ctx.c.id,
          edgeFromId: ctx.e.fromId,
          edgeToId: ctx.e.toId,
        }))
        .execute();

      expect(results).toHaveLength(1);
      expect(results[0]?.edgeFromId).toBe(results[0]?.personId);
      expect(results[0]?.edgeToId).toBe(results[0]?.companyId);
    });

    it("selects edge metadata", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("worksAt", "e")
        .to("Company", "c")
        .select((ctx) => ({
          person: ctx.p.name,
          edgeCreatedAt: ctx.e.meta.createdAt,
          edgeUpdatedAt: ctx.e.meta.updatedAt,
          edgeValidFrom: ctx.e.meta.validFrom,
          edgeValidTo: ctx.e.meta.validTo,
          edgeDeletedAt: ctx.e.meta.deletedAt,
        }))
        .execute();

      expect(results).toHaveLength(1);
      expect(results[0]?.edgeCreatedAt).toBeDefined();
      expect(typeof results[0]?.edgeCreatedAt).toBe("string");
      expect(results[0]?.edgeUpdatedAt).toBeDefined();
      expect(results[0]?.edgeDeletedAt).toBeUndefined();
    });

    it("filters on edge properties using whereEdge", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .traverse("worksAt", "e")
        .whereEdge("e", (edge) => edge.salary.gte(100_000))
        .to("Company", "c")
        .select((ctx) => ({
          person: ctx.p.name,
          salary: ctx.e.salary,
        }))
        .execute();

      // Only Alice (120k) and Charlie (150k) have salary >= 100k
      expect(results).toHaveLength(2);
      expect(results.map((result) => result.person).toSorted()).toEqual([
        "Alice",
        "Charlie",
      ]);
    });

    it("filters on edge properties using QueryBuilder.whereEdge after to()", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .traverse("worksAt", "e")
        .to("Company", "c")
        .whereEdge("e", (edge) => edge.salary.gte(100_000))
        .select((ctx) => ({
          person: ctx.p.name,
          salary: ctx.e.salary,
        }))
        .execute();

      // Only Alice (120k) and Charlie (150k) have salary >= 100k
      expect(results).toHaveLength(2);
      expect(results.map((result) => result.person).toSorted()).toEqual([
        "Alice",
        "Charlie",
      ]);
    });

    it("filters on edge string property using whereEdge", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .traverse("worksAt", "e")
        .whereEdge("e", (edge) => edge.role.eq("Engineer"))
        .to("Company", "c")
        .select((ctx) => ({
          person: ctx.p.name,
          role: ctx.e.role,
        }))
        .execute();

      expect(results).toHaveLength(1);
      expect(results[0]?.person).toBe("Alice");
      expect(results[0]?.role).toBe("Engineer");
    });

    it("combines whereNode and whereEdge", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) =>
          p.name.startsWith("A").or(p.name.startsWith("C")),
        )
        .traverse("worksAt", "e")
        .whereEdge("e", (edge) => edge.salary.gt(100_000))
        .to("Company", "c")
        .select((ctx) => ({
          person: ctx.p.name,
          salary: ctx.e.salary,
        }))
        .execute();

      // Alice has salary 120k, Charlie has salary 150k
      // Both match the name filter and salary > 100k
      expect(results).toHaveLength(2);
      expect(results.map((result) => result.person).toSorted()).toEqual([
        "Alice",
        "Charlie",
      ]);
    });

    it("handles optional traversal with nullable edge access", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .optionalTraverse("worksAt", "e")
        .to("Company", "c")
        .select((ctx) => ({
          person: ctx.p.name,
          role: ctx.e?.role,
          salary: ctx.e?.salary,
        }))
        .execute();

      // Should include all 4 people
      expect(results).toHaveLength(4);

      const alice = results.find((result) => result.person === "Alice");
      expect(alice?.role).toBe("Engineer");
      expect(alice?.salary).toBe(120_000);

      const diana = results.find((result) => result.person === "Diana");
      expect(diana?.role).toBeUndefined();
      expect(diana?.salary).toBeUndefined();
    });

    it("applies whereEdge to optional traversals without excluding start nodes", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .optionalTraverse("worksAt", "e")
        .whereEdge("e", (edge) => edge.salary.gte(130_000))
        .to("Company", "c")
        .orderBy("p", "name", "asc")
        .select((ctx) => ({
          person: ctx.p.name,
          company: ctx.c?.name,
          salary: ctx.e?.salary,
        }))
        .execute();

      expect(results).toEqual([
        { person: "Alice", company: undefined, salary: undefined },
        { person: "Bob", company: undefined, salary: undefined },
        { person: "Charlie", company: "Acme Corp", salary: 150_000 },
        { person: "Diana", company: undefined, salary: undefined },
      ]);
    });

    it("selects only edge properties without node properties", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("worksAt", "e")
        .to("Company", "c")
        .select((ctx) => ctx.e)
        .execute();

      expect(results).toHaveLength(1);
      expect(results[0]?.role).toBe("Engineer");
      expect(results[0]?.salary).toBe(120_000);
      expect(results[0]?.id).toBeDefined();
      expect(results[0]?.kind).toBe("worksAt");
      expect(results[0]?.fromId).toBeDefined();
      expect(results[0]?.toId).toBeDefined();
      expect(results[0]?.meta).toBeDefined();
    });

    it("filters edge by role using string contains", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .traverse("worksAt", "e")
        .whereEdge("e", (edge) => edge.role.contains("an"))
        .to("Company", "c")
        .select((ctx) => ({
          person: ctx.p.name,
          role: ctx.e.role,
        }))
        .execute();

      // "Analyst" and "Manager" both contain "an"
      expect(results).toHaveLength(2);
      expect(results.map((result) => result.role).toSorted()).toEqual([
        "Analyst",
        "Manager",
      ]);
    });

    it("orders results by edge property", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .traverse("worksAt", "e")
        .to("Company", "c")
        .select((ctx) => ({
          person: ctx.p.name,
          salary: ctx.e.salary,
        }))
        .execute();

      // Verify all salaries are present
      const salaries = results.map((result) => result.salary);
      expect(salaries.toSorted((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
        80_000, 120_000, 150_000,
      ]);
    });
  });
}
