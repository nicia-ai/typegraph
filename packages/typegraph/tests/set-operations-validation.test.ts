/**
 * Tests for set operation validation logic.
 *
 * Covers validation of SQLite set operation limitations and
 * predicate detection for subqueries and vector similarity.
 */
import { describe, expect, it } from "vitest";

import {
  type PredicateExpression,
  type QueryAst,
  type SetOperation,
} from "../src/query/ast";
import { compileSetOperation } from "../src/query/compiler/index";
import { jsonPointer } from "../src/query/json-pointer";
import { toSqlString } from "./sql-test-utils";

// ============================================================
// Test Helpers
// ============================================================

function createMinimalAst(
  alias = "a",
  overrides: Partial<QueryAst> = {},
): QueryAst {
  return {
    start: {
      alias,
      kinds: ["TestKind"],
      includeSubClasses: false,
    },
    traversals: [],
    predicates: [],
    projection: {
      fields: [
        {
          outputName: "id",
          source: {
            __type: "field_ref" as const,
            alias,
            path: ["id"] as readonly string[],
          },
        },
      ],
    },
    temporalMode: { mode: "current" },
    ...overrides,
  };
}

function createSetOperation(
  leftAst: QueryAst = createMinimalAst("a"),
  rightAst: QueryAst = createMinimalAst("b"),
): SetOperation {
  return {
    __type: "set_operation",
    operator: "union",
    left: leftAst,
    right: rightAst,
  };
}

function compileSqlite(op: SetOperation): string {
  const result = compileSetOperation(op, "test", "sqlite");
  return toSqlString(result);
}

// ============================================================
// SQLite Validation Tests
// ============================================================

