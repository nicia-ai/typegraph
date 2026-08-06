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

import {
  avg,
  count,
  ENTITY_ALREADY_EXISTS_CODE,
  max,
  min,
  sum,
  ValidationError,
} from "../../../src";
import { requireDefined } from "../../../src/utils/presence";
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
        .aggregate({ total: count("p") })
        .execute();

      expect(requireDefined(results[0]).total).toBe(0);
    });

    it("sum returns null for empty result set", async () => {
      const store = context.getStore();

      const results = await store
        .query()
        .from("Product", "p")
        .whereNode("p", (p) => p.category.eq("NonExistent"))
        .aggregate({ total: sum("p", "price") })
        .execute();

      // SQL SUM of empty set returns NULL
      expect(requireDefined(results[0]).total).toBeNull();
    });

    it("avg returns null for empty result set", async () => {
      const store = context.getStore();

      const results = await store
        .query()
        .from("Product", "p")
        .whereNode("p", (p) => p.category.eq("NonExistent"))
        .aggregate({ average: avg("p", "price") })
        .execute();

      expect(requireDefined(results[0]).average).toBeNull();
    });

    it("min/max return null for empty result set", async () => {
      const store = context.getStore();

      const results = await store
        .query()
        .from("Product", "p")
        .whereNode("p", (p) => p.category.eq("NonExistent"))
        .aggregate({
          minPrice: min("p", "price"),
          maxPrice: max("p", "price"),
        })
        .execute();

      expect(requireDefined(results[0]).minPrice).toBeNull();
      expect(requireDefined(results[0]).maxPrice).toBeNull();
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
      expect(requireDefined(results[0]).name).toBe("Without Rating");
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
      expect(requireDefined(results[0]).name).toBe("With Rating");
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
      expect(requireDefined(results[0]).name).toBe("C");
      expect(requireDefined(results[1]).name).toBe("D");
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
        expect(requireDefined(result[0]).name).toBe("Test");
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
// Duplicate Identity Tests
// ============================================================

/**
 * A create refused because the id is taken carries
 * {@link ENTITY_ALREADY_EXISTS_CODE}, on EVERY backend and whichever layer
 * noticed.
 *
 * The two cases below deliberately reach the refusal through DIFFERENT layers,
 * and must still be indistinguishable to a caller. A node create probes for the
 * id first, so its own probe refuses. An edge create has no probe — its id is
 * caller-supplied or freshly generated — so the ENGINE refuses and the failure is
 * classified back into this error.
 *
 * Running both on every backend is the point: the engine leg is where the two
 * dialects could drift, since PostgreSQL and SQLite report a duplicate primary
 * key through entirely different structures. Losing a genuine race to the engine
 * (PostgreSQL only — SQLite serializes writers at `BEGIN IMMEDIATE`) is covered
 * by `tests/backends/postgres/concurrent-create-duplicate-key.test.ts` (#410).
 */
/**
 * Asserts a rejection is the already-exists refusal, identified by its stable
 * issue code rather than by message text, and naming the id it lost on.
 */
async function expectAlreadyExists(
  operation: Promise<unknown>,
  expected: Readonly<{
    entityType: "node" | "edge";
    kind: string;
    id: string;
  }>,
): Promise<void> {
  const error = await operation.catch((error_: unknown) => error_);
  expect(error).toBeInstanceOf(ValidationError);
  const validation = error as ValidationError;
  expect(validation.details.issues.map((issue) => issue.code)).toContain(
    ENTITY_ALREADY_EXISTS_CODE,
  );
  expect(validation.details.entityType).toBe(expected.entityType);
  expect(validation.details.kind).toBe(expected.kind);
  expect(validation.details.id).toBe(expected.id);
  expect(validation.details.operation).toBe("create");
}

function registerDuplicateIdentityTests(context: IntegrationTestContext): void {
  describe("Duplicate Identity", () => {
    it("refuses a node create on a taken id with the stable code", async () => {
      const store = context.getStore();
      const created = await store.nodes.Product.create({
        name: "Taken",
        price: 1,
        category: "A",
      });

      await expectAlreadyExists(
        store.nodes.Product.create(
          { name: "Second", price: 2, category: "A" },
          { id: created.id },
        ),
        { entityType: "node", kind: "Product", id: created.id },
      );
    });

    it("refuses an edge create on a taken id with the stable code", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const created = await store.edges.knows.create(alice, bob, {
        since: "first",
      });

      await expectAlreadyExists(
        store.edges.knows.create(
          alice,
          bob,
          { since: "second" },
          { id: created.id },
        ),
        { entityType: "edge", kind: "knows", id: created.id },
      );
    });

    it("names the refused insert, not a row, when it wrote more than one edge", async () => {
      // The one shape whose `details.id` is absent, and it needs no race: a bulk
      // edge create writes several rows in ONE statement, nothing probes the
      // caller-supplied ids, and the engine reports that the statement collided
      // without saying which row did. Same error, same code, `id` omitted rather
      // than guessed.
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const taken = await store.edges.knows.create(alice, bob, {
        since: "first",
      });

      const refused = store.edges.knows.bulkCreate([
        { from: alice, to: bob, props: { since: "fresh" }, id: "bulk-fresh" },
        { from: alice, to: bob, props: { since: "clash" }, id: taken.id },
      ]);

      const error = await refused.catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(ValidationError);
      const validation = error as ValidationError;
      expect(validation.details.issues.map((issue) => issue.code)).toContain(
        ENTITY_ALREADY_EXISTS_CODE,
      );
      expect(validation.details.entityType).toBe("edge");
      expect(validation.details.kind).toBe("knows");
      expect(validation.details.operation).toBe("create");
      expect(validation.details.id).toBeUndefined();
      expect(validation.message).toContain("one of the 2 knows ids");
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
  registerDuplicateIdentityTests(context);
}
