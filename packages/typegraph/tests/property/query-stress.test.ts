/**
 * Property-Based Stress Tests for Query Building
 *
 * Tests query builder invariants with larger datasets and edge cases.
 * These tests verify that the query builder behaves correctly under
 * stress conditions that might not be caught by unit tests.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  buildKindRegistry,
  count,
  createQueryBuilder,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  sum,
} from "../../src";
import { createTestBackend } from "../test-utils";
import { sortDirectionArb, unicodeStringArb } from "./arbitraries";

// ============================================================
// Test Graph
// ============================================================

const TestNode = defineNode("TestNode", {
  schema: z.object({
    name: z.string(),
    value: z.number().optional(),
    category: z.string().optional(),
    tags: z.array(z.string()).optional(),
    metadata: z
      .object({
        score: z.number().optional(),
        label: z.string().optional(),
      })
      .optional(),
  }),
});

const connects = defineEdge("connects", {
  schema: z.object({
    weight: z.number().optional(),
  }),
});

const testGraph = defineGraph({
  id: "query_stress_test",
  nodes: {
    TestNode: { type: TestNode },
  },
  edges: {
    connects: {
      type: connects,
      from: [TestNode],
      to: [TestNode],
    },
  },
});

const registry = buildKindRegistry(testGraph);

// ============================================================
// Query Builder Invariants
// ============================================================

describe("Query Builder Invariants", () => {
  describe("ordering invariants", () => {
    it("maintains order specification through chaining", () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              field: fc.constantFrom("name", "value", "category"),
              direction: sortDirectionArb,
            }),
            { minLength: 1, maxLength: 5 },
          ),
          (orderSpecs) => {
            let query = createQueryBuilder<typeof testGraph>(
              testGraph.id,
              registry,
            ).from("TestNode", "n");

            for (const spec of orderSpecs) {
              // Use the string-based orderBy API
              query = query.orderBy("n", spec.field, spec.direction);
            }

            const ast = query.select((ctx) => ({ id: ctx.n.id })).toAst();

            // Each orderBy call should add to the order specification
            expect(ast.orderBy?.length).toBeGreaterThanOrEqual(
              orderSpecs.length,
            );
          },
        ),
        { numRuns: 50 },
      );
    });

    it("limit is always non-negative in AST", () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 10_000 }), (limit) => {
          const ast = createQueryBuilder<typeof testGraph>(
            testGraph.id,
            registry,
          )
            .from("TestNode", "n")
            .limit(limit)
            .select((ctx) => ({ id: ctx.n.id }))
            .toAst();

          expect(ast.limit).toBe(limit);
          expect(ast.limit).toBeGreaterThanOrEqual(0);
        }),
        { numRuns: 100 },
      );
    });

    it("offset is always non-negative in AST", () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 10_000 }), (offset) => {
          const ast = createQueryBuilder<typeof testGraph>(
            testGraph.id,
            registry,
          )
            .from("TestNode", "n")
            .offset(offset)
            .select((ctx) => ({ id: ctx.n.id }))
            .toAst();

          expect(ast.offset).toBe(offset);
          expect(ast.offset).toBeGreaterThanOrEqual(0);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe("predicate composition invariants", () => {
    it("chained where clauses are combined with AND", () => {
      fc.assert(
        fc.property(
          fc.array(fc.string({ minLength: 1, maxLength: 20 }), {
            minLength: 2,
            maxLength: 5,
          }),
          (values) => {
            let query = createQueryBuilder<typeof testGraph>(
              testGraph.id,
              registry,
            ).from("TestNode", "n");

            for (const value of values) {
              query = query.whereNode("n", (n) => n.name.eq(value));
            }

            const ast = query.select((ctx) => ({ id: ctx.n.id })).toAst();

            // Each where clause adds a predicate
            expect(ast.predicates.length).toBe(values.length);
          },
        ),
        { numRuns: 50 },
      );
    });
  });
});

// ============================================================
// Unicode and Special Character Handling
// ============================================================

describe("Unicode and Special Character Handling", () => {
  it("handles unicode strings in predicates", () => {
    fc.assert(
      fc.property(unicodeStringArb, (value) => {
        // Should not throw when building query with unicode values
        expect(() => {
          createQueryBuilder<typeof testGraph>(testGraph.id, registry)
            .from("TestNode", "n")
            .whereNode("n", (n) => n.name.eq(value))
            .select((ctx) => ({ name: ctx.n.name }))
            .compile();
        }).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it("handles unicode strings in select output", () => {
    fc.assert(
      fc.property(unicodeStringArb, (value) => {
        const query = createQueryBuilder<typeof testGraph>(
          testGraph.id,
          registry,
        )
          .from("TestNode", "n")
          .select((ctx) => ({
            name: ctx.n.name,
            literal: value,
          }));

        // Select function should handle any string value
        expect(() => query.compile()).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });
});

// ============================================================
// NULL Handling Invariants
// ============================================================

describe("NULL Handling Invariants", () => {
  it("isNull predicate compiles for optional fields", () => {
    fc.assert(
      fc.property(fc.boolean(), (checkNull) => {
        const query = createQueryBuilder<typeof testGraph>(
          testGraph.id,
          registry,
        )
          .from("TestNode", "n")
          .whereNode("n", (n) =>
            checkNull ? n.value.isNull() : n.value.isNotNull(),
          )
          .select((ctx) => ({ id: ctx.n.id }));

        expect(() => query.compile()).not.toThrow();
      }),
      { numRuns: 20 },
    );
  });
});

// ============================================================
// Large Dataset Execution Tests
// ============================================================

describe("Large Dataset Execution", () => {
  it("handles batch creation of many nodes", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 50, max: 200 }), async (nodeCount) => {
        const backend = createTestBackend();
        const store = createStore(testGraph, backend);

        // Create many nodes
        const nodes = await Promise.all(
          Array.from({ length: nodeCount }, (_, index) =>
            store.nodes.TestNode.create({
              name: `Node ${index}`,
              value: index,
              category: `cat_${index % 5}`,
            }),
          ),
        );

        expect(nodes).toHaveLength(nodeCount);

        // Query should return all nodes
        const results = await store
          .query()
          .from("TestNode", "n")
          .select((ctx) => ({ id: ctx.n.id }))
          .execute();

        expect(results).toHaveLength(nodeCount);
      }),
      { numRuns: 5 }, // Fewer runs due to I/O
    );
  });

  it("pagination works correctly with large datasets", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          totalNodes: fc.integer({ min: 20, max: 100 }),
          pageSize: fc.integer({ min: 5, max: 20 }),
        }),
        async ({ totalNodes, pageSize }) => {
          const backend = createTestBackend();
          const store = createStore(testGraph, backend);

          // Create nodes
          await Promise.all(
            Array.from({ length: totalNodes }, (_, index) =>
              store.nodes.TestNode.create({
                name: `Node ${index}`,
                value: index,
              }),
            ),
          );

          // Paginate through all results
          let allResults: unknown[] = [];
          let offset = 0;

          while (offset < totalNodes) {
            const page = await store
              .query()
              .from("TestNode", "n")
              .orderBy("n", "value", "asc")
              .limit(pageSize)
              .offset(offset)
              .select((ctx) => ({ id: ctx.n.id, value: ctx.n.value }))
              .execute();

            allResults = [...allResults, ...page];
            offset += pageSize;

            // Each page should have at most pageSize results
            expect(page.length).toBeLessThanOrEqual(pageSize);
          }

          // Should have collected all nodes
          expect(allResults.length).toBe(totalNodes);
        },
      ),
      { numRuns: 5 },
    );
  });

  it("aggregates work correctly with varying data", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            name: fc.string({ minLength: 1, maxLength: 20 }),
            value: fc.integer({ min: 0, max: 1000 }),
            category: fc.constantFrom("A", "B", "C"),
          }),
          { minLength: 10, maxLength: 50 },
        ),
        async (nodeData) => {
          const backend = createTestBackend();
          const store = createStore(testGraph, backend);

          // Create nodes
          await Promise.all(
            nodeData.map((data) => store.nodes.TestNode.create(data)),
          );

          // Count should match
          const countResult = await store
            .query()
            .from("TestNode", "n")
            .selectAggregate({
              total: count("n"),
            })
            .execute();

          expect(countResult[0]!.total).toBe(nodeData.length);

          // Sum should be correct
          const expectedSum = nodeData.reduce((accum, n) => accum + n.value, 0);
          const sumResult = await store
            .query()
            .from("TestNode", "n")
            .selectAggregate({
              total: sum("n", "value"),
            })
            .execute();

          expect(sumResult[0]!.total).toBe(expectedSum);
        },
      ),
      { numRuns: 5 },
    );
  });
});

// ============================================================
// Query Immutability
// ============================================================

describe("Query Immutability", () => {
  it("chained methods return new instances", () => {
    fc.assert(
      fc.property(
        fc.record({
          limit: fc.integer({ min: 1, max: 100 }),
          offset: fc.integer({ min: 0, max: 100 }),
        }),
        ({ limit, offset }) => {
          const base = createQueryBuilder<typeof testGraph>(
            testGraph.id,
            registry,
          )
            .from("TestNode", "n")
            .select((ctx) => ({ id: ctx.n.id }));

          const withLimit = base.limit(limit);
          const withOffset = base.offset(offset);
          const withBoth = base.limit(limit).offset(offset);

          // Each should be a different instance
          expect(withLimit).not.toBe(base);
          expect(withOffset).not.toBe(base);
          expect(withBoth).not.toBe(withLimit);

          // Original should be unmodified
          expect(base.toAst().limit).toBeUndefined();
          expect(base.toAst().offset).toBeUndefined();

          // New instances should have their modifications
          expect(withLimit.toAst().limit).toBe(limit);
          expect(withOffset.toAst().offset).toBe(offset);
        },
      ),
      { numRuns: 50 },
    );
  });
});
