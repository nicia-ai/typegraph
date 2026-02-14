/**
 * Unit tests for UnionableQuery.
 *
 * Tests the set operation query builder that supports UNION, UNION ALL,
 * INTERSECT, and EXCEPT operations.
 */
import { type SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createQueryBuilder,
  defineGraph,
  defineNode,
  param as parameter,
} from "../src";
import { buildKindRegistry } from "../src/registry";

/**
 * Helper to extract SQL string from a Drizzle SQL object.
 */
function sqlToString(sqlObject: SQL): string {
  function flatten(object: unknown): string {
    if (
      typeof object === "object" &&
      object !== null &&
      "value" in object &&
      Array.isArray((object as { value: unknown }).value)
    ) {
      return (object as { value: string[] }).value.join("");
    }
    if (
      typeof object === "object" &&
      object !== null &&
      "queryChunks" in object &&
      Array.isArray((object as { queryChunks: unknown[] }).queryChunks)
    ) {
      return (object as { queryChunks: unknown[] }).queryChunks
        .map((c) => flatten(c))
        .join("");
    }
    return "?";
  }
  return flatten(sqlObject);
}

// Test schema definitions
const User = defineNode("User", {
  schema: z.object({
    name: z.string(),
    email: z.string(),
    age: z.number(),
    role: z.string(),
  }),
});

const Admin = defineNode("Admin", {
  schema: z.object({
    name: z.string(),
    email: z.string(),
    age: z.number(),
    role: z.string(),
    level: z.number(),
  }),
});

const graph = defineGraph({
  id: "union_test",
  nodes: {
    User: { type: User },
    Admin: { type: Admin },
  },
  edges: {},
});

const registry = buildKindRegistry(graph);

// ============================================================
// UnionableQuery.union
// ============================================================

describe("UnionableQuery.union", () => {
  it("creates a UNION query from two executable queries", () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .whereNode("u", (u) => u.role.eq("user"))
      .select((ctx) => ({ id: ctx.u.id, name: ctx.u.name }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .whereNode("u", (u) => u.role.eq("admin"))
      .select((ctx) => ({ id: ctx.u.id, name: ctx.u.name }));

    const unionQuery = q1.union(q2);
    const ast = unionQuery.toAst();

    expect(ast.__type).toBe("set_operation");
    expect(ast.operator).toBe("union");
  });

  it("allows chaining multiple unions", () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .whereNode("u", (u) => u.age.lt(30))
      .select((ctx) => ({ id: ctx.u.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .whereNode("u", (u) => u.age.between(30, 50))
      .select((ctx) => ({ id: ctx.u.id }));

    const q3 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .whereNode("u", (u) => u.age.gt(50))
      .select((ctx) => ({ id: ctx.u.id }));

    const unionQuery = q1.union(q2).union(q3);
    const ast = unionQuery.toAst();

    // The result is a set operation where left is itself a set operation
    expect(ast.__type).toBe("set_operation");
    expect(ast.operator).toBe("union");
    expect("__type" in ast.left && ast.left.__type).toBe("set_operation");
  });
});

// ============================================================
// UnionableQuery.unionAll
// ============================================================

describe("UnionableQuery.unionAll", () => {
  it("creates a UNION ALL query", () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .whereNode("u", (u) => u.role.eq("user"))
      .select((ctx) => ({ id: ctx.u.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .whereNode("u", (u) => u.role.eq("guest"))
      .select((ctx) => ({ id: ctx.u.id }));

    const unionAllQuery = q1.unionAll(q2);
    const ast = unionAllQuery.toAst();

    expect(ast.__type).toBe("set_operation");
    expect(ast.operator).toBe("unionAll");
  });

  it("can be chained after union", () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const q3 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const mixed = q1.union(q2).unionAll(q3);
    const ast = mixed.toAst();

    expect(ast.operator).toBe("unionAll");
  });
});

// ============================================================
// UnionableQuery.intersect
// ============================================================

describe("UnionableQuery.intersect", () => {
  it("creates an INTERSECT query", () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .whereNode("u", (u) => u.age.gt(25))
      .select((ctx) => ({ id: ctx.u.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .whereNode("u", (u) => u.role.eq("admin"))
      .select((ctx) => ({ id: ctx.u.id }));

    const intersectQuery = q1.intersect(q2);
    const ast = intersectQuery.toAst();

    expect(ast.__type).toBe("set_operation");
    expect(ast.operator).toBe("intersect");
  });
});

// ============================================================
// UnionableQuery.except
// ============================================================

describe("UnionableQuery.except", () => {
  it("creates an EXCEPT query", () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .whereNode("u", (u) => u.role.eq("banned"))
      .select((ctx) => ({ id: ctx.u.id }));

    const exceptQuery = q1.except(q2);
    const ast = exceptQuery.toAst();

    expect(ast.__type).toBe("set_operation");
    expect(ast.operator).toBe("except");
  });
});

// ============================================================
// UnionableQuery.limit
// ============================================================

describe("UnionableQuery.limit", () => {
  it("adds limit to combined query", () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const unionQuery = q1.union(q2).limit(10);
    const ast = unionQuery.toAst();

    expect(ast.limit).toBe(10);
  });

  it("returns new instance (immutable)", () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const unionQuery = q1.union(q2);
    const limited = unionQuery.limit(10);

    expect(limited).not.toBe(unionQuery);
    expect(unionQuery.toAst().limit).toBeUndefined();
    expect(limited.toAst().limit).toBe(10);
  });
});

// ============================================================
// UnionableQuery.offset
// ============================================================

describe("UnionableQuery.offset", () => {
  it("adds offset to combined query", () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const unionQuery = q1.union(q2).offset(5);
    const ast = unionQuery.toAst();

    expect(ast.offset).toBe(5);
  });

  it("returns new instance (immutable)", () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const unionQuery = q1.union(q2);
    const withOffset = unionQuery.offset(5);

    expect(withOffset).not.toBe(unionQuery);
    expect(unionQuery.toAst().offset).toBeUndefined();
    expect(withOffset.toAst().offset).toBe(5);
  });

  it("can be combined with limit", () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const unionQuery = q1.union(q2).limit(10).offset(20);
    const ast = unionQuery.toAst();

    expect(ast.limit).toBe(10);
    expect(ast.offset).toBe(20);
  });
});

