/**
 * Tests that SQLite set operations support the same leaf features as
 * standalone queries.
 *
 * SQLite forbids parenthesized compound operands, so each leaf is wrapped as
 * `SELECT * FROM (<leaf>)`. Because a FROM-subquery may carry its own WITH
 * clause, every feature that works in a standalone query (traversals,
 * EXISTS/IN subqueries, GROUP BY/HAVING, and per-leaf ORDER BY/LIMIT/OFFSET)
 * also works inside a UNION/INTERSECT/EXCEPT leaf. These tests assert the
 * leaves compile (rather than throw) and are wrapped as subquery operands.
 */
import { describe, expect, it } from "vitest";

import {
  type PredicateExpression,
  type QueryAst,
  type SetOperation,
} from "../src/query/ast";
import { compileSetOperation } from "../src/query/compiler/index";
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
// SQLite leaf-feature support
// ============================================================

describe("SQLite set operation leaf features", () => {
  it("wraps each compound operand as a FROM-subquery", () => {
    const op = createSetOperation();

    const sql = compileSqlite(op);

    // No parenthesized compound operands; each leaf is a `SELECT * FROM (...)`.
    expect(sql).toContain("UNION");
    expect(sql).toMatch(/SELECT \* FROM \(/);
  });

  it("supports leaves with traversals", () => {
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

    expect(() => compileSqlite(op)).not.toThrow();
  });

  it("supports leaves with EXISTS subqueries", () => {
    const existsExpression: PredicateExpression = {
      __type: "exists",
      subquery: { ...createMinimalAst("sub"), graphId: "test" },
      negated: false,
    };

    const astWithExists = createMinimalAst("a", {
      predicates: [{ targetAlias: "a", expression: existsExpression }],
    });

    const op = createSetOperation(astWithExists);

    const sql = compileSqlite(op);
    expect(sql).toContain("EXISTS");
  });

  it("supports leaves with IN subqueries", () => {
    const inSubqueryExpression: PredicateExpression = {
      __type: "in_subquery",
      field: {
        __type: "field_ref",
        alias: "a",
        path: ["id"],
      },
      subquery: { ...createMinimalAst("sub"), graphId: "test" },
      negated: false,
    };

    const astWithInSubquery = createMinimalAst("a", {
      predicates: [{ targetAlias: "a", expression: inSubqueryExpression }],
    });

    const op = createSetOperation(astWithInSubquery);

    const sql = compileSqlite(op);
    expect(sql).toContain("IN");
  });

  it("supports leaves with GROUP BY", () => {
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

    const sql = compileSqlite(op);
    expect(sql).toContain("GROUP BY");
  });

  it("supports leaves with HAVING", () => {
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

    const sql = compileSqlite(op);
    expect(sql).toContain("HAVING");
  });

  it("supports leaves with per-leaf ORDER BY", () => {
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

    const sql = compileSqlite(op);
    // Per-leaf ORDER BY lives inside the operand subquery, not the compound tail.
    expect(sql).toContain("ORDER BY");
  });

  it("supports leaves with per-leaf LIMIT", () => {
    const astWithLimit = createMinimalAst("a", { limit: 10 });

    const op = createSetOperation(astWithLimit);

    const sql = compileSqlite(op);
    expect(sql).toContain("LIMIT");
  });

  it("supports leaves with per-leaf OFFSET", () => {
    const astWithOffset = createMinimalAst("a", { limit: 10, offset: 5 });

    const op = createSetOperation(astWithOffset);

    const sql = compileSqlite(op);
    expect(sql).toContain("OFFSET");
  });

  it("supports a leaf combining traversal + GROUP BY", () => {
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

    expect(() => compileSqlite(op)).not.toThrow();
  });
});
