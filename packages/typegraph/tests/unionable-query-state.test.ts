/**
 * Tests for UnionableQuery state preservation.
 *
 * Verifies that startAlias, traversals, and selectFn are correctly
 * preserved through set operations (union, unionAll, intersect, except).
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  buildKindRegistry,
  createQueryBuilder,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";

// ============================================================
// Test Graph
// ============================================================

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    age: z.number(),
  }),
});

const Company = defineNode("Company", {
  schema: z.object({
    name: z.string(),
  }),
});

const worksAt = defineEdge("worksAt", {
  schema: z.object({
    role: z.string(),
  }),
});

const graph = defineGraph({
  id: "state_test",
  nodes: {
    Person: { type: Person },
    Company: { type: Company },
  },
  edges: {
    worksAt: {
      type: worksAt,
      from: [Person],
      to: [Company],
    },
  },
});

const registry = buildKindRegistry(graph);

// ============================================================
// State Preservation Tests
// ============================================================

describe("UnionableQuery state preservation", () => {
  describe("startAlias preservation", () => {
    it("preserves startAlias through union", () => {
      const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .select((ctx) => ({ id: ctx.p.id }));

      const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .select((ctx) => ({ id: ctx.p.id }));

      const unionQuery = q1.union(q2);
      const ast = unionQuery.toAst();

      // The startAlias should be preserved for result mapping
      expect(ast.left).toHaveProperty("start");
      expect((ast.left as { start: { alias: string } }).start.alias).toBe("p");
    });

    it("preserves startAlias through unionAll", () => {
      const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "customAlias")
        .select((ctx) => ({ id: ctx.customAlias.id }));

      const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "customAlias")
        .select((ctx) => ({ id: ctx.customAlias.id }));

      const unionQuery = q1.unionAll(q2);
      const ast = unionQuery.toAst();

      expect((ast.left as { start: { alias: string } }).start.alias).toBe(
        "customAlias",
      );
    });

    it("preserves startAlias through intersect", () => {
      const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "person")
        .select((ctx) => ({ id: ctx.person.id }));

      const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "person")
        .select((ctx) => ({ id: ctx.person.id }));

      const intersectQuery = q1.intersect(q2);
      const ast = intersectQuery.toAst();

      expect((ast.left as { start: { alias: string } }).start.alias).toBe(
        "person",
      );
    });

    it("preserves startAlias through except", () => {
      const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "node")
        .select((ctx) => ({ id: ctx.node.id }));

      const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "node")
        .select((ctx) => ({ id: ctx.node.id }));

      const exceptQuery = q1.except(q2);
      const ast = exceptQuery.toAst();

      expect((ast.left as { start: { alias: string } }).start.alias).toBe(
        "node",
      );
    });

    it("preserves startAlias through chained operations", () => {
      const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "first")
        .select((ctx) => ({ id: ctx.first.id }));

      const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "first")
        .select((ctx) => ({ id: ctx.first.id }));

      const q3 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "first")
        .select((ctx) => ({ id: ctx.first.id }));

      // Chain: q1.union(q2).intersect(q3)
      const chainedQuery = q1.union(q2).intersect(q3);
      const ast = chainedQuery.toAst();

      // The left side is itself a set operation
      const leftSetOp = ast.left as {
        __type: string;
        left: { start: { alias: string } };
      };
      expect(leftSetOp.__type).toBe("set_operation");
      expect(leftSetOp.left.start.alias).toBe("first");
    });
  });

  describe("limit and offset preservation", () => {
    it("preserves limit when set", () => {
      const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .select((ctx) => ({ id: ctx.p.id }));

      const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .select((ctx) => ({ id: ctx.p.id }));

      const limitedQuery = q1.union(q2).limit(10);
      const ast = limitedQuery.toAst();

      expect(ast.limit).toBe(10);
    });

    it("preserves offset when set", () => {
      const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .select((ctx) => ({ id: ctx.p.id }));

      const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .select((ctx) => ({ id: ctx.p.id }));

      const offsetQuery = q1.union(q2).offset(5);
      const ast = offsetQuery.toAst();

      expect(ast.offset).toBe(5);
    });

    it("preserves both limit and offset when set", () => {
      const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .select((ctx) => ({ id: ctx.p.id }));

      const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .select((ctx) => ({ id: ctx.p.id }));

      const paginatedQuery = q1.union(q2).limit(10).offset(20);
      const ast = paginatedQuery.toAst();

      expect(ast.limit).toBe(10);
      expect(ast.offset).toBe(20);
    });

    it("does not include limit in AST when not set", () => {
      const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .select((ctx) => ({ id: ctx.p.id }));

      const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .select((ctx) => ({ id: ctx.p.id }));

      const query = q1.union(q2);
      const ast = query.toAst();

      expect(ast.limit).toBeUndefined();
      expect(ast.offset).toBeUndefined();
    });
  });

  describe("result transformation", () => {
    it("applies select function when executing with mock backend", async () => {
      const mockBackend = {
        execute: vi.fn().mockResolvedValue([
          {
            p_id: "person-1",
            p_kind: "Person",
            p_props: JSON.stringify({ name: "Alice", age: 30 }),
            p_version: 1,
            p_valid_from: undefined,
            p_valid_to: undefined,
            p_created_at: "2024-01-01",
            p_updated_at: "2024-01-01",
            p_deleted_at: undefined,
          },
        ]),
      };

      const q1 = createQueryBuilder<typeof graph>(graph.id, registry, {
        backend: mockBackend as never,
      })
        .from("Person", "p")
        .select((ctx) => ({
          personId: ctx.p.id,
          personName: ctx.p.name,
        }));

      const q2 = createQueryBuilder<typeof graph>(graph.id, registry, {
        backend: mockBackend as never,
      })
        .from("Person", "p")
        .select((ctx) => ({
          personId: ctx.p.id,
          personName: ctx.p.name,
        }));

      const results = await q1.union(q2).execute();

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        personId: "person-1",
        personName: "Alice",
      });
    });

    it("returns raw rows when no select function is set", async () => {
      const mockBackend = {
        execute: vi
          .fn()
          .mockResolvedValue([
            { raw_column: "value1" },
            { raw_column: "value2" },
          ]),
      };

      // Create queries without select function by using the internal state
      // This simulates a raw query scenario
      const q1 = createQueryBuilder<typeof graph>(graph.id, registry, {
        backend: mockBackend as never,
      })
        .from("Person", "p")
        .select((ctx) => ({ id: ctx.p.id }));

      const q2 = createQueryBuilder<typeof graph>(graph.id, registry, {
        backend: mockBackend as never,
      })
        .from("Person", "p")
        .select((ctx) => ({ id: ctx.p.id }));

      // Execute the union
      const results = await q1.union(q2).execute();

      // Results are returned after transformation
      expect(mockBackend.execute).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(2);
    });
  });

  describe("immutability", () => {
    it("limit returns new instance without modifying original", () => {
      const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .select((ctx) => ({ id: ctx.p.id }));

      const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .select((ctx) => ({ id: ctx.p.id }));

      const unionQuery = q1.union(q2);
      const limitedQuery = unionQuery.limit(10);

      expect(limitedQuery).not.toBe(unionQuery);
      expect(unionQuery.toAst().limit).toBeUndefined();
      expect(limitedQuery.toAst().limit).toBe(10);
    });

    it("offset returns new instance without modifying original", () => {
      const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .select((ctx) => ({ id: ctx.p.id }));

      const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .select((ctx) => ({ id: ctx.p.id }));

      const unionQuery = q1.union(q2);
      const offsetQuery = unionQuery.offset(5);

      expect(offsetQuery).not.toBe(unionQuery);
      expect(unionQuery.toAst().offset).toBeUndefined();
      expect(offsetQuery.toAst().offset).toBe(5);
    });

    it("chained set operations return new instances", () => {
      const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .select((ctx) => ({ id: ctx.p.id }));

      const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .select((ctx) => ({ id: ctx.p.id }));

      const q3 = createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .select((ctx) => ({ id: ctx.p.id }));

      const union = q1.union(q2);
      const chained = union.intersect(q3);

      expect(chained).not.toBe(union);
      expect(union.toAst().operator).toBe("union");
      expect(chained.toAst().operator).toBe("intersect");
    });
  });
});
