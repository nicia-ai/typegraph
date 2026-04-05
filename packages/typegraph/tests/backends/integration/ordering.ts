import { beforeEach, describe, expect, it } from "vitest";

import {
  seedMultiHopEdgePropertiesFixture,
  seedPeopleCompaniesForEdgePropertySelection,
  seedPeopleForOrderByNullHandling,
  seedPeopleForOrderingWithNulls,
  seedWorksAtEdgesWithNullSalaryValues,
} from "./seed-helpers";
import { type IntegrationTestContext } from "./test-context";

export function registerOrderingIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Ordering with Nulls", () => {
    beforeEach(async () => {
      const store = context.getStore();
      await seedPeopleForOrderingWithNulls(store);
    });

    it("orders ascending with nulls default behavior", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .orderBy("p", "age", "asc")
        .select((ctx) => ({ name: ctx.p.name, age: ctx.p.age }))
        .execute();

      expect(results).toHaveLength(5);
      expect(results.map((result) => result.age)).toEqual([
        25,
        30,
        35,
        undefined,
        undefined,
      ]);
    });

    it("orders descending", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .orderBy("p", "age", "desc")
        .select((ctx) => ({ name: ctx.p.name, age: ctx.p.age }))
        .execute();

      expect(results.map((result) => result.age)).toEqual([
        undefined,
        undefined,
        35,
        30,
        25,
      ]);
    });

    it("orders by multiple fields", async () => {
      const store = context.getStore();
      // Add people with same age
      await store.nodes.Person.create({ name: "Frank", age: 30 });

      const results = await store
        .query()
        .from("Person", "p")
        .orderBy("p", "age", "asc")
        .orderBy("p", "name", "asc")
        .select((ctx) => ({ name: ctx.p.name, age: ctx.p.age }))
        .execute();

      // People with age 30 should be ordered by name
      const age30 = results.filter((result) => result.age === 30);
      expect(age30.map((result) => result.name)).toEqual(["Alice", "Frank"]);
    });
  });

  describe("OrderBy NULL Handling", () => {
    beforeEach(async () => {
      const store = context.getStore();
      await seedPeopleForOrderByNullHandling(store);
    });

    it("orders nullable field ascending (nulls behavior)", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .orderBy("p", "age", "asc")
        .select((ctx) => ({ name: ctx.p.name, age: ctx.p.age }))
        .execute();

      expect(results).toHaveLength(5);
      expect(results.map((result) => result.age)).toEqual([
        25,
        30,
        35,
        undefined,
        undefined,
      ]);
    });

    it("orders nullable field descending (nulls behavior)", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .orderBy("p", "age", "desc")
        .select((ctx) => ({ name: ctx.p.name, age: ctx.p.age }))
        .execute();

      expect(results).toHaveLength(5);
      expect(results.map((result) => result.age)).toEqual([
        undefined,
        undefined,
        35,
        30,
        25,
      ]);
    });

    it("orders by nullable string field", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .orderBy("p", "email", "asc")
        .select((ctx) => ({ name: ctx.p.name, email: ctx.p.email }))
        .execute();

      expect(results).toHaveLength(5);
      expect(results.map((result) => result.email)).toEqual([
        "alice@example.com",
        "charlie@example.com",
        "diana@example.com",
        undefined,
        undefined,
      ]);
    });

    it("orders by multiple fields with mixed nullability", async () => {
      const store = context.getStore();
      // Add a second person with age 30 to test secondary sort
      await store.nodes.Person.create({
        name: "Frank",
        age: 30,
        // No email
      });

      const results = await store
        .query()
        .from("Person", "p")
        .orderBy("p", "age", "asc")
        .orderBy("p", "name", "asc")
        .select((ctx) => ({ name: ctx.p.name, age: ctx.p.age }))
        .execute();

      // People with age 30 should be sorted by name
      const age30 = results.filter((result) => result.age === 30);
      expect(age30.map((result) => result.name)).toEqual(["Alice", "Frank"]);
    });

    it("handles order by on field with all nulls", async () => {
      const store = context.getStore();
      // Create products with no rating
      await store.nodes.Product.create({
        name: "Product A",
        price: 100,
        category: "Test",
      });
      await store.nodes.Product.create({
        name: "Product B",
        price: 200,
        category: "Test",
      });

      const results = await store
        .query()
        .from("Product", "p")
        .whereNode("p", (p) => p.category.eq("Test"))
        .orderBy("p", "rating", "asc")
        .orderBy("p", "name", "asc")
        .select((ctx) => ({ name: ctx.p.name, rating: ctx.p.rating }))
        .execute();

      // Should still return results, sorted by secondary key (name)
      expect(results).toHaveLength(2);
      expect(results[0]?.name).toBe("Product A");
      expect(results[1]?.name).toBe("Product B");
    });
  });

  describe("Edge Property Ordering", () => {
    describe("single traversal", () => {
      beforeEach(async () => {
        const store = context.getStore();
        await seedPeopleCompaniesForEdgePropertySelection(store);
      });

      it("orders by edge property ascending", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .to("Company", "c")
          .orderBy("e", "salary", "asc")
          .select((ctx) => ({
            name: ctx.p.name,
            salary: ctx.e.salary,
          }))
          .execute();

        expect(results).toHaveLength(3);
        expect(results.map((result) => result.salary)).toEqual([
          80_000, 120_000, 150_000,
        ]);
      });

      it("orders by edge property descending", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .to("Company", "c")
          .orderBy("e", "salary", "desc")
          .select((ctx) => ({
            name: ctx.p.name,
            salary: ctx.e.salary,
          }))
          .execute();

        expect(results).toHaveLength(3);
        expect(results.map((result) => result.salary)).toEqual([
          150_000, 120_000, 80_000,
        ]);
      });

      it("orders by edge string property", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .to("Company", "c")
          .orderBy("e", "role", "asc")
          .select((ctx) => ({
            name: ctx.p.name,
            role: ctx.e.role,
          }))
          .execute();

        expect(results).toHaveLength(3);
        expect(results.map((result) => result.role)).toEqual([
          "Analyst",
          "Engineer",
          "Manager",
        ]);
      });
    });

    describe("post-select ordering by edge property", () => {
      beforeEach(async () => {
        const store = context.getStore();
        await seedPeopleCompaniesForEdgePropertySelection(store);
      });

      it("orders by numeric edge property after select (correct type-aware compilation)", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .to("Company", "c")
          .select((ctx) => ({
            name: ctx.p.name,
            salary: ctx.e.salary,
          }))
          .orderBy("e", "salary", "asc")
          .execute();

        expect(results).toHaveLength(3);
        expect(results.map((result) => result.salary)).toEqual([
          80_000, 120_000, 150_000,
        ]);
      });
    });

    describe("null handling on edge properties", () => {
      beforeEach(async () => {
        const store = context.getStore();
        await seedWorksAtEdgesWithNullSalaryValues(store);
      });

      it("orders nullable edge property ascending (nulls last)", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .to("Company", "c")
          .orderBy("e", "salary", "asc")
          .select((ctx) => ({
            name: ctx.p.name,
            salary: ctx.e.salary,
          }))
          .execute();

        expect(results).toHaveLength(3);
        expect(results.map((result) => result.salary)).toEqual([
          100_000,
          undefined,
          undefined,
        ]);
      });

      it("orders nullable edge property descending (nulls first)", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .to("Company", "c")
          .orderBy("e", "salary", "desc")
          .select((ctx) => ({
            name: ctx.p.name,
            salary: ctx.e.salary,
          }))
          .execute();

        expect(results).toHaveLength(3);
        expect(results.map((result) => result.salary)).toEqual([
          undefined,
          undefined,
          100_000,
        ]);
      });
    });

    describe("multi-hop traversal", () => {
      beforeEach(async () => {
        const store = context.getStore();
        await seedMultiHopEdgePropertiesFixture(store);
      });

      it("orders by edge property on second traversal", async () => {
        const store = context.getStore();
        // Query from all people who know someone, then traverse to their companies
        // Alice→Bob (Bob works at Acme 100k), Bob→Charlie (Charlie works at Globex 150k)
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("knows", "e1")
          .to("Person", "friend")
          .traverse("worksAt", "e2")
          .to("Company", "c")
          .orderBy("e2", "salary", "asc")
          .select((ctx) => ({
            person: ctx.p.name,
            friend: ctx.friend.name,
            company: ctx.c.name,
            salary: ctx.e2.salary,
          }))
          .execute();

        expect(results).toHaveLength(2);
        expect(results.map((result) => result.salary)).toEqual([
          100_000, 150_000,
        ]);
      });

      it("orders by edge property combined with node property", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("knows", "e1")
          .to("Person", "friend")
          .traverse("worksAt", "e2")
          .to("Company", "c")
          .orderBy("e2", "salary", "desc")
          .orderBy("friend", "name", "asc")
          .select((ctx) => ({
            friend: ctx.friend.name,
            salary: ctx.e2.salary,
          }))
          .execute();

        expect(results).toHaveLength(2);
        expect(results.map((result) => result.salary)).toEqual([
          150_000, 100_000,
        ]);
      });
    });
  });
}
