/**
 * PreparedQuery Unit Tests
 *
 * Tests the internal mechanics of parameter substitution, validation,
 * and name collection. Integration-level prepared query tests live
 * in query-execution.test.ts.
 */
import { describe, expect, it } from "vitest";

import type {
  BetweenPredicate,
  ComparisonPredicate,
  LiteralValue,
  NodePredicate,
  PredicateExpression,
  QueryAst,
  StringPredicate,
} from "../src/query/ast";
import {
  composableQueryHasParameterReferences,
  hasParameterReferences,
} from "../src/query/builder/prepared-query";

// ============================================================
// Helpers
// ============================================================

function makeFieldRef(alias = "p", path = ["props", "name"]) {
  return {
    __type: "field_ref" as const,
    alias,
    path,
  };
}

function makeLiteral(
  value: string | number | boolean,
  valueType?: "string" | "number" | "boolean",
): LiteralValue {
  return {
    __type: "literal",
    value,
    valueType: valueType ?? (typeof value as "string" | "number" | "boolean"),
  };
}

function makeParamRef(name: string) {
  return { __type: "parameter" as const, name };
}

function makeComparison(
  alias: string,
  field: string[],
  right: LiteralValue | { __type: "parameter"; name: string },
  op: ComparisonPredicate["op"] = "eq",
): ComparisonPredicate {
  return {
    __type: "comparison",
    op,
    left: makeFieldRef(alias, field),
    right,
  };
}

function makeMinimalAst(predicates: readonly NodePredicate[] = []): QueryAst {
  return {
    start: { alias: "p", kinds: ["Person"], includeSubClasses: false },
    traversals: [],
    predicates,
    projection: { fields: [] },
    temporalMode: { mode: "current" },
  };
}

function makeNodePredicate(
  expression: PredicateExpression,
  targetAlias = "p",
): NodePredicate {
  return { targetAlias, expression };
}

// ============================================================
// hasParameterReferences
// ============================================================

describe("hasParameterReferences", () => {
  it("returns false for AST with no predicates", () => {
    const ast = makeMinimalAst();
    expect(hasParameterReferences(ast)).toBe(false);
  });

  it("returns false for AST with only literal predicates", () => {
    const ast = makeMinimalAst([
      makeNodePredicate(
        makeComparison("p", ["props", "name"], makeLiteral("Alice")),
      ),
    ]);
    expect(hasParameterReferences(ast)).toBe(false);
  });

  it("returns true for comparison with parameter ref", () => {
    const ast = makeMinimalAst([
      makeNodePredicate(
        makeComparison("p", ["props", "name"], makeParamRef("name")),
      ),
    ]);
    expect(hasParameterReferences(ast)).toBe(true);
  });

  it("returns true for string_op with parameter ref", () => {
    const expr: StringPredicate = {
      __type: "string_op",
      op: "contains",
      field: makeFieldRef("p", ["props", "name"]),
      pattern: makeParamRef("query"),
    };
    const ast = makeMinimalAst([makeNodePredicate(expr)]);
    expect(hasParameterReferences(ast)).toBe(true);
  });

  it("returns false for string_op with literal pattern", () => {
    const expr: StringPredicate = {
      __type: "string_op",
      op: "contains",
      field: makeFieldRef("p", ["props", "name"]),
      pattern: "Alice",
    };
    const ast = makeMinimalAst([makeNodePredicate(expr)]);
    expect(hasParameterReferences(ast)).toBe(false);
  });

  it("returns true for between with parameter ref in lower bound", () => {
    const expr: BetweenPredicate = {
      __type: "between",
      field: makeFieldRef("p", ["props", "age"]),
      lower: makeParamRef("minAge"),
      upper: makeLiteral(100, "number"),
    };
    const ast = makeMinimalAst([makeNodePredicate(expr)]);
    expect(hasParameterReferences(ast)).toBe(true);
  });

  it("returns true for between with parameter ref in upper bound", () => {
    const expr: BetweenPredicate = {
      __type: "between",
      field: makeFieldRef("p", ["props", "age"]),
      lower: makeLiteral(0, "number"),
      upper: makeParamRef("maxAge"),
    };
    const ast = makeMinimalAst([makeNodePredicate(expr)]);
    expect(hasParameterReferences(ast)).toBe(true);
  });

  it("returns false for between with both literal bounds", () => {
    const expr: BetweenPredicate = {
      __type: "between",
      field: makeFieldRef("p", ["props", "age"]),
      lower: makeLiteral(0, "number"),
      upper: makeLiteral(100, "number"),
    };
    const ast = makeMinimalAst([makeNodePredicate(expr)]);
    expect(hasParameterReferences(ast)).toBe(false);
  });

  it("detects parameter refs nested inside AND", () => {
    const expr: PredicateExpression = {
      __type: "and",
      predicates: [
        makeComparison("p", ["props", "name"], makeLiteral("Alice")),
        makeComparison("p", ["props", "age"], makeParamRef("age")),
      ],
    };
    const ast = makeMinimalAst([makeNodePredicate(expr)]);
    expect(hasParameterReferences(ast)).toBe(true);
  });

  it("detects parameter refs nested inside OR", () => {
    const expr: PredicateExpression = {
      __type: "or",
      predicates: [
        makeComparison("p", ["props", "name"], makeParamRef("name")),
        makeComparison("p", ["props", "name"], makeLiteral("Bob")),
      ],
    };
    const ast = makeMinimalAst([makeNodePredicate(expr)]);
    expect(hasParameterReferences(ast)).toBe(true);
  });

  it("detects parameter refs nested inside NOT", () => {
    const expr: PredicateExpression = {
      __type: "not",
      predicate: makeComparison(
        "p",
        ["props", "name"],
        makeParamRef("excludeName"),
      ),
    };
    const ast = makeMinimalAst([makeNodePredicate(expr)]);
    expect(hasParameterReferences(ast)).toBe(true);
  });

  it("returns false for null_check predicates", () => {
    const expr: PredicateExpression = {
      __type: "null_check",
      op: "isNull",
      field: makeFieldRef("p", ["props", "email"]),
    };
    const ast = makeMinimalAst([makeNodePredicate(expr)]);
    expect(hasParameterReferences(ast)).toBe(false);
  });

  it("detects parameter refs in exists subquery", () => {
    const subqueryAst = makeMinimalAst([
      makeNodePredicate(
        makeComparison("q", ["props", "id"], makeParamRef("targetId")),
        "q",
      ),
    ]);
    const expr: PredicateExpression = {
      __type: "exists",
      subquery: {
        ...subqueryAst,
        start: { alias: "q", kinds: ["Order"], includeSubClasses: false },
      },
      negated: false,
    };
    const ast = makeMinimalAst([makeNodePredicate(expr)]);
    expect(hasParameterReferences(ast)).toBe(true);
  });

  it("detects parameter refs in in_subquery", () => {
    const subqueryAst: QueryAst = {
      ...makeMinimalAst([
        makeNodePredicate(
          makeComparison("q", ["props", "status"], makeParamRef("status")),
          "q",
        ),
      ]),
      start: { alias: "q", kinds: ["Order"], includeSubClasses: false },
    };
    const expr: PredicateExpression = {
      __type: "in_subquery",
      field: makeFieldRef("p", ["id"]),
      subquery: subqueryAst,
      negated: false,
    };
    const ast = makeMinimalAst([makeNodePredicate(expr)]);
    expect(hasParameterReferences(ast)).toBe(true);
  });

  it("detects parameter refs in having clause", () => {
    const ast: QueryAst = {
      ...makeMinimalAst(),
      having: makeComparison("p", ["props", "count"], makeParamRef("minCount")),
    };
    expect(hasParameterReferences(ast)).toBe(true);
  });

  it("collects multiple distinct parameter names", () => {
    const expr: PredicateExpression = {
      __type: "and",
      predicates: [
        makeComparison("p", ["props", "name"], makeParamRef("name")),
        makeComparison("p", ["props", "age"], makeParamRef("age")),
        makeComparison("p", ["props", "email"], makeParamRef("email")),
      ],
    };
    const ast = makeMinimalAst([makeNodePredicate(expr)]);
    expect(hasParameterReferences(ast)).toBe(true);
  });
});

