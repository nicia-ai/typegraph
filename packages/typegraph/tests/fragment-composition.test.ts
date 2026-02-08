/**
 * Fragment Composition Tests
 *
 * Tests for the query fragment composition API that enables reusable
 * query transformations via the pipe() method.
 */
import { type SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  buildKindRegistry,
  composeFragments,
  createFragment,
  createQueryBuilder,
  defineEdge,
  defineGraph,
  defineNode,
  limitFragment,
  offsetFragment,
  orderByFragment,
} from "../src";
import { compileQuery } from "../src/query/compiler";

/**
 * Helper to extract SQL string and params from a Drizzle SQL object.
 */
function sqlToStrings(
  sqlObject: SQL,
  dialect: "sqlite" | "postgres" = "sqlite",
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  let parameterIndex = 1;

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
    params.push(object);
    return dialect === "postgres" ? `$${parameterIndex++}` : "?";
  }

  const sqlString = flatten(sqlObject);
  return { sql: sqlString, params };
}

const User = defineNode("User", {
  schema: z.object({
    name: z.string(),
    email: z.email(),
    status: z.enum(["active", "inactive", "pending"]),
    createdAt: z.string(),
  }),
});

const Post = defineNode("Post", {
  schema: z.object({
    title: z.string(),
    content: z.string(),
    published: z.boolean(),
  }),
});

const authored = defineEdge("authored", {
  schema: z.object({}),
});

const graph = defineGraph({
  id: "test_graph",
  nodes: {
    User: { type: User },
    Post: { type: Post },
  },
  edges: {
    authored: {
      type: authored,
      from: [User],
      to: [Post],
    },
  },
});

const registry = buildKindRegistry(graph);

// Test helper fragments defined at module scope (unicorn/consistent-function-scoping)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const activeOnlyFragment = (q: any) =>
  q.whereNode("u", ({ status }: { status: { eq: (v: string) => unknown } }) =>
    status.eq("active"),
  );

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const recentFirstFragment = (q: any) => q.orderBy("u", "createdAt", "desc");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const limitResultsFragment = (q: any) => q.limit(10);

