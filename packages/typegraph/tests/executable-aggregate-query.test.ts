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
  countDistinct,
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
const MOCK_BACKEND_CAPABILITIES = {
  transactions: true,
  windowFunctions: true,
} as const;

/** Strips the millisecond-precision "current instant" bound in a compiled
 * temporal filter, so two genuinely fresh compiles of the same query can be
 * compared for structural equality. */
function normalizeTimestamps(sql: string): string {
  return sql.replaceAll(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g,
    "<timestamp>",
  );
}

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
// ExecutableAggregateQuery orderBy
// ============================================================

describe("ExecutableAggregateQuery.orderBy", () => {
  it("adds an aggregateOrderBy entry referencing the grouped field's output name", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Product", "p")
      .groupBy("p", "category")
      .aggregate({
        category: field("p", "category"),
        count: count("p"),
      })
      .orderBy("category", "asc");

    const ast = query.toAst();

    expect(ast.aggregateOrderBy).toEqual([
      { outputName: "category", direction: "asc" },
    ]);
  });

  it("adds an aggregateOrderBy entry referencing an aggregate alias", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Product", "p")
      .groupBy("p", "category")
      .aggregate({
        category: field("p", "category"),
        count: count("p"),
      })
      .orderBy("count", "desc");

    const ast = query.toAst();

    expect(ast.aggregateOrderBy).toEqual([
      { outputName: "count", direction: "desc" },
    ]);
  });

  it("defaults direction to asc", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Product", "p")
      .groupBy("p", "category")
      .aggregate({
        category: field("p", "category"),
        count: count("p"),
      })
      .orderBy("count");

    expect(query.toAst().aggregateOrderBy).toEqual([
      { outputName: "count", direction: "asc" },
    ]);
  });

  it("accumulates multiple orderBy calls in call order", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Product", "p")
      .groupBy("p", "category")
      .aggregate({
        category: field("p", "category"),
        count: count("p"),
      })
      .orderBy("category", "asc")
      .orderBy("count", "desc");

    expect(query.toAst().aggregateOrderBy).toEqual([
      { outputName: "category", direction: "asc" },
      { outputName: "count", direction: "desc" },
    ]);
  });

  it("does not mutate the original query", () => {
    const original = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Product", "p")
      .groupBy("p", "category")
      .aggregate({
        category: field("p", "category"),
        count: count("p"),
      });

    const ordered = original.orderBy("count", "desc");

    expect(ordered).not.toBe(original);
    expect(original.toAst().aggregateOrderBy).toBeUndefined();
    expect(ordered.toAst().aggregateOrderBy).toEqual([
      { outputName: "count", direction: "desc" },
    ]);
  });

  it("compiles to SQL with ORDER BY referencing the quoted output alias", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Product", "p")
      .groupBy("p", "category")
      .aggregate({
        category: field("p", "category"),
        productCount: count("p"),
      })
      .orderBy("productCount", "desc");

    const sqlString = toSqlString(query.compile());

    expect(sqlString).toContain("ORDER BY");
    expect(sqlString).toContain('"productCount"');
    expect(sqlString).toContain("DESC");
  });

  it("combines with limit to express top-N by aggregate", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Product", "p")
      .groupBy("p", "category")
      .aggregate({
        category: field("p", "category"),
        productCount: count("p"),
      })
      .orderBy("productCount", "desc")
      .limit(2);

    const sqlString = toSqlString(query.compile());

    expect(sqlString).toContain("ORDER BY");
    expect(sqlString).toContain("LIMIT");
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

  it("compiles equivalent SQL on repeated compile calls", () => {
    // Deliberately NOT cached across calls: a "current" temporal filter
    // binds its read instant at compile time, so caching the compiled
    // result would freeze "now" at the first call for the query's entire
    // lifetime (see PreparedQuery's class doc comment). Repeated calls
    // must still produce the same SQL shape — but the bound "now" value
    // itself may legitimately differ by a millisecond between two calls,
    // so timestamps are normalized before comparing.
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Product", "p")
      .groupBy("p", "category")
      .aggregate({
        category: field("p", "category"),
        count: count("p"),
      });

    const firstCompile = query.compile();
    const secondCompile = query.compile();

    expect(normalizeTimestamps(toSqlString(secondCompile))).toBe(
      normalizeTimestamps(toSqlString(firstCompile)),
    );
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
      capabilities: MOCK_BACKEND_CAPABILITIES,
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
      capabilities: MOCK_BACKEND_CAPABILITIES,
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
      capabilities: MOCK_BACKEND_CAPABILITIES,
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

// ============================================================
// count(alias, field) and countDistinct(alias, field) SQL compilation
// ============================================================

describe("count/countDistinct with field argument", () => {
  it("count(alias) compiles to COUNT(alias_id)", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Product", "p")
      .groupBy("p", "category")
      .aggregate({
        category: field("p", "category"),
        productCount: count("p"),
      });

    const sqlString = toSqlString(query.compile());

    expect(sqlString).toContain("COUNT(");
    // count("p") with no field arg should reference p_id
    expect(sqlString).toMatch(/COUNT\([^)]*p_id/);
  });

  it("count(alias, field) compiles to COUNT(json_extract(...)) not COUNT(alias_id)", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Product", "p")
      .groupBy("p", "category")
      .aggregate({
        category: field("p", "category"),
        nameCount: count("p", "name"),
      });

    const sqlString = toSqlString(query.compile());

    // Should reference the props column with json extraction, not _id
    expect(sqlString).toContain("p_props");
    expect(sqlString).toContain('"name"');
    expect(sqlString).toMatch(/COUNT\(/);
    // Should NOT fall back to counting by _id for this aggregate
    expect(sqlString).not.toMatch(/COUNT\([^)]*p_id/);
  });

  it("countDistinct(alias) compiles to COUNT(DISTINCT alias_id)", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Product", "p")
      .groupBy("p", "category")
      .aggregate({
        category: field("p", "category"),
        distinctProducts: countDistinct("p"),
      });

    const sqlString = toSqlString(query.compile());

    expect(sqlString).toContain("COUNT(DISTINCT");
    expect(sqlString).toContain("p_id");
  });

  it("countDistinct(alias, field) compiles to COUNT(DISTINCT json_extract(...)) not COUNT(DISTINCT alias_id)", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Product", "p")
      .groupBy("p", "category")
      .aggregate({
        category: field("p", "category"),
        uniqueNames: countDistinct("p", "name"),
      });

    const sqlString = toSqlString(query.compile());

    // Should reference the props column with json extraction
    expect(sqlString).toContain("COUNT(DISTINCT");
    expect(sqlString).toContain("p_props");
    expect(sqlString).toContain('"name"');
    // Should NOT fall back to counting distinct _id
    expect(sqlString).not.toMatch(/COUNT\(DISTINCT[^)]*p_id/);
  });

  it("count(alias, field) includes props in CTE columns", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Product", "p")
      .groupBy("p", "category")
      .aggregate({
        category: field("p", "category"),
        nameCount: count("p", "name"),
      });

    const sqlString = toSqlString(query.compile());

    // The CTE must include the _props column for json_extract to work
    expect(sqlString).toContain("p_props");
  });
});

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