// ============================================================
// UnionableQuery.toAst
// ============================================================

describe("UnionableQuery.toAst", () => {
  it("returns valid SetOperation AST", () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const ast = q1.union(q2).toAst();

    expect(ast.__type).toBe("set_operation");
    expect(ast.operator).toBeDefined();
    expect(ast.left).toBeDefined();
    expect(ast.right).toBeDefined();
  });

  it("preserves left and right queries", () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .whereNode("u", (u) => u.name.eq("Alice"))
      .select((ctx) => ({ id: ctx.u.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .whereNode("u", (u) => u.name.eq("Bob"))
      .select((ctx) => ({ id: ctx.u.id }));

    const ast = q1.union(q2).toAst();

    // Left should be a QueryAst (not a set operation)
    expect(ast.left).toHaveProperty("graphId");
    expect(ast.right).toHaveProperty("graphId");
  });

  it("does not include limit/offset when not set", () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const ast = q1.union(q2).toAst();

    expect(ast.limit).toBeUndefined();
    expect(ast.offset).toBeUndefined();
  });
});

// ============================================================
// UnionableQuery.compile
// ============================================================

describe("UnionableQuery.compile", () => {
  it("compiles UNION to SQL", () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const sql = q1.union(q2).compile();
    const sqlString = sqlToString(sql);

    expect(sqlString).toContain("UNION");
  });

  it("reuses cached compiled SQL for repeated compile calls", () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const unionQuery = q1.union(q2);
    const firstCompile = unionQuery.compile();
    const secondCompile = unionQuery.compile();

    expect(secondCompile).toBe(firstCompile);
  });

  it("compiles UNION ALL to SQL", () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const sql = q1.unionAll(q2).compile();
    const sqlString = sqlToString(sql);

    expect(sqlString).toContain("UNION ALL");
  });

  it("compiles INTERSECT to SQL", () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const sql = q1.intersect(q2).compile();
    const sqlString = sqlToString(sql);

    expect(sqlString).toContain("INTERSECT");
  });

  it("compiles EXCEPT to SQL", () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const sql = q1.except(q2).compile();
    const sqlString = sqlToString(sql);

    expect(sqlString).toContain("EXCEPT");
  });

  it("includes LIMIT in compiled SQL", () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const sql = q1.union(q2).limit(10).compile();
    const sqlString = sqlToString(sql);

    expect(sqlString).toContain("LIMIT");
  });

  it("includes OFFSET in compiled SQL", () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const sql = q1.union(q2).offset(5).compile();
    const sqlString = sqlToString(sql);

    expect(sqlString).toContain("OFFSET");
  });
});

