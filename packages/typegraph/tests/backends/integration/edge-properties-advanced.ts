import { beforeEach, describe, expect, it } from "vitest";

import {
  seedMultiHopEdgePropertiesFixture,
  seedWorksAtEdgesForBackwardTraversal,
  seedWorksAtEdgesForInNotIn,
  seedWorksAtEdgesForMultipleWhereEdge,
  seedWorksAtEdgesForNumberOperators,
  seedWorksAtEdgesForPredicateCombinators,
  seedWorksAtEdgesForSalaryBetween,
  seedWorksAtEdgesForStringOperators,
  seedWorksAtEdgesWithNullSalaryValues,
  seedWorksAtEdgesWithOptionalSalary,
} from "./seed-helpers";
import { type IntegrationTestContext } from "./test-context";

export function registerAdvancedEdgePropertyIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Advanced Edge Property Tests", () => {
    describe("Multi-hop edge properties", () => {
      beforeEach(async () => {
        const store = context.getStore();
        await seedMultiHopEdgePropertiesFixture(store);
      });

      it("accesses properties from multiple edges in chained traversals", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .whereNode("p", (p) => p.name.eq("Alice"))
          .traverse("knows", "e1")
          .to("Person", "friend")
          .traverse("worksAt", "e2")
          .to("Company", "c")
          .select((ctx) => ({
            person: ctx.p.name,
            friend: ctx.friend.name,
            knownSince: ctx.e1.since,
            company: ctx.c.name,
            friendRole: ctx.e2.role,
            friendSalary: ctx.e2.salary,
          }))
          .execute();

        expect(results).toHaveLength(1);
        expect(results[0]).toEqual({
          person: "Alice",
          friend: "Bob",
          knownSince: "2020-01-01",
          company: "Acme Corp",
          friendRole: "Engineer",
          friendSalary: 100_000,
        });
      });

      it("filters on different edges in multi-hop query", async () => {
        const store = context.getStore();
        // Find people Alice knows who earn > 120k
        const results = await store
          .query()
          .from("Person", "p")
          .whereNode("p", (p) => p.name.eq("Alice"))
          .traverse("knows", "e1")
          .to("Person", "friend")
          .traverse("worksAt", "e2")
          .whereEdge("e2", (edge) => edge.salary.gt(120_000))
          .to("Company", "c")
          .select((ctx) => ({
            friend: ctx.friend.name,
            salary: ctx.e2.salary,
          }))
          .execute();

        // Bob earns 100k, so no direct friends qualify
        expect(results).toHaveLength(0);
      });

      it("filters on a previous traversal's edge using QueryBuilder.whereEdge", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .whereNode("p", (p) => p.name.eq("Bob"))
          .traverse("knows", "e1")
          .to("Person", "friend")
          .traverse("worksAt", "e2")
          .to("Company", "c")
          .whereEdge("e1", (edge) => edge.since.eq("2021-06-15"))
          .select((ctx) => ({
            friend: ctx.friend.name,
            company: ctx.c.name,
            knownSince: ctx.e1.since,
            role: ctx.e2.role,
          }))
          .execute();

        expect(results).toHaveLength(1);
        expect(results[0]).toEqual({
          friend: "Charlie",
          company: "Globex",
          knownSince: "2021-06-15",
          role: "Manager",
        });
      });

      it("accesses both edges in two-hop knows chain", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .whereNode("p", (p) => p.name.eq("Alice"))
          .traverse("knows", "e1")
          .to("Person", "friend")
          .traverse("knows", "e2")
          .to("Person", "fof")
          .select((ctx) => ({
            person: ctx.p.name,
            friend: ctx.friend.name,
            fof: ctx.fof.name,
            since1: ctx.e1.since,
            since2: ctx.e2.since,
          }))
          .execute();

        expect(results).toHaveLength(1);
        expect(results[0]).toEqual({
          person: "Alice",
          friend: "Bob",
          fof: "Charlie",
          since1: "2020-01-01",
          since2: "2021-06-15",
        });
      });
    });

    describe("whereEdge with null checks", () => {
      beforeEach(async () => {
        const store = context.getStore();
        await seedWorksAtEdgesWithOptionalSalary(store);
      });

      it("filters edges where property is null", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .whereEdge("e", (edge) => edge.salary.isNull())
          .to("Company", "c")
          .select((ctx) => ({
            person: ctx.p.name,
            role: ctx.e.role,
            salary: ctx.e.salary,
          }))
          .execute();

        expect(results).toHaveLength(1);
        expect(results[0]?.person).toBe("Bob");
        expect(results[0]?.role).toBe("Intern");
        expect(results[0]?.salary).toBeUndefined();
      });

      it("filters edges where property is not null", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .whereEdge("e", (edge) => edge.salary.isNotNull())
          .to("Company", "c")
          .select((ctx) => ({
            person: ctx.p.name,
            salary: ctx.e.salary,
          }))
          .execute();

        expect(results).toHaveLength(2);
        expect(results.map((result) => result.person).toSorted()).toEqual([
          "Alice",
          "Charlie",
        ]);
      });
    });

    describe("whereEdge with in/notIn", () => {
      beforeEach(async () => {
        const store = context.getStore();
        await seedWorksAtEdgesForInNotIn(store);
      });

      it("filters edges where property is in a set of values", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .whereEdge("e", (edge) => edge.role.in(["Engineer", "Manager"]))
          .to("Company", "c")
          .select((ctx) => ({
            person: ctx.p.name,
            role: ctx.e.role,
          }))
          .execute();

        expect(results).toHaveLength(2);
        expect(results.map((result) => result.role).toSorted()).toEqual([
          "Engineer",
          "Manager",
        ]);
      });

      it("filters edges where property is not in a set of values", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .whereEdge("e", (edge) => edge.role.notIn(["Engineer", "Manager"]))
          .to("Company", "c")
          .select((ctx) => ({
            person: ctx.p.name,
            role: ctx.e.role,
          }))
          .execute();

        expect(results).toHaveLength(2);
        expect(results.map((result) => result.role).toSorted()).toEqual([
          "Analyst",
          "Director",
        ]);
      });

      it("filters edges where numeric property is in a set", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .whereEdge("e", (edge) => edge.salary.in([100_000, 200_000]))
          .to("Company", "c")
          .select((ctx) => ({
            person: ctx.p.name,
            salary: ctx.e.salary,
          }))
          .execute();

        expect(results).toHaveLength(2);
        expect(results.map((result) => result.person).toSorted()).toEqual([
          "Alice",
          "Diana",
        ]);
      });
    });

    describe("whereEdge with between", () => {
      beforeEach(async () => {
        const store = context.getStore();
        await seedWorksAtEdgesForSalaryBetween(store);
      });

      it("filters edges where property is between two values", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .whereEdge("e", (edge) => edge.salary.between(80_000, 130_000))
          .to("Company", "c")
          .select((ctx) => ({
            person: ctx.p.name,
            salary: ctx.e.salary,
          }))
          .execute();

        // 90k and 120k are between 80k and 130k (inclusive)
        expect(results).toHaveLength(2);
        expect(results.map((result) => result.person).toSorted()).toEqual([
          "Bob",
          "Charlie",
        ]);
      });
    });

    describe("whereEdge with backward traversal", () => {
      beforeEach(async () => {
        const store = context.getStore();
        await seedWorksAtEdgesForBackwardTraversal(store);
      });

      it("filters on edge properties when traversing backward", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Company", "c")
          .whereNode("c", (c) => c.name.eq("Acme Corp"))
          .traverse("worksAt", "e", { direction: "in" })
          .whereEdge("e", (edge) => edge.salary.gte(100_000))
          .to("Person", "p")
          .select((ctx) => ({
            company: ctx.c.name,
            employee: ctx.p.name,
            role: ctx.e.role,
            salary: ctx.e.salary,
          }))
          .execute();

        expect(results).toHaveLength(2);
        expect(results.map((result) => result.employee).toSorted()).toEqual([
          "Alice",
          "Bob",
        ]);
      });

      it("combines backward traversal with string edge filter", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Company", "c")
          .traverse("worksAt", "e", { direction: "in" })
          .whereEdge("e", (edge) => edge.role.eq("Manager"))
          .to("Person", "p")
          .select((ctx) => ({
            employee: ctx.p.name,
            role: ctx.e.role,
          }))
          .execute();

        expect(results).toHaveLength(1);
        expect(results[0]?.employee).toBe("Bob");
        expect(results[0]?.role).toBe("Manager");
      });
    });

    describe("Multiple whereEdge calls on same edge", () => {
      beforeEach(async () => {
        const store = context.getStore();
        await seedWorksAtEdgesForMultipleWhereEdge(store);
      });

      it("chains multiple whereEdge calls (AND logic)", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .whereEdge("e", (edge) => edge.role.eq("Engineer"))
          .whereEdge("e", (edge) => edge.salary.gte(90_000))
          .to("Company", "c")
          .select((ctx) => ({
            person: ctx.p.name,
            role: ctx.e.role,
            salary: ctx.e.salary,
          }))
          .execute();

        // Only Alice is Engineer with salary >= 90k
        expect(results).toHaveLength(1);
        expect(results[0]?.person).toBe("Alice");
      });

      it("chains three whereEdge calls", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .whereEdge("e", (edge) => edge.salary.gte(80_000))
          .whereEdge("e", (edge) => edge.salary.lte(120_000))
          .whereEdge("e", (edge) => edge.role.eq("Engineer"))
          .to("Company", "c")
          .select((ctx) => ({
            person: ctx.p.name,
            salary: ctx.e.salary,
          }))
          .execute();

        // Engineers with salary 80k-120k: Alice (100k), Bob (80k)
        expect(results).toHaveLength(2);
        expect(results.map((result) => result.person).toSorted()).toEqual([
          "Alice",
          "Bob",
        ]);
      });
    });

    // Note: Edge properties in recursive traversals are not yet supported.
    // Recursive traversals generate CTEs differently and don't project edge
    // properties in the same way as regular traversals. Use regular multi-hop
    // traversals when you need to access edge properties at each hop.
    //
    // Future enhancement: Add edge property support to recursive traversals.

    // Note: orderBy on edge properties is not yet supported. The orderBy API
    // currently only accepts node aliases. To sort by edge properties, fetch
    // the data and sort in application code.
    //
    // Future enhancement: Add edge alias support to orderBy.

    describe("String operators on edge properties", () => {
      beforeEach(async () => {
        const store = context.getStore();
        await seedWorksAtEdgesForStringOperators(store);
      });

      it("filters edges using startsWith on string property", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .whereEdge("e", (edge) => edge.role.startsWith("Senior"))
          .to("Company", "c")
          .select((ctx) => ({
            person: ctx.p.name,
            role: ctx.e.role,
          }))
          .execute();

        expect(results).toHaveLength(1);
        expect(results[0]?.person).toBe("Alice");
        expect(results[0]?.role).toBe("Senior Engineer");
      });

      it("filters edges using endsWith on string property", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .whereEdge("e", (edge) => edge.role.endsWith("Engineer"))
          .to("Company", "c")
          .orderBy("p", "name", "asc")
          .select((ctx) => ({
            person: ctx.p.name,
            role: ctx.e.role,
          }))
          .execute();

        expect(results).toHaveLength(2);
        expect(results[0]?.person).toBe("Alice");
        expect(results[1]?.person).toBe("Bob");
      });

      it("filters edges using like pattern on string property", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .whereEdge("e", (edge) => edge.role.like("%Engineer%"))
          .to("Company", "c")
          .orderBy("p", "name", "asc")
          .select((ctx) => ({
            person: ctx.p.name,
            role: ctx.e.role,
          }))
          .execute();

        // Matches: Senior Engineer, Junior Engineer, Engineering Manager
        expect(results).toHaveLength(3);
        expect(results.map((result) => result.person)).toEqual([
          "Alice",
          "Bob",
          "Charlie",
        ]);
      });

      it("filters edges using ilike (case-insensitive) on string property", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .whereEdge("e", (edge) => edge.role.ilike("%DESIGNER%"))
          .to("Company", "c")
          .select((ctx) => ({
            person: ctx.p.name,
            role: ctx.e.role,
          }))
          .execute();

        expect(results).toHaveLength(1);
        expect(results[0]?.person).toBe("Diana");
        expect(results[0]?.role).toBe("Product Designer");
      });

      it("filters edges using neq on string property", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .whereEdge("e", (edge) => edge.role.neq("Product Designer"))
          .to("Company", "c")
          .orderBy("p", "name", "asc")
          .select((ctx) => ({
            person: ctx.p.name,
            role: ctx.e.role,
          }))
          .execute();

        expect(results).toHaveLength(3);
        expect(results.map((result) => result.person)).toEqual([
          "Alice",
          "Bob",
          "Charlie",
        ]);
      });
    });

    describe("Number operators on edge properties", () => {
      beforeEach(async () => {
        const store = context.getStore();
        await seedWorksAtEdgesForNumberOperators(store);
      });

      it("filters edges using lt on numeric property", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .whereEdge("e", (edge) => edge.salary.lt(100_000))
          .to("Company", "c")
          .select((ctx) => ({
            person: ctx.p.name,
            salary: ctx.e.salary,
          }))
          .execute();

        expect(results).toHaveLength(1);
        expect(results[0]?.person).toBe("Charlie");
        expect(results[0]?.salary).toBe(50_000);
      });

      it("filters edges using lte on numeric property", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .whereEdge("e", (edge) => edge.salary.lte(100_000))
          .to("Company", "c")
          .orderBy("p", "name", "asc")
          .select((ctx) => ({
            person: ctx.p.name,
            salary: ctx.e.salary,
          }))
          .execute();

        expect(results).toHaveLength(2);
        expect(results.map((result) => result.person)).toEqual([
          "Alice",
          "Charlie",
        ]);
      });

      it("filters edges using neq on numeric property", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .whereEdge("e", (edge) => edge.salary.neq(100_000))
          .to("Company", "c")
          .orderBy("p", "name", "asc")
          .select((ctx) => ({
            person: ctx.p.name,
            salary: ctx.e.salary,
          }))
          .execute();

        expect(results).toHaveLength(2);
        expect(results.map((result) => result.person)).toEqual([
          "Bob",
          "Charlie",
        ]);
      });
    });

    describe("Predicate combinators on edge properties", () => {
      beforeEach(async () => {
        const store = context.getStore();
        await seedWorksAtEdgesForPredicateCombinators(store);
      });

      it("filters edges using OR combinator", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .whereEdge("e", (edge) =>
            edge.role.eq("Engineer").or(edge.role.eq("Manager")),
          )
          .to("Company", "c")
          .orderBy("p", "name", "asc")
          .select((ctx) => ({
            person: ctx.p.name,
            role: ctx.e.role,
          }))
          .execute();

        expect(results).toHaveLength(2);
        expect(results.map((result) => result.person)).toEqual([
          "Alice",
          "Bob",
        ]);
      });

      it("filters edges using NOT combinator", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .whereEdge("e", (edge) => edge.salary.lt(100_000).not())
          .to("Company", "c")
          .orderBy("p", "name", "asc")
          .select((ctx) => ({
            person: ctx.p.name,
            salary: ctx.e.salary,
          }))
          .execute();

        // NOT(salary < 100_000) means salary >= 100_000
        expect(results).toHaveLength(3);
        expect(results.map((result) => result.person)).toEqual([
          "Alice",
          "Bob",
          "Charlie",
        ]);
      });

      it("filters edges using AND combinator (via chained predicates)", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .whereEdge("e", (edge) =>
            edge.salary.gte(100_000).and(edge.salary.lte(130_000)),
          )
          .to("Company", "c")
          .orderBy("p", "name", "asc")
          .select((ctx) => ({
            person: ctx.p.name,
            salary: ctx.e.salary,
          }))
          .execute();

        expect(results).toHaveLength(2);
        expect(results.map((result) => result.person)).toEqual([
          "Alice",
          "Charlie",
        ]);
      });

      it("combines OR and AND in complex predicate", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .whereEdge("e", (edge) =>
            edge.role
              .eq("Engineer")
              .or(edge.role.eq("Manager").and(edge.salary.gt(140_000))),
          )
          .to("Company", "c")
          .orderBy("p", "name", "asc")
          .select((ctx) => ({
            person: ctx.p.name,
            role: ctx.e.role,
            salary: ctx.e.salary,
          }))
          .execute();

        // Engineer (Alice) OR (Manager AND salary > 140k) (Bob)
        expect(results).toHaveLength(2);
        expect(results.map((result) => result.person)).toEqual([
          "Alice",
          "Bob",
        ]);
      });
    });

    // Note: Edge properties in set operations (UNION, INTERSECT, EXCEPT) are
    // not yet supported. The set operation compiler doesn't project edge
    // columns in the combined result. To use edge properties with set operations,
    // fetch the data separately and combine in application code.
    //
    // Future enhancement: Add edge column support to set operation compiler.

    // Note: Edge properties with temporal modes (includeTombstones, includeEnded)
    // require the temporal filtering to be applied to the edge traversal CTE,
    // which is not currently implemented. The temporal mode only affects node
    // filtering. To access edge properties on soft-deleted or ended edges,
    // use raw SQL queries or fetch all edges and filter in application code.
    //
    // Future enhancement: Add temporal mode support to edge traversal CTEs.

    describe("Null edge property values", () => {
      beforeEach(async () => {
        const store = context.getStore();
        await seedWorksAtEdgesWithNullSalaryValues(store);
      });

      it("returns undefined for null optional edge properties", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .to("Company", "c")
          .orderBy("p", "name", "asc")
          .select((ctx) => ({
            person: ctx.p.name,
            role: ctx.e.role,
            salary: ctx.e.salary,
          }))
          .execute();

        expect(results).toHaveLength(3);

        const alice = results.find((result) => result.person === "Alice");
        expect(alice?.salary).toBe(100_000);

        const bob = results.find((result) => result.person === "Bob");
        expect(bob?.salary).toBeUndefined();

        const charlie = results.find((result) => result.person === "Charlie");
        expect(charlie?.salary).toBeUndefined();
      });
    });

    // Note: Edge property aggregations (SUM, AVG, GROUP BY on edge fields) are
    // not yet supported in the aggregate API. The aggregation API currently
    // only supports node aliases. To aggregate edge properties, use the regular
    // select() API to fetch the data and perform aggregation in application code.
    //
    // Future enhancement: Add edge alias support to groupBy/aggregate.
  });
}