describe("Fragment Composition", () => {
  describe("pipe() method on QueryBuilder", () => {
    it("applies a simple filter fragment", () => {
      // Fragment as inline function
      const query = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("User", "u")
        .pipe((q) => q.whereNode("u", ({ status }) => status.eq("active")))
        .select((ctx) => ctx.u);

      const ast = query.toAst();
      expect(ast.predicates).toHaveLength(1);
      expect(ast.predicates[0]?.targetAlias).toBe("u");
    });

    it("chains multiple inline fragments", () => {
      const query = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("User", "u")
        .pipe((q) => q.whereNode("u", ({ status }) => status.eq("active")))
        .pipe((q) => q.orderBy("u", "createdAt", "desc"))
        .select((ctx) => ctx.u);

      const ast = query.toAst();
      expect(ast.predicates).toHaveLength(1);
      expect(ast.orderBy).toHaveLength(1);
      expect(ast.orderBy?.[0]?.direction).toBe("desc");
    });

    it("applies fragments that add traversals", () => {
      const query = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("User", "u")
        .pipe((q) => q.traverse("authored", "a").to("Post", "post"))
        .select((ctx) => ({ user: ctx.u, post: ctx.post }));

      const ast = query.toAst();
      expect(ast.traversals).toHaveLength(1);
      expect(ast.traversals[0]?.edgeKinds).toContain("authored");
      expect(ast.traversals[0]?.nodeKinds).toContain("Post");
    });
  });

  describe("createFragment() factory", () => {
    it("creates a typed fragment factory", () => {
      // Verify the factory returns a function
      const fragment = createFragment<typeof graph>();
      expect(typeof fragment).toBe("function");
    });

    it("fragment factory produces working fragments at runtime", () => {
      const fragment = createFragment<typeof graph>();

      // Define a filter fragment - use any to bypass complex type inference
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const activeOnly = fragment((q: any) =>
        q.whereNode(
          "u",
          ({ status }: { status: { eq: (v: string) => unknown } }) =>
            status.eq("active"),
        ),
      );

      // Apply it via pipe
      const query = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("User", "u")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .pipe(activeOnly as any)
        .select((ctx) => ctx.u);

      const ast = query.toAst();
      expect(ast.predicates).toHaveLength(1);
    });
  });

  describe("composeFragments()", () => {
    it("composes multiple fragments", () => {
      const combined = composeFragments(
        activeOnlyFragment,
        recentFirstFragment,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ) as any;

      const query = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("User", "u")
        .pipe(combined)
        .select((ctx) => ctx.u);

      const ast = query.toAst();
      expect(ast.predicates).toHaveLength(1);
      expect(ast.orderBy).toHaveLength(1);
    });

    it("composes three fragments", () => {
      const combined = composeFragments(
        activeOnlyFragment,
        recentFirstFragment,
        limitResultsFragment,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ) as any;

      const query = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("User", "u")
        .pipe(combined)
        .select((ctx) => ctx.u);

      const ast = query.toAst();
      expect(ast.predicates).toHaveLength(1);
      expect(ast.orderBy).toHaveLength(1);
      expect(ast.limit).toBe(10);
    });
  });

  describe("helper fragments", () => {
    it("limitFragment() adds a limit", () => {
      const query = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("User", "u")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .pipe(limitFragment(25) as any)
        .select((ctx) => ctx.u);

      const ast = query.toAst();
      expect(ast.limit).toBe(25);
    });

    it("offsetFragment() adds an offset", () => {
      const query = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("User", "u")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .pipe(offsetFragment(50) as any)
        .select((ctx) => ctx.u);

      const ast = query.toAst();
      expect(ast.offset).toBe(50);
    });

    it("orderByFragment() adds ordering", () => {
      const query = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("User", "u")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .pipe(orderByFragment("u", "name", "asc") as any)
        .select((ctx) => ctx.u);

      const ast = query.toAst();
      expect(ast.orderBy).toHaveLength(1);
      expect(ast.orderBy?.[0]?.direction).toBe("asc");
    });

    it("combines helper fragments via composeFragments", () => {
      const paginated = composeFragments(
        orderByFragment("u", "createdAt", "desc"),
        limitFragment(20),
        offsetFragment(40),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ) as any;

      const query = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("User", "u")
        .pipe(paginated)
        .select((ctx) => ctx.u);

      const ast = query.toAst();
      expect(ast.orderBy).toHaveLength(1);
      expect(ast.limit).toBe(20);
      expect(ast.offset).toBe(40);
    });
  });

  describe("ExecutableQuery.pipe()", () => {
    it("applies transformations after select", () => {
      const query = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("User", "u")
        .select((ctx) => ctx.u)
        .pipe((q) => q.orderBy("u", "createdAt", "desc").limit(10));

      const ast = query.toAst();
      expect(ast.orderBy).toHaveLength(1);
      expect(ast.limit).toBe(10);
    });
  });

  describe("SQL compilation with fragments", () => {
    it("compiles fragments to correct SQL", () => {
      const query = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("User", "u")
        .pipe((q) => q.whereNode("u", ({ status }) => status.eq("active")))
        .pipe((q) => q.orderBy("u", "name", "asc"))
        .pipe((q) => q.limit(10))
        .select((ctx) => ctx.u);

      const ast = query.toAst();
      const compiled = compileQuery(ast, graph.id, "sqlite");
      const { sql, params } = sqlToStrings(compiled);

      // Verify the SQL contains expected clauses
      expect(sql).toContain("WHERE");
      expect(sql).toContain("ORDER BY");
      expect(sql).toContain("LIMIT");
      expect(params).toContain("active");
      expect(params).toContain(10);
    });
  });

  describe("type safety", () => {
    it("preserves alias types through pipe with traversals", () => {
      // This test verifies that after piping a traversal, both aliases are available
      const query = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("User", "u")
        .pipe((q) => q.traverse("authored", "a").to("Post", "p"))
        .select((ctx) => {
          // Both u and p should be accessible
          return {
            userName: ctx.u.name,
            postTitle: ctx.p.title,
          };
        });

      const ast = query.toAst();
      expect(ast.traversals).toHaveLength(1);
    });
  });
});
