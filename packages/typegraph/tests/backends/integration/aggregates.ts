import { beforeEach, describe, expect, it } from "vitest";

import {
  avg,
  count,
  countDistinct,
  field,
  havingGte,
  max,
  min,
  sum,
} from "../../../src";
import { requireDefined } from "../../../src/utils/presence";
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
        .aggregate({
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
        .aggregate({
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
        .aggregate({
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
        .aggregate({
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
        .aggregate({
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
        .aggregate({
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

  describe("Aggregate ORDER BY", () => {
    beforeEach(async () => {
      const store = context.getStore();
      await seedAggregateProducts(store);
    });

    it("orders by a grouped field ascending", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Product", "p")
        .groupBy("p", "category")
        .aggregate({
          category: field("p", "category"),
          productCount: count("p"),
        })
        .orderBy("category", "asc")
        .execute();

      expect(results.map((result) => result.category)).toEqual([
        "Electronics",
        "Furniture",
      ]);
    });

    it("orders by a grouped field descending", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Product", "p")
        .groupBy("p", "category")
        .aggregate({
          category: field("p", "category"),
          productCount: count("p"),
        })
        .orderBy("category", "desc")
        .execute();

      expect(results.map((result) => result.category)).toEqual([
        "Furniture",
        "Electronics",
      ]);
    });

    it("orders by an aggregate alias, enabling correct top-N via limit", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Product", "p")
        .groupBy("p", "category")
        .aggregate({
          category: field("p", "category"),
          productCount: count("p"),
        })
        .orderBy("productCount", "desc")
        .limit(1)
        .execute();

      // Electronics has 3 products, Furniture has 2 — without ORDER BY this
      // would be an arbitrary one of the two groups.
      expect(results).toHaveLength(1);
      expect(results[0]?.category).toBe("Electronics");
      expect(results[0]?.productCount).toBe(3);
    });

    it("orders by an aggregate alias ascending", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Product", "p")
        .groupBy("p", "category")
        .aggregate({
          category: field("p", "category"),
          productCount: count("p"),
        })
        .orderBy("productCount", "asc")
        .execute();

      expect(results.map((result) => result.category)).toEqual([
        "Furniture",
        "Electronics",
      ]);
    });

    it("supports multi-key ordering across a grouped field then an aggregate alias", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Product", "p")
        .groupBy("p", "category")
        .groupBy("p", "inStock")
        .aggregate({
          category: field("p", "category"),
          inStock: field("p", "inStock"),
          productCount: count("p"),
        })
        .orderBy("category", "asc")
        .orderBy("inStock", "asc")
        .execute();

      expect(
        results.map(
          (result) => `${String(result.category)}:${String(result.inStock)}`,
        ),
      ).toEqual(["Electronics:false", "Electronics:true", "Furniture:true"]);
    });

    it("orders correct top-N results through the traversal + groupByNode count fast path", async () => {
      // This shape (single traversal, groupByNode on the start alias, a
      // count() aggregate) hits the compiler's count-aggregate fast path,
      // which builds its own ORDER BY/LIMIT independently of the general
      // query path — cover it explicitly so ordering isn't silently
      // dropped for the most common "top N by count" traversal shape.
      const store = context.getStore();

      const acme = await store.nodes.Company.create({
        name: "Acme Corp",
        industry: "Tech",
      });
      const globex = await store.nodes.Company.create({
        name: "Globex",
        industry: "Finance",
      });

      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const charlie = await store.nodes.Person.create({ name: "Charlie" });
      const dave = await store.nodes.Person.create({ name: "Dave" });

      await store.edges.worksAt.create(alice, acme, {
        role: "Engineer",
        salary: 100_000,
      });
      await store.edges.worksAt.create(bob, acme, {
        role: "Manager",
        salary: 120_000,
      });
      await store.edges.worksAt.create(charlie, acme, {
        role: "Designer",
        salary: 90_000,
      });
      await store.edges.worksAt.create(dave, globex, {
        role: "Developer",
        salary: 90_000,
      });

      const results = await store
        .query()
        .from("Company", "c")
        .traverse("worksAt", "e", { direction: "in" })
        .to("Person", "p")
        .groupByNode("c")
        .aggregate({
          companyName: field("c", "name"),
          employeeCount: count("p"),
        })
        .orderBy("employeeCount", "desc")
        .limit(2)
        .execute();

      expect(results).toHaveLength(2);
      expect(results[0]?.companyName).toBe("Acme Corp");
      expect(results[0]?.employeeCount).toBe(3);
      expect(results[1]?.companyName).toBe("Globex");
      expect(results[1]?.employeeCount).toBe(1);
    });

    it("orders correct top-N results through the count fast path's optional-traversal LIMIT pushdown", async () => {
      // The fast path pushes LIMIT into the start CTE *before* aggregation
      // when the traversal is optional (LEFT JOIN) and there's no ORDER BY
      // — an optimization that's only safe when every start-alias row is
      // equally eligible to appear in the final page, i.e. when nothing
      // depends on the aggregate result to pick which rows survive.
      // `orderBy("employeeCount", ...)` sorts by that aggregate result, so
      // this must disable the pushdown the same way `ast.orderBy` already
      // does — otherwise LIMIT truncates an arbitrary, uncounted subset of
      // companies before employeeCount is even computed. Company creation
      // order here is the reverse of the expected top-2, so a reintroduced
      // pushdown bug would surface as the wrong top-2 rather than
      // coincidentally passing.
      const store = context.getStore();

      const zeta = await store.nodes.Company.create({
        name: "Zeta Corp",
        industry: "Retail",
      });
      const yankee = await store.nodes.Company.create({
        name: "Yankee Corp",
        industry: "Retail",
      });
      const bravo = await store.nodes.Company.create({
        name: "Bravo Corp",
        industry: "Tech",
      });
      const alpha = await store.nodes.Company.create({
        name: "Alpha Corp",
        industry: "Tech",
      });

      const people = await Promise.all(
        Array.from({ length: 6 }, (_unused, index) =>
          store.nodes.Person.create({ name: `Person ${index}` }),
        ),
      );

      // Zeta: 0 employees (optionalTraverse must still surface it).
      // Yankee: 1 employee. Bravo: 2 employees. Alpha: 3 employees.
      await store.edges.worksAt.create(requireDefined(people[0]), yankee, {
        role: "Engineer",
        salary: 90_000,
      });
      await store.edges.worksAt.create(requireDefined(people[1]), bravo, {
        role: "Engineer",
        salary: 90_000,
      });
      await store.edges.worksAt.create(requireDefined(people[2]), bravo, {
        role: "Manager",
        salary: 110_000,
      });
      await store.edges.worksAt.create(requireDefined(people[3]), alpha, {
        role: "Engineer",
        salary: 90_000,
      });
      await store.edges.worksAt.create(requireDefined(people[4]), alpha, {
        role: "Manager",
        salary: 110_000,
      });
      await store.edges.worksAt.create(requireDefined(people[5]), alpha, {
        role: "Designer",
        salary: 95_000,
      });

      const results = await store
        .query()
        .from("Company", "c")
        .optionalTraverse("worksAt", "e", { direction: "in" })
        .to("Person", "p")
        .groupByNode("c")
        .aggregate({
          companyName: field("c", "name"),
          employeeCount: count("p"),
        })
        .orderBy("employeeCount", "desc")
        .limit(2)
        .execute();

      expect(results).toHaveLength(2);
      expect(results[0]?.companyName).toBe(alpha.name);
      expect(results[0]?.employeeCount).toBe(3);
      expect(results[1]?.companyName).toBe(bravo.name);
      expect(results[1]?.employeeCount).toBe(2);
      // Sanity check that all four companies actually exist and Zeta truly
      // has zero employees, so a "coincidental pass" isn't hiding a bug.
      expect(zeta.name).toBe("Zeta Corp");
      expect(yankee.name).toBe("Yankee Corp");
    });
  });

  describe("count/countDistinct with field argument", () => {
    beforeEach(async () => {
      const store = context.getStore();
      await seedAggregateProducts(store);
    });

    it("count(alias, field) counts non-null field values, not node IDs", async () => {
      const store = context.getStore();

      // All 5 products have a category, so count("p", "category") should equal count("p")
      const results = await store
        .query()
        .from("Product", "p")
        .aggregate({
          totalById: count("p"),
          totalByCategory: count("p", "category"),
        })
        .execute();

      expect(results).toHaveLength(1);
      expect(results[0]?.totalById).toBe(5);
      expect(results[0]?.totalByCategory).toBe(5);
    });

    it("countDistinct(alias, field) counts distinct field values", async () => {
      const store = context.getStore();

      // 5 products across 2 categories: Electronics (3), Furniture (2)
      const results = await store
        .query()
        .from("Product", "p")
        .aggregate({
          totalProducts: count("p"),
          uniqueCategories: countDistinct("p", "category"),
        })
        .execute();

      expect(results).toHaveLength(1);
      expect(results[0]?.totalProducts).toBe(5);
      expect(results[0]?.uniqueCategories).toBe(2);
    });

    it("countDistinct(alias) counts distinct node IDs", async () => {
      const store = context.getStore();

      const results = await store
        .query()
        .from("Product", "p")
        .aggregate({
          distinctProducts: countDistinct("p"),
        })
        .execute();

      expect(results).toHaveLength(1);
      // Each product has a unique ID, so countDistinct("p") === count("p")
      expect(results[0]?.distinctProducts).toBe(5);
    });

    it("countDistinct(alias, field) with groupBy returns correct counts per group", async () => {
      const store = context.getStore();

      // Group by category, count distinct inStock values within each group
      // Electronics: Laptop(true), Phone(true), Tablet(false) → 2 distinct inStock values
      // Furniture: Desk(true), Chair(true) → 1 distinct inStock value
      const results = await store
        .query()
        .from("Product", "p")
        .groupBy("p", "category")
        .aggregate({
          category: field("p", "category"),
          productCount: count("p"),
          uniqueStockStatuses: countDistinct("p", "inStock"),
        })
        .execute();

      expect(results).toHaveLength(2);

      const electronics = results.find((r) => r.category === "Electronics");
      const furniture = results.find((r) => r.category === "Furniture");

      expect(electronics?.productCount).toBe(3);
      expect(electronics?.uniqueStockStatuses).toBe(2);

      expect(furniture?.productCount).toBe(2);
      expect(furniture?.uniqueStockStatuses).toBe(1);
    });

    it("count(alias, field) with traversal and groupByNode", async () => {
      const store = context.getStore();

      const acme = await store.nodes.Company.create({
        name: "Acme Corp",
        industry: "Tech",
      });
      const globex = await store.nodes.Company.create({
        name: "Globex",
        industry: "Finance",
      });

      const alice = await store.nodes.Person.create({
        name: "Alice",
        email: "alice@example.com",
      });
      const bob = await store.nodes.Person.create({ name: "Bob" }); // no email
      const charlie = await store.nodes.Person.create({
        name: "Charlie",
        email: "charlie@example.com",
      });

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

      // count("p", "email") should count non-null email values per company
      const results = await store
        .query()
        .from("Company", "c")
        .traverse("worksAt", "e", { direction: "in" })
        .to("Person", "p")
        .groupByNode("c")
        .aggregate({
          companyName: field("c", "name"),
          employeeCount: count("p"),
          emailCount: count("p", "email"),
        })
        .execute();

      expect(results).toHaveLength(2);

      const acmeResult = results.find((r) => r.companyName === "Acme Corp");
      const globexResult = results.find((r) => r.companyName === "Globex");

      // Acme has Alice (with email) and Bob (no email)
      expect(acmeResult?.employeeCount).toBe(2);
      expect(acmeResult?.emailCount).toBe(1);

      // Globex has Charlie (with email)
      expect(globexResult?.employeeCount).toBe(1);
      expect(globexResult?.emailCount).toBe(1);
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
        .aggregate({
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
        .aggregate({
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
        .aggregate({
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
        .aggregate({
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
        .aggregate({
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
        .aggregate({
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
