import { beforeEach, describe, expect, it } from "vitest";

import {
  seedPeopleForOrderByNullHandling,
  seedPeopleForOrderingWithNulls,
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
}
