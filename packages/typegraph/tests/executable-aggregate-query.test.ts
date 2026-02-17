/**
 * Unit tests for ExecutableAggregateQuery.
 *
 * Tests the aggregate query builder that supports aggregate functions like
 * count, sum, avg, min, max with groupBy and having clauses.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  avg,
  count,
  createQueryBuilder,
  defineGraph,
  defineNode,
  field,
  sum,
} from "../src";
import { buildKindRegistry } from "../src/registry";
import { toSqlString } from "./sql-test-utils";

// Test schema definitions
const Product = defineNode("Product", {
  schema: z.object({
    name: z.string(),
    price: z.number(),
    category: z.string(),
    quantity: z.number(),
  }),
});

const graph = defineGraph({
  id: "aggregate_test",
  nodes: {
    Product: { type: Product },
  },
  edges: {},
});

const registry = buildKindRegistry(graph);

// ============================================================
// ExecutableAggregateQuery toAst
// ============================================================

describe("ExecutableAggregateQuery.toAst", () => {
  it("generates AST with groupBy and aggregate fields", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Product", "p")
      .groupBy("p", "category")
      .aggregate({
        category: field("p", "category"),
        totalQuantity: sum("p", "quantity"),
        productCount: count("p"),
      });

    const ast = query.toAst();

    expect(ast.graphId).toBe("aggregate_test");
    expect(ast.start.alias).toBe("p");
    expect(ast.start.kinds).toEqual(["Product"]);
    expect(ast.groupBy).toBeDefined();
    expect(ast.groupBy!.fields).toHaveLength(1);
  });

  it("includes predicates in AST", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Product", "p")
      .whereNode("p", (p) => p.price.gt(100))
      .groupBy("p", "category")
      .aggregate({
        category: field("p", "category"),
        count: count("p"),
      });

    const ast = query.toAst();

    expect(ast.predicates).toHaveLength(1);
    expect(ast.predicates[0]?.targetAlias).toBe("p");
  });
});

// ============================================================
// ExecutableAggregateQuery limit/offset
// ============================================================

describe("ExecutableAggregateQuery.limit", () => {
  it("returns new query with limit", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Product", "p")
      .groupBy("p", "category")
      .aggregate({
        category: field("p", "category"),
        count: count("p"),
      });

    const limited = query.limit(10);
    const ast = limited.toAst();

    expect(ast.limit).toBe(10);
  });

  it("does not mutate original query", () => {
    const original = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Product", "p")
      .groupBy("p", "category")
      .aggregate({
        category: field("p", "category"),
        count: count("p"),
      });

    const limited = original.limit(10);

    expect(original.toAst().limit).toBeUndefined();
    expect(limited.toAst().limit).toBe(10);
  });

  it("allows chaining with offset", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Product", "p")
      .groupBy("p", "category")
      .aggregate({
        category: field("p", "category"),
        count: count("p"),
      })
      .limit(10)
      .offset(20);

    const ast = query.toAst();

    expect(ast.limit).toBe(10);
    expect(ast.offset).toBe(20);
  });
});

describe("ExecutableAggregateQuery.offset", () => {
  it("returns new query with offset", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Product", "p")
      .groupBy("p", "category")
      .aggregate({
        category: field("p", "category"),
        count: count("p"),
      })
      .offset(5);

    const ast = query.toAst();

    expect(ast.offset).toBe(5);
  });

  it("does not mutate original query", () => {
    const original = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Product", "p")
      .groupBy("p", "category")
      .aggregate({
        category: field("p", "category"),
        count: count("p"),
      });

    const withOffset = original.offset(5);

    expect(original.toAst().offset).toBeUndefined();
    expect(withOffset.toAst().offset).toBe(5);
  });
});

// ============================================================
// ExecutableAggregateQuery compile
// ============================================================

describe("ExecutableAggregateQuery.compile", () => {
  it("compiles to SQL with GROUP BY", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Product", "p")
      .groupBy("p", "category")
      .aggregate({
        category: field("p", "category"),
        count: count("p"),
      });

    const sql = query.compile();
    const sqlString = toSqlString(sql);

    expect(sqlString).toContain("SELECT");
    expect(sqlString).toContain("GROUP BY");
  });

  it("reuses cached compiled SQL for repeated compile calls", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Product", "p")
      .groupBy("p", "category")
      .aggregate({
        category: field("p", "category"),
        count: count("p"),
      });

    const firstCompile = query.compile();
    const secondCompile = query.compile();

    expect(secondCompile).toBe(firstCompile);
  });

  it("includes LIMIT and OFFSET in compiled SQL", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Product", "p")
      .groupBy("p", "category")
      .aggregate({
        category: field("p", "category"),
        count: count("p"),
      })
      .limit(10)
      .offset(5);

    const sql = query.compile();
    const sqlString = toSqlString(sql);

    expect(sqlString).toContain("LIMIT");
    expect(sqlString).toContain("OFFSET");
  });
});

// ============================================================
// ExecutableAggregateQuery execute
// ============================================================

describe("ExecutableAggregateQuery.execute", () => {
  it("throws error when no backend is configured", async () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Product", "p")
      .groupBy("p", "category")
      .aggregate({
        category: field("p", "category"),
        count: count("p"),
      });

    await expect(query.execute()).rejects.toThrow(
      "Cannot execute query: no backend configured",
    );
  });

  it("throws error with helpful message about store.query", async () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Product", "p")
      .groupBy("p", "category")
      .aggregate({
        category: field("p", "category"),
        count: count("p"),
      });

    await expect(query.execute()).rejects.toThrow(
      "Use store.query() or pass a backend to createQueryBuilder()",
    );
  });

  it("executes query with mock backend", async () => {
    const mockBackend = {
      execute: vi.fn().mockResolvedValue([
        { category: "Electronics", count: 10 },
        { category: "Books", count: 25 },
      ]),
    };

    const query = createQueryBuilder<typeof graph>(graph.id, registry, {
      backend: mockBackend as never,
    })
      .from("Product", "p")
      .groupBy("p", "category")
      .aggregate({
        category: field("p", "category"),
        count: count("p"),
      });

    const results = await query.execute();

    expect(mockBackend.execute).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ category: "Electronics", count: 10 });
    expect(results[1]).toEqual({ category: "Books", count: 25 });
  });

  it("maps only requested fields from results", async () => {
    const mockBackend = {
      execute: vi
        .fn()
        .mockResolvedValue([
          { category: "Electronics", count: 10, extra: "ignored" },
        ]),
    };

    const query = createQueryBuilder<typeof graph>(graph.id, registry, {
      backend: mockBackend as never,
    })
      .from("Product", "p")
      .groupBy("p", "category")
      .aggregate({
        category: field("p", "category"),
        count: count("p"),
      });

    const results = await query.execute();

    // Result should include only the fields specified in aggregate
    expect(results[0]).toHaveProperty("category");
    expect(results[0]).toHaveProperty("count");
  });

  it("handles empty result set", async () => {
    const mockBackend = {
      execute: vi.fn().mockResolvedValue([]),
    };

    const query = createQueryBuilder<typeof graph>(graph.id, registry, {
      backend: mockBackend as never,
    })
      .from("Product", "p")
      .groupBy("p", "category")
      .aggregate({
        category: field("p", "category"),
        count: count("p"),
      });

    const results = await query.execute();

    expect(results).toEqual([]);
  });
});

// ============================================================
// ExecutableAggregateQuery with multiple aggregates
// ============================================================

describe("ExecutableAggregateQuery with multiple aggregates", () => {
  it("supports multiple aggregate functions", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Product", "p")
      .groupBy("p", "category")
      .aggregate({
        category: field("p", "category"),
        totalQuantity: sum("p", "quantity"),
        productCount: count("p"),
        avgPrice: avg("p", "price"),
      });

    const ast = query.toAst();

    expect(ast.groupBy).toBeDefined();
    expect(ast.projection.fields).toBeDefined();
  });

  it("compiles multiple aggregates to SQL", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Product", "p")
      .groupBy("p", "category")
      .aggregate({
        category: field("p", "category"),
        totalQuantity: sum("p", "quantity"),
        productCount: count("p"),
      });

    const sql = query.compile();
    const sqlString = toSqlString(sql);

    expect(sqlString).toContain("SUM");
    expect(sqlString).toContain("COUNT");
  });
});

// ============================================================
// ExecutableAggregateQuery immutability
// ============================================================

describe("ExecutableAggregateQuery immutability", () => {
  it("limit returns new instance", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Product", "p")
      .groupBy("p", "category")
      .aggregate({
        category: field("p", "category"),
        count: count("p"),
      });

    const limited = query.limit(10);

    expect(limited).not.toBe(query);
  });

  it("offset returns new instance", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Product", "p")
      .groupBy("p", "category")
      .aggregate({
        category: field("p", "category"),
        count: count("p"),
      });

    const withOffset = query.offset(5);

    expect(withOffset).not.toBe(query);
  });

  it("allows independent modification of returned queries", () => {
    const base = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Product", "p")
      .groupBy("p", "category")
      .aggregate({
        category: field("p", "category"),
        count: count("p"),
      });

    const limit5 = base.limit(5);
    const limit10 = base.limit(10);

    expect(limit5.toAst().limit).toBe(5);
    expect(limit10.toAst().limit).toBe(10);
    expect(base.toAst().limit).toBeUndefined();
  });
});