describe("SQLite set operation validation", () => {
  describe("unsupported features", () => {
    it("rejects queries with traversals", () => {
      const astWithTraversals = createMinimalAst("a", {
        traversals: [
          {
            edgeKinds: ["knows"],
            edgeAlias: "e",
            nodeKinds: ["Person"],
            nodeAlias: "friend",
            direction: "out",
            joinFromAlias: "a",
            joinEdgeField: "to_id",
            optional: false,
          },
        ],
      });

      const op = createSetOperation(astWithTraversals);

      expect(() => compileSqlite(op)).toThrow(/traversals/i);
    });

    it("rejects queries with EXISTS subquery", () => {
      const existsExpression: PredicateExpression = {
        __type: "exists",
        subquery: createMinimalAst("sub"),
        negated: false,
      };

      const astWithExists = createMinimalAst("a", {
        predicates: [
          {
            targetAlias: "a",
            expression: existsExpression,
          },
        ],
      });

      const op = createSetOperation(astWithExists);

      expect(() => compileSqlite(op)).toThrow(/EXISTS\/IN subqueries/i);
    });

    it("rejects queries with IN subquery", () => {
      const inSubqueryExpression: PredicateExpression = {
        __type: "in_subquery",
        field: {
          __type: "field_ref",
          alias: "a",
          path: ["id"],
        },
        subquery: createMinimalAst("sub"),
        negated: false,
      };

      const astWithInSubquery = createMinimalAst("a", {
        predicates: [
          {
            targetAlias: "a",
            expression: inSubqueryExpression,
          },
        ],
      });

      const op = createSetOperation(astWithInSubquery);

      expect(() => compileSqlite(op)).toThrow(/EXISTS\/IN subqueries/i);
    });

    it("rejects queries with vector similarity predicates", () => {
      const vectorExpression: PredicateExpression = {
        __type: "vector_similarity",
        field: {
          __type: "field_ref",
          alias: "a",
          path: ["props", "embedding"],
          jsonPointer: jsonPointer(["embedding"]),
        },
        queryEmbedding: [0.1, 0.2, 0.3],
        metric: "cosine",
        limit: 10,
      };

      const astWithVector = createMinimalAst("a", {
        predicates: [
          {
            targetAlias: "a",
            expression: vectorExpression,
          },
        ],
      });

      const op = createSetOperation(astWithVector);

      expect(() => compileSqlite(op)).toThrow(/vector similarity/i);
    });

    it("rejects queries with GROUP BY", () => {
      const astWithGroupBy = createMinimalAst("a", {
        groupBy: {
          fields: [
            {
              __type: "field_ref",
              alias: "a",
              path: ["props", "category"],
            },
          ],
        },
      });

      const op = createSetOperation(astWithGroupBy);

      expect(() => compileSqlite(op)).toThrow(/GROUP BY/i);
    });

    it("rejects queries with HAVING", () => {
      const astWithHaving = createMinimalAst("a", {
        having: {
          __type: "aggregate_comparison",
          op: "gt",
          aggregate: {
            __type: "aggregate",
            function: "count",
            field: { __type: "field_ref", alias: "a", path: ["id"] },
          },
          value: { __type: "literal", value: 5 },
        },
      });

      const op = createSetOperation(astWithHaving);

      expect(() => compileSqlite(op)).toThrow(/HAVING/i);
    });

    it("rejects queries with per-query ORDER BY", () => {
      const astWithOrderBy = createMinimalAst("a", {
        orderBy: [
          {
            field: {
              __type: "field_ref",
              alias: "a",
              path: ["props", "name"],
            },
            direction: "asc",
          },
        ],
      });

      const op = createSetOperation(astWithOrderBy);

      expect(() => compileSqlite(op)).toThrow(/per-query ORDER BY/i);
    });

    it("rejects queries with per-query LIMIT", () => {
      const astWithLimit = createMinimalAst("a", {
        limit: 10,
      });

      const op = createSetOperation(astWithLimit);

      expect(() => compileSqlite(op)).toThrow(/per-query LIMIT/i);
    });

    it("rejects queries with per-query OFFSET", () => {
      const astWithOffset = createMinimalAst("a", {
        offset: 5,
      });

      const op = createSetOperation(astWithOffset);

      expect(() => compileSqlite(op)).toThrow(/per-query OFFSET/i);
    });
  });

  describe("nested predicate detection", () => {
    it("detects EXISTS in AND expression", () => {
      const andExpression: PredicateExpression = {
        __type: "and",
        predicates: [
          {
            __type: "comparison",
            op: "eq",
            left: { __type: "field_ref", alias: "a", path: ["props", "name"] },
            right: { __type: "literal", value: "test" },
          },
          {
            __type: "exists",
            subquery: createMinimalAst("sub"),
            negated: false,
          },
        ],
      };

      const ast = createMinimalAst("a", {
        predicates: [{ targetAlias: "a", expression: andExpression }],
      });

      const op = createSetOperation(ast);

      expect(() => compileSqlite(op)).toThrow(/EXISTS\/IN subqueries/i);
    });

    it("detects EXISTS in OR expression", () => {
      const orExpression: PredicateExpression = {
        __type: "or",
        predicates: [
          {
            __type: "comparison",
            op: "eq",
            left: { __type: "field_ref", alias: "a", path: ["props", "name"] },
            right: { __type: "literal", value: "test" },
          },
          {
            __type: "exists",
            subquery: createMinimalAst("sub"),
            negated: false,
          },
        ],
      };

      const ast = createMinimalAst("a", {
        predicates: [{ targetAlias: "a", expression: orExpression }],
      });

      const op = createSetOperation(ast);

      expect(() => compileSqlite(op)).toThrow(/EXISTS\/IN subqueries/i);
    });

    it("detects EXISTS in NOT expression", () => {
      const notExpression: PredicateExpression = {
        __type: "not",
        predicate: {
          __type: "exists",
          subquery: createMinimalAst("sub"),
          negated: false,
        },
      };

      const ast = createMinimalAst("a", {
        predicates: [{ targetAlias: "a", expression: notExpression }],
      });

      const op = createSetOperation(ast);

      expect(() => compileSqlite(op)).toThrow(/EXISTS\/IN subqueries/i);
    });

    it("detects vector similarity in nested AND", () => {
      const andExpression: PredicateExpression = {
        __type: "and",
        predicates: [
          {
            __type: "comparison",
            op: "eq",
            left: { __type: "field_ref", alias: "a", path: ["props", "name"] },
            right: { __type: "literal", value: "test" },
          },
          {
            __type: "vector_similarity",
            field: {
              __type: "field_ref",
              alias: "a",
              path: ["props", "embedding"],
              jsonPointer: jsonPointer(["embedding"]),
            },
            queryEmbedding: [0.1, 0.2, 0.3],
            metric: "cosine",
            limit: 10,
          },
        ],
      };

      const ast = createMinimalAst("a", {
        predicates: [{ targetAlias: "a", expression: andExpression }],
      });

      const op = createSetOperation(ast);

      expect(() => compileSqlite(op)).toThrow(/vector similarity/i);
    });
  });

  describe("error message quality", () => {
    it("lists multiple unsupported features in error message", () => {
      const astWithMultiple = createMinimalAst("a", {
        traversals: [
          {
            edgeKinds: ["knows"],
            edgeAlias: "e",
            nodeKinds: ["Person"],
            nodeAlias: "friend",
            direction: "out",
            joinFromAlias: "a",
            joinEdgeField: "to_id",
            optional: false,
          },
        ],
        groupBy: {
          fields: [
            {
              __type: "field_ref",
              alias: "a",
              path: ["props", "category"],
            },
          ],
        },
      });

      const op = createSetOperation(astWithMultiple);

      // Should mention both unsupported features
      expect(() => compileSqlite(op)).toThrow(
        /traversals.*GROUP BY|GROUP BY.*traversals/s,
      );
    });
  });
});