// ============================================================
// composableQueryHasParameterReferences
// ============================================================

describe("composableQueryHasParameterReferences", () => {
  it("returns false for a plain AST with no parameters", () => {
    const ast = makeMinimalAst();
    expect(composableQueryHasParameterReferences(ast)).toBe(false);
  });

  it("returns true for a plain AST with parameters", () => {
    const ast = makeMinimalAst([
      makeNodePredicate(
        makeComparison("p", ["props", "name"], makeParamRef("name")),
      ),
    ]);
    expect(composableQueryHasParameterReferences(ast)).toBe(true);
  });

  it("returns true when left side of set operation has parameters", () => {
    const left = makeMinimalAst([
      makeNodePredicate(
        makeComparison("p", ["props", "name"], makeParamRef("name")),
      ),
    ]);
    const right = makeMinimalAst();
    const setOp = {
      __type: "set_operation" as const,
      operator: "union" as const,
      left,
      right,
    };
    expect(composableQueryHasParameterReferences(setOp)).toBe(true);
  });

  it("returns true when right side of set operation has parameters", () => {
    const left = makeMinimalAst();
    const right = makeMinimalAst([
      makeNodePredicate(
        makeComparison("p", ["props", "age"], makeParamRef("age")),
      ),
    ]);
    const setOp = {
      __type: "set_operation" as const,
      operator: "union" as const,
      left,
      right,
    };
    expect(composableQueryHasParameterReferences(setOp)).toBe(true);
  });

  it("returns false when neither side of set operation has parameters", () => {
    const left = makeMinimalAst();
    const right = makeMinimalAst();
    const setOp = {
      __type: "set_operation" as const,
      operator: "intersect" as const,
      left,
      right,
    };
    expect(composableQueryHasParameterReferences(setOp)).toBe(false);
  });

  it("handles nested set operations", () => {
    const innerLeft = makeMinimalAst([
      makeNodePredicate(
        makeComparison("p", ["props", "name"], makeParamRef("name")),
      ),
    ]);
    const innerRight = makeMinimalAst();
    const innerSetOp = {
      __type: "set_operation" as const,
      operator: "union" as const,
      left: innerLeft,
      right: innerRight,
    };
    const outerSetOp = {
      __type: "set_operation" as const,
      operator: "except" as const,
      left: innerSetOp,
      right: makeMinimalAst(),
    };
    expect(composableQueryHasParameterReferences(outerSetOp)).toBe(true);
  });
});
