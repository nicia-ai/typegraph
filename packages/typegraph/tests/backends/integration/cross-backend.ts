/**
 * Cross-Backend Consistency Tests
 *
 * Tests that verify identical behavior across SQLite and PostgreSQL backends.
 * These tests ensure that switching backends doesn't change query semantics.
 */
import { describe, expect, it } from "vitest";

import { count, field, havingGt } from "../../../src";
import type { IntegrationTestContext } from "./test-context";

/**
 * Register tests that verify consistent behavior across backends.
 * These tests focus on operations that might have subtle dialect differences.
 */
export function registerCrossBackendConsistencyTests(
  context: IntegrationTestContext,
): void {
  describe("Cross-Backend Consistency", () => {
    describe("string operations", () => {
      it("startsWith matches prefix correctly", async () => {
        const store = context.getStore();

        await store.nodes.Product.create({
          name: "Apple Pie",
          price: 100,
          category: "Fruit",
        });
        await store.nodes.Product.create({
          name: "Banana Bread",
          price: 100,
          category: "Fruit",
        });
        await store.nodes.Product.create({
          name: "Pineapple",
          price: 100,
          category: "Fruit",
        });

        const results = await store
          .query()
          .from("Product", "n")
          .whereNode("n", (n) => n.name.startsWith("Apple"))
          .select((ctx) => ({ name: ctx.n.name }))
          .execute();

        // Should only match "Apple Pie" - not "Pineapple" which contains Apple
        expect(results).toHaveLength(1);
        expect(results[0]!.name).toBe("Apple Pie");
      });

      it("contains works consistently", async () => {
        const store = context.getStore();

        await store.nodes.Product.create({
          name: "Red Apple",
          price: 100,
          category: "Fruit",
        });
        await store.nodes.Product.create({
          name: "Green Pear",
          price: 100,
          category: "Fruit",
        });

        const results = await store
          .query()
          .from("Product", "n")
          .whereNode("n", (n) => n.name.contains("Apple"))
          .select((ctx) => ({ name: ctx.n.name }))
          .execute();

        expect(results).toHaveLength(1);
        expect(results[0]!.name).toBe("Red Apple");
      });

      it("endsWith works consistently", async () => {
        const store = context.getStore();

        await store.nodes.Product.create({
          name: "Fresh Apple",
          price: 100,
          category: "Fruit",
        });
        await store.nodes.Product.create({
          name: "Apple Fresh",
          price: 100,
          category: "Fruit",
        });

        const results = await store
          .query()
          .from("Product", "n")
          .whereNode("n", (n) => n.name.endsWith("Apple"))
          .select((ctx) => ({ name: ctx.n.name }))
          .execute();

        expect(results).toHaveLength(1);
        expect(results[0]!.name).toBe("Fresh Apple");
      });
    });

    describe("numeric comparisons", () => {
      it("between is inclusive on both ends", async () => {
        const store = context.getStore();

        await store.nodes.Product.create({
          name: "P1",
          price: 50,
          category: "A",
        });
        await store.nodes.Product.create({
          name: "P2",
          price: 100,
          category: "A",
        });
        await store.nodes.Product.create({
          name: "P3",
          price: 150,
          category: "A",
        });
        await store.nodes.Product.create({
          name: "P4",
          price: 200,
          category: "A",
        });

        const results = await store
          .query()
          .from("Product", "n")
          .whereNode("n", (n) => n.price.between(100, 150))
          .orderBy("n", "price", "asc")
          .select((ctx) => ({ name: ctx.n.name, price: ctx.n.price }))
          .execute();

        // Should include both 100 and 150
        expect(results).toHaveLength(2);
        expect(results[0]!.price).toBe(100);
        expect(results[1]!.price).toBe(150);
      });

      it("floating point comparisons work consistently", async () => {
        const store = context.getStore();

        await store.nodes.Product.create({
          name: "P1",
          price: 10.5,
          category: "A",
          rating: 4.5,
        });
        await store.nodes.Product.create({
          name: "P2",
          price: 10.500_01,
          category: "A",
          rating: 4.6,
        });

        const results = await store
          .query()
          .from("Product", "n")
          .whereNode("n", (n) => n.rating.gt(4.5))
          .select((ctx) => ({ name: ctx.n.name }))
          .execute();

        expect(results).toHaveLength(1);
        expect(results[0]!.name).toBe("P2");
      });
    });

    describe("array operations", () => {
      it("array contains works consistently", async () => {
        const store = context.getStore();

        await store.nodes.Document.create({
          title: "Doc1",
          tags: ["alpha", "beta", "gamma"],
        });
        await store.nodes.Document.create({
          title: "Doc2",
          tags: ["delta", "epsilon"],
        });

        const results = await store
          .query()
          .from("Document", "n")
          .whereNode("n", (n) => n.tags.contains("beta"))
          .select((ctx) => ({ title: ctx.n.title }))
          .execute();

        expect(results).toHaveLength(1);
        expect(results[0]!.title).toBe("Doc1");
      });
    });

    describe("ordering consistency", () => {
      it("string ordering returns all results in some order", async () => {
        const store = context.getStore();

        // Use names that sort consistently across backends (same case)
        const names = ["apple", "banana", "cherry", "date", "elderberry"];
        for (const name of names) {
          await store.nodes.Product.create({
            name,
            price: 100,
            category: "Fruit",
          });
        }

        const results = await store
          .query()
          .from("Product", "p")
          .whereNode("p", (p) => p.category.eq("Fruit"))
          .orderBy("p", "name", "asc")
          .select((ctx) => ({ name: ctx.p.name }))
          .execute();

        // With same-case names, ordering should be consistent across backends
        const namesResult = results.map((r) => r.name);
        expect(namesResult).toEqual([
          "apple",
          "banana",
          "cherry",
          "date",
          "elderberry",
        ]);
      });

      it("numeric ordering handles decimals correctly", async () => {
        const store = context.getStore();

        const prices = [1.1, 1.01, 1.001, 10, 2];
        for (const [index, price] of prices.entries()) {
          await store.nodes.Product.create({
            name: `P${index}`,
            price: price,
            category: "A",
          });
        }

        const results = await store
          .query()
          .from("Product", "p")
          .orderBy("p", "price", "asc")
          .select((ctx) => ({ price: ctx.p.price }))
          .execute();

        const orderedPrices = results.map((r) => r.price);
        expect(orderedPrices).toEqual([1.001, 1.01, 1.1, 2, 10]);
      });
    });

    describe("aggregate consistency", () => {
      it("count aggregation works consistently", async () => {
        const store = context.getStore();

        // Create products in a unique category for this test
        const uniqueCategory = `TestCategory_${Date.now()}`;
        await store.nodes.Product.create({
          name: "P1",
          price: 100,
          category: uniqueCategory,
        });
        await store.nodes.Product.create({
          name: "P2",
          price: 200,
          category: uniqueCategory,
        });
        await store.nodes.Product.create({
          name: "P3",
          price: 100,
          category: uniqueCategory,
        });

        const results = await store
          .query()
          .from("Product", "p")
          .whereNode("p", (p) => p.category.eq(uniqueCategory))
          .aggregate({
            totalProducts: count("p"),
          })
          .execute();

        expect(results[0]!.totalProducts).toBe(3);
      });

      it("group by with having works consistently", async () => {
        const store = context.getStore();

        // Create products in different categories
        await store.nodes.Product.create({
          name: "P1",
          price: 100,
          category: "A",
        });
        await store.nodes.Product.create({
          name: "P2",
          price: 200,
          category: "A",
        });
        await store.nodes.Product.create({
          name: "P3",
          price: 100,
          category: "B",
        });

        const results = await store
          .query()
          .from("Product", "p")
          .groupBy("p", "category")
          .having(havingGt(count("p"), 1))
          .aggregate({
            category: field("p", "category"),
            productCount: count("p"),
          })
          .execute();

        // Only category A has more than 1 product
        expect(results).toHaveLength(1);
        expect(results[0]!.category).toBe("A");
        expect(results[0]!.productCount).toBe(2);
      });
    });
  });
}
