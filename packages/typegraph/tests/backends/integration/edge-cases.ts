/**
 * Integration Tests for Edge Cases
 *
 * Tests behavior in edge cases that might not be caught by unit tests:
 * - Empty result sets
 * - NULL handling in queries and aggregates
 * - Boundary conditions
 * - Concurrent operations
 */
import { describe, expect, it } from "vitest";

import { avg, count, max, min, sum } from "../../../src";
import type { IntegrationTestContext } from "./test-context";

// ============================================================
// Empty Result Set Tests
// ============================================================

function registerEmptyResultTests(context: IntegrationTestContext): void {
  describe("Empty Result Sets", () => {
    it("returns empty array when no nodes exist", async () => {
      const store = context.getStore();

      const results = await store
        .query()
        .from("Product", "n")
        .select((ctx) => ({ id: ctx.n.id }))
        .execute();

      expect(results).toEqual([]);
    });

    it("returns empty array when predicate matches nothing", async () => {
      const store = context.getStore();

      await store.nodes.Product.create({
        name: "Test Product",
        price: 100,
        category: "Electronics",
      });

      const results = await store
        .query()
        .from("Product", "n")
        .whereNode("n", (n) => n.category.eq("NonExistent"))
        .select((ctx) => ({ id: ctx.n.id }))
        .execute();

      expect(results).toEqual([]);
    });

    it("count returns 0 for empty result set", async () => {
      const store = context.getStore();

      const results = await store
        .query()
        .from("Product", "p")
        .whereNode("p", (p) => p.category.eq("NonExistent"))
        .selectAggregate({ total: count("p") })
        .execute();

      expect(results[0]!.total).toBe(0);
    });

    it("sum returns null for empty result set", async () => {
      const store = context.getStore();

      const results = await store
        .query()
        .from("Product", "p")
        .whereNode("p", (p) => p.category.eq("NonExistent"))
        .selectAggregate({ total: sum("p", "price") })
        .execute();

      // SQL SUM of empty set returns NULL
      expect(results[0]!.total).toBeNull();
    });

    it("avg returns null for empty result set", async () => {
      const store = context.getStore();

      const results = await store
        .query()
        .from("Product", "p")
        .whereNode("p", (p) => p.category.eq("NonExistent"))
        .selectAggregate({ average: avg("p", "price") })
        .execute();

      expect(results[0]!.average).toBeNull();
    });

    it("min/max return null for empty result set", async () => {
      const store = context.getStore();

      const results = await store
        .query()
        .from("Product", "p")
        .whereNode("p", (p) => p.category.eq("NonExistent"))
        .selectAggregate({
          minPrice: min("p", "price"),
          maxPrice: max("p", "price"),
        })
        .execute();

      expect(results[0]!.minPrice).toBeNull();
      expect(results[0]!.maxPrice).toBeNull();
    });
  });
}

// ============================================================
// NULL Handling Tests
// ============================================================

function registerNullHandlingTests(context: IntegrationTestContext): void {
  describe("NULL Handling", () => {
    it("isNull finds nodes with null optional fields", async () => {
      const store = context.getStore();

      await store.nodes.Product.create({
        name: "With Rating",
        price: 100,
        category: "A",
        rating: 4.5,
      });
      await store.nodes.Product.create({
        name: "Without Rating",
        price: 100,
        category: "A",
        // rating is undefined/null
      });

      const results = await store
        .query()
        .from("Product", "p")
        .whereNode("p", (p) => p.rating.isNull())
        .select((ctx) => ({ name: ctx.p.name }))
        .execute();

      expect(results).toHaveLength(1);
      expect(results[0]!.name).toBe("Without Rating");
    });

    it("isNotNull filters out null values", async () => {
      const store = context.getStore();

      await store.nodes.Product.create({
        name: "With Rating",
        price: 100,
        category: "A",
        rating: 4.5,
      });
      await store.nodes.Product.create({
        name: "Without Rating",
        price: 100,
        category: "A",
      });

      const results = await store
        .query()
        .from("Product", "p")
        .whereNode("p", (p) => p.rating.isNotNull())
        .select((ctx) => ({ name: ctx.p.name }))
        .execute();

      expect(results).toHaveLength(1);
      expect(results[0]!.name).toBe("With Rating");
    });
  });
}