// ============================================================
// UnionableQuery.execute
// ============================================================

describe("UnionableQuery.execute", () => {
  it("throws error when no backend is configured", async () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const unionQuery = q1.union(q2);

    await expect(unionQuery.execute()).rejects.toThrow(
      "Cannot execute query: no backend configured",
    );
  });

  it("throws error with helpful message about store.query", async () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const unionQuery = q1.union(q2);

    await expect(unionQuery.execute()).rejects.toThrow(
      "Use store.query() or pass a backend to createQueryBuilder()",
    );
  });

  it("executes query with mock backend", async () => {
    // Mock returns database-style rows with prefixed columns
    const mockBackend = {
      execute: vi.fn().mockResolvedValue([
        {
          u_id: "user-1",
          u_kind: "User",
          u_props: "{}",
          u_version: 1,
          u_valid_from: undefined,
          u_valid_to: undefined,
          u_created_at: "2024-01-01",
          u_updated_at: "2024-01-01",
          u_deleted_at: undefined,
        },
        {
          u_id: "user-2",
          u_kind: "User",
          u_props: "{}",
          u_version: 1,
          u_valid_from: undefined,
          u_valid_to: undefined,
          u_created_at: "2024-01-01",
          u_updated_at: "2024-01-01",
          u_deleted_at: undefined,
        },
        {
          u_id: "user-3",
          u_kind: "User",
          u_props: "{}",
          u_version: 1,
          u_valid_from: undefined,
          u_valid_to: undefined,
          u_created_at: "2024-01-01",
          u_updated_at: "2024-01-01",
          u_deleted_at: undefined,
        },
      ]),
    };

    const q1 = createQueryBuilder<typeof graph>(graph.id, registry, {
      backend: mockBackend as never,
    })
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry, {
      backend: mockBackend as never,
    })
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const results = await q1.union(q2).execute();

    expect(mockBackend.execute).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ id: "user-1" });
  });

  it("handles empty result set", async () => {
    const mockBackend = {
      execute: vi.fn().mockResolvedValue([]),
    };

    const q1 = createQueryBuilder<typeof graph>(graph.id, registry, {
      backend: mockBackend as never,
    })
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry, {
      backend: mockBackend as never,
    })
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const results = await q1.union(q2).execute();

    expect(results).toEqual([]);
  });
});

// ============================================================
// UnionableQuery complex scenarios
// ============================================================

describe("UnionableQuery complex scenarios", () => {
  it("supports mixed set operations", () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const q3 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    // (q1 UNION q2) INTERSECT q3
    const complex = q1.union(q2).intersect(q3);
    const ast = complex.toAst();

    expect(ast.operator).toBe("intersect");
    expect("__type" in ast.left && ast.left.__type).toBe("set_operation");
  });

  it("supports pagination on chained operations", () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const q3 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const paginated = q1.union(q2).union(q3).limit(10).offset(20);
    const ast = paginated.toAst();

    expect(ast.limit).toBe(10);
    expect(ast.offset).toBe(20);
  });

  it("rejects execute() when any leaf query contains param() references", async () => {
    const mockBackend = {
      dialect: "sqlite" as const,
      execute: vi.fn(),
    };

    const q1 = createQueryBuilder<typeof graph>(graph.id, registry, {
      backend: mockBackend as never,
      dialect: "sqlite",
    })
      .from("User", "u")
      .whereNode("u", (u) => u.name.eq(parameter("name")))
      .select((ctx) => ({ id: ctx.u.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry, {
      backend: mockBackend as never,
      dialect: "sqlite",
    })
      .from("User", "u")
      .select((ctx) => ({ id: ctx.u.id }));

    const combined = q1.union(q2);

    await expect(combined.execute()).rejects.toThrow(
      "Query contains param() references",
    );
    expect(mockBackend.execute).not.toHaveBeenCalled();
  });
});
