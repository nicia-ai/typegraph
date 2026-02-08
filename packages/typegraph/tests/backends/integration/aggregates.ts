import { beforeEach, describe, expect, it } from "vitest";

import { avg, count, field, havingGte, max, min, sum } from "../../../src";
import {
  seedAdvancedAggregateProducts,
  seedAggregateProducts,
} from "./seed-helpers";
import { type IntegrationTestContext } from "./test-context";

export function registerAggregateIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Aggregate Query Execution", () => {
    beforeEach(async () => {
      const store = context.getStore();
      await seedAggregateProducts(store);
    });

    it("executes COUNT aggregation grouped by category", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Product", "p")
        .groupBy("p", "category")
        .selectAggregate({
          category: field("p", "category"),
          productCount: count("p"),
        })
        .execute();

      expect(results).toHaveLength(2);

      const electronics = results.find((r) => r.category === "Electronics");
      const furniture = results.find((r) => r.category === "Furniture");

      expect(electronics?.productCount).toBe(3);
      expect(furniture?.productCount).toBe(2);
    });

    it("executes SUM aggregation", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Product", "p")
        .groupBy("p", "category")
        .selectAggregate({
          category: field("p", "category"),
          totalValue: sum("p", "price"),
        })
        .execute();

      const electronics = results.find((r) => r.category === "Electronics");
      const furniture = results.find((r) => r.category === "Furniture");

      expect(electronics?.totalValue).toBe(2500); // 1200 + 800 + 500
      expect(furniture?.totalValue).toBe(450); // 300 + 150
    });

    it("executes AVG aggregation", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Product", "p")
        .groupBy("p", "category")
        .selectAggregate({
          category: field("p", "category"),
          avgPrice: avg("p", "price"),
        })
        .execute();

      const electronics = results.find((r) => r.category === "Electronics");
      const furniture = results.find((r) => r.category === "Furniture");

      // AVG returns floating point
      expect(electronics?.avgPrice).toBeCloseTo(833.33, 1);
      expect(furniture?.avgPrice).toBeCloseTo(225, 1);
    });

    it("executes MIN and MAX aggregations", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Product", "p")
        .groupBy("p", "category")
        .selectAggregate({
          category: field("p", "category"),
          cheapest: min("p", "price"),
          mostExpensive: max("p", "price"),
        })
        .execute();

      const electronics = results.find((r) => r.category === "Electronics");

      expect(electronics?.cheapest).toBe(500);
      expect(electronics?.mostExpensive).toBe(1200);
    });

    it("executes aggregation with HAVING clause", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Product", "p")
        .groupBy("p", "category")
        .having(havingGte(count("p"), 3))
        .selectAggregate({
          category: field("p", "category"),
          productCount: count("p"),
        })
        .execute();

      // Only Electronics has 3+ products
      expect(results).toHaveLength(1);
      expect(results[0]?.category).toBe("Electronics");
    });

    it("executes aggregation with WHERE filter before grouping", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Product", "p")
        .whereNode("p", (p) => p.category.eq("Electronics"))
        .groupBy("p", "category")
        .selectAggregate({
          category: field("p", "category"),
          productCount: count("p"),
        })
        .execute();

      // Should only have Electronics
      expect(results).toHaveLength(1);
      expect(results[0]?.category).toBe("Electronics");
      expect(results[0]?.productCount).toBe(3);
    });
  });

  describe("Advanced Aggregate Queries", () => {
    beforeEach(async () => {
      const store = context.getStore();
      await seedAdvancedAggregateProducts(store);
    });

    it("handles NULL values in AVG aggregation", async () => {
      // AVG should ignore NULL values
      const store = context.getStore();
      const results = await store
        .query()
        .from("Product", "p")
        .groupBy("p", "category")
        .selectAggregate({
          category: field("p", "category"),
          avgRating: avg("p", "rating"),
          productCount: count("p"),
        })
        .execute();

      const electronics = results.find((r) => r.category === "Electronics");
      const furniture = results.find((r) => r.category === "Furniture");

      // Electronics: 2 products with ratings (4.5, 3.8), 1 without
      expect(electronics?.productCount).toBe(3);
      expect(electronics?.avgRating).toBeCloseTo(4.15, 1);

      // Furniture: 2 products with ratings (4.2, 4.0), 1 without
      expect(furniture?.productCount).toBe(3);
      expect(furniture?.avgRating).toBeCloseTo(4.1, 1);
    });

    it("handles NULL values in SUM aggregation", async () => {
      // SUM should ignore NULL values (treat as 0 contribution)
      const store = context.getStore();
      const results = await store
        .query()
        .from("Product", "p")
        .groupBy("p", "category")
        .selectAggregate({
          category: field("p", "category"),
          totalRating: sum("p", "rating"),
        })
        .execute();

      const electronics = results.find((r) => r.category === "Electronics");
      // 4.5 + 3.8 = 8.3 (Tablet's NULL rating ignored)
      expect(electronics?.totalRating).toBeCloseTo(8.3, 1);
    });

    it("groups by multiple columns (category and inStock)", async () => {
      // This tests that GROUP BY with multiple columns works correctly
      const store = context.getStore();
      const results = await store
        .query()
        .from("Product", "p")
        .groupBy("p", "category")
        .groupBy("p", "inStock")
        .selectAggregate({
          category: field("p", "category"),
          inStock: field("p", "inStock"),
          productCount: count("p"),
        })
        .execute();

      // Should have 4 groups: Electronics/true, Electronics/false, Furniture/true, Furniture/false
      expect(results).toHaveLength(4);
      expect(
        results
          .map(
            (result) => `${String(result.category)}:${String(result.inStock)}`,
          )
          .toSorted(),
      ).toEqual([
        "Electronics:false",
        "Electronics:true",
        "Furniture:false",
        "Furniture:true",
      ]);

      const electronicsInStock = results.find(
        (result) =>
          result.category === "Electronics" && result.inStock === true,
      );
      expect(typeof electronicsInStock?.inStock).toBe("boolean");
      expect(electronicsInStock?.productCount).toBe(2);

      const furnitureInStock = results.find(
        (result) => result.category === "Furniture" && result.inStock === true,
      );
      expect(typeof furnitureInStock?.inStock).toBe("boolean");
      expect(furnitureInStock?.productCount).toBe(2);

      const electronicsNotInStock = results.find(
        (result) =>
          result.category === "Electronics" && result.inStock === false,
      );
      expect(typeof electronicsNotInStock?.inStock).toBe("boolean");
      expect(electronicsNotInStock?.productCount).toBe(1);

      const furnitureNotInStock = results.find(
        (result) => result.category === "Furniture" && result.inStock === false,
      );
      expect(typeof furnitureNotInStock?.inStock).toBe("boolean");
      expect(furnitureNotInStock?.productCount).toBe(1);
    });

    it("combines WHERE and HAVING clauses", async () => {
      // WHERE filters before grouping, HAVING filters after
      const store = context.getStore();
      const results = await store
        .query()
        .from("Product", "p")
        .whereNode("p", (p) => p.inStock.eq(true))
        .groupBy("p", "category")
        .having(havingGte(sum("p", "price"), 500))
        .selectAggregate({
          category: field("p", "category"),
          totalPrice: sum("p", "price"),
        })
        .execute();

      // Electronics in stock: Laptop Pro (1500) + Budget Laptop (800) = 2300
      // Furniture in stock: Office Desk (400) + Chair (200) = 600
      expect(results).toHaveLength(2);
      const electronics = results.find((r) => r.category === "Electronics");
      expect(electronics?.totalPrice).toBe(2300);
    });

    it("uses MIN/MAX with NULL values", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Product", "p")
        .groupBy("p", "category")
        .selectAggregate({
          category: field("p", "category"),
          minRating: min("p", "rating"),
          maxRating: max("p", "rating"),
        })
        .execute();

      const electronics = results.find((r) => r.category === "Electronics");
      expect(electronics?.minRating).toBeCloseTo(3.8, 1);
      expect(electronics?.maxRating).toBeCloseTo(4.5, 1);
    });

    it("groups by node using groupByNode", async () => {
      // Create companies and people
      const store = context.getStore();
      const acme = await store.nodes.Company.create({
        name: "Acme Corp",
        industry: "Tech",
      });
      const globex = await store.nodes.Company.create({
        name: "Globex",
        industry: "Tech",
      });

      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const charlie = await store.nodes.Person.create({ name: "Charlie" });

      // Alice and Bob work at Acme, Charlie works at Globex
      await store.edges.worksAt.create(alice, acme, {
        role: "Engineer",
        salary: 100_000,
      });
      await store.edges.worksAt.create(bob, acme, {
        role: "Manager",
        salary: 120_000,
      });
      await store.edges.worksAt.create(charlie, globex, {
        role: "Developer",
        salary: 90_000,
      });

      // Count employees per company using groupByNode
      const results = await store
        .query()
        .from("Company", "c")
        .traverse("worksAt", "e", { direction: "in" })
        .to("Person", "p")
        .groupByNode("c")
        .selectAggregate({
          companyId: field("c", "id"),
          companyName: field("c", "name"),
          employeeCount: count("p"),
        })
        .execute();

      expect(results).toHaveLength(2);
      const acmeResult = results.find((r) => r.companyName === "Acme Corp");
      const globexResult = results.find((r) => r.companyName === "Globex");

      expect(acmeResult?.employeeCount).toBe(2);
      expect(globexResult?.employeeCount).toBe(1);
    });
  });
}