// ============================================================
// Boundary Condition Tests
// ============================================================

function registerBoundaryTests(context: IntegrationTestContext): void {
  describe("Boundary Conditions", () => {
    it("handles limit of 0", async () => {
      const store = context.getStore();

      await store.nodes.Product.create({
        name: "Test",
        price: 100,
        category: "A",
      });

      const results = await store
        .query()
        .from("Product", "p")
        .limit(0)
        .select((ctx) => ({ name: ctx.p.name }))
        .execute();

      expect(results).toEqual([]);
    });

    it("handles offset beyond result set", async () => {
      const store = context.getStore();

      await store.nodes.Product.create({
        name: "Test",
        price: 100,
        category: "OffsetTest",
      });

      const results = await store
        .query()
        .from("Product", "p")
        .whereNode("p", (p) => p.category.eq("OffsetTest"))
        .limit(100)
        .offset(100)
        .select((ctx) => ({ name: ctx.p.name }))
        .execute();

      expect(results).toEqual([]);
    });

    it("handles limit and offset combined", async () => {
      const store = context.getStore();

      // Create 5 products with distinct names for predictable ordering
      await store.nodes.Product.create({
        name: "A",
        price: 100,
        category: "Test",
      });
      await store.nodes.Product.create({
        name: "B",
        price: 100,
        category: "Test",
      });
      await store.nodes.Product.create({
        name: "C",
        price: 100,
        category: "Test",
      });
      await store.nodes.Product.create({
        name: "D",
        price: 100,
        category: "Test",
      });
      await store.nodes.Product.create({
        name: "E",
        price: 100,
        category: "Test",
      });

      const results = await store
        .query()
        .from("Product", "p")
        .whereNode("p", (p) => p.category.eq("Test"))
        .orderBy("p", "name", "asc")
        .limit(2)
        .offset(2)
        .select((ctx) => ({ name: ctx.p.name }))
        .execute();

      // Should get products C and D (skipping first 2)
      expect(results).toHaveLength(2);
      expect(results[0]!.name).toBe("C");
      expect(results[1]!.name).toBe("D");
    });
  });
}

// ============================================================
// Concurrent Operation Tests
// ============================================================

function registerConcurrencyTests(context: IntegrationTestContext): void {
  describe("Concurrent Operations", () => {
    it("handles concurrent reads", async () => {
      const store = context.getStore();

      // Create test data
      await store.nodes.Product.create({
        name: "Test",
        price: 100,
        category: "A",
      });

      // Execute multiple concurrent reads
      const queries = Array.from({ length: 5 }, () =>
        store
          .query()
          .from("Product", "p")
          .select((ctx) => ({ name: ctx.p.name }))
          .execute(),
      );

      const results = await Promise.all(queries);

      // All should succeed with same results
      for (const result of results) {
        expect(result).toHaveLength(1);
        expect(result[0]!.name).toBe("Test");
      }
    });

    it("handles concurrent writes", async () => {
      const store = context.getStore();

      // Execute multiple concurrent writes
      const writes = Array.from({ length: 10 }, (_, index) =>
        store.nodes.Product.create({
          name: `Product ${index}`,
          price: 100 + index,
          category: "A",
        }),
      );

      const createdProducts = await Promise.all(writes);

      // All should succeed
      expect(createdProducts).toHaveLength(10);

      // Verify all products exist
      const results = await store
        .query()
        .from("Product", "p")
        .select((ctx) => ({ name: ctx.p.name }))
        .execute();

      expect(results).toHaveLength(10);
    });
  });
}

// ============================================================
// Combined Registration
// ============================================================

export function registerEdgeCaseIntegrationTests(
  context: IntegrationTestContext,
): void {
  registerEmptyResultTests(context);
  registerNullHandlingTests(context);
  registerBoundaryTests(context);
  registerConcurrencyTests(context);
}
