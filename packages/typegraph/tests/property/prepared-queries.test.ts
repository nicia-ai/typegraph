/**
 * Property Tests — Prepared Query Parameter System
 *
 * Tests invariants of parameter collection, substitution, and validation
 * using fast-check to generate arbitrary predicate trees.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type {
  BetweenPredicate,
  ComparisonPredicate,
  FieldRef,
  LiteralValue,
  NodePredicate,
  ParameterRef,
  PredicateExpression,
  QueryAst,
  StringPredicate,
} from "../../src/query/ast";
import {
  composableQueryHasParameterReferences,
  hasParameterReferences,
} from "../../src/query/builder/prepared-query";

// ============================================================
// Arbitraries
// ============================================================

const aliasArb = fc.constantFrom("p", "q", "r", "s");

const fieldRefArb: fc.Arbitrary<FieldRef> = fc.record({
  __type: fc.constant("field_ref" as const),
  alias: aliasArb,
  path: fc.constantFrom(
    ["id"],
    ["props", "name"],
    ["props", "age"],
    ["props", "email"],
    ["kind"],
  ),
});

const literalValueArb: fc.Arbitrary<LiteralValue> = fc.oneof(
  fc.string({ minLength: 0, maxLength: 20 }).map((value) => ({
    __type: "literal" as const,
    value,
    valueType: "string" as const,
  })),
  fc.integer({ min: -1000, max: 1000 }).map((value) => ({
    __type: "literal" as const,
    value,
    valueType: "number" as const,
  })),
  fc.boolean().map((value) => ({
    __type: "literal" as const,
    value,
    valueType: "boolean" as const,
  })),
);

const parameterNameArb = fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,15}$/);

const parameterRefArb: fc.Arbitrary<ParameterRef> = parameterNameArb.map(
  (name) => ({
    __type: "parameter" as const,
    name,
  }),
);

const comparisonRightArb = fc.oneof(literalValueArb, parameterRefArb);

const comparisonPredicateArb: fc.Arbitrary<ComparisonPredicate> = fc.record({
  __type: fc.constant("comparison" as const),
  op: fc.constantFrom("eq", "neq", "gt", "gte", "lt", "lte") as fc.Arbitrary<
    ComparisonPredicate["op"]
  >,
  left: fieldRefArb,
  right: comparisonRightArb,
});

const stringPredicateArb: fc.Arbitrary<StringPredicate> = fc.record({
  __type: fc.constant("string_op" as const),
  op: fc.constantFrom(
    "contains",
    "startsWith",
    "endsWith",
    "like",
    "ilike",
  ) as fc.Arbitrary<StringPredicate["op"]>,
  field: fieldRefArb,
  pattern: fc.oneof(
    fc.string({ minLength: 0, maxLength: 10 }),
    parameterRefArb,
  ),
});

const betweenPredicateArb: fc.Arbitrary<BetweenPredicate> = fc.record({
  __type: fc.constant("between" as const),
  field: fieldRefArb,
  lower: fc.oneof(literalValueArb, parameterRefArb),
  upper: fc.oneof(literalValueArb, parameterRefArb),
});

const nullCheckArb = fc.record({
  __type: fc.constant("null_check" as const),
  op: fc.constantFrom("isNull" as const, "isNotNull" as const),
  field: fieldRefArb,
});

// Leaf predicate (no recursion)
const leafPredicateArb: fc.Arbitrary<PredicateExpression> = fc.oneof(
  comparisonPredicateArb,
  stringPredicateArb,
  betweenPredicateArb,
  nullCheckArb,
);

// Composite predicate with one level of nesting
const compositePredicateArb: fc.Arbitrary<PredicateExpression> = fc.oneof(
  leafPredicateArb,
  fc
    .array(leafPredicateArb, { minLength: 2, maxLength: 4 })
    .map((predicates) => ({ __type: "and" as const, predicates })),
  fc
    .array(leafPredicateArb, { minLength: 2, maxLength: 4 })
    .map((predicates) => ({ __type: "or" as const, predicates })),
  leafPredicateArb.map((predicate) => ({
    __type: "not" as const,
    predicate,
  })),
);

const nodePredicateArb: fc.Arbitrary<NodePredicate> = fc.record({
  targetAlias: aliasArb,
  expression: compositePredicateArb,
});

function makeAstFromPredicates(
  predicates: readonly NodePredicate[],
  having?: PredicateExpression,
): QueryAst {
  return {
    start: { alias: "p", kinds: ["Person"], includeSubClasses: false },
    traversals: [],
    predicates,
    projection: { fields: [] },
    temporalMode: { mode: "current" },
    ...(having === undefined ? {} : { having }),
  };
}

// ============================================================
// Helpers
// ============================================================

function collectParamNames(expression: PredicateExpression): Set<string> {
  const names = new Set<string>();
  collectFromExpr(expression, names);
  return names;
}

function collectFromExpr(
  expression: PredicateExpression,
  names: Set<string>,
): void {
  switch (expression.__type) {
    case "comparison": {
      if (
        !Array.isArray(expression.right) &&
        expression.right.__type === "parameter"
      ) {
        names.add(expression.right.name);
      }
      return;
    }
    case "string_op": {
      if (typeof expression.pattern === "object") {
        names.add(expression.pattern.name);
      }
      return;
    }
    case "between": {
      if (expression.lower.__type === "parameter") {
        names.add(expression.lower.name);
      }
      if (expression.upper.__type === "parameter") {
        names.add(expression.upper.name);
      }
      return;
    }
    case "and":
    case "or": {
      for (const predicate of expression.predicates) {
        collectFromExpr(predicate, names);
      }
      return;
    }
    case "not": {
      collectFromExpr(expression.predicate, names);
      return;
    }
    case "null_check":
    case "array_op":
    case "object_op":
    case "aggregate_comparison":
    case "vector_similarity":
    case "exists":
    case "in_subquery": {
      return;
    }
  }
}

// ============================================================
// Properties
// ============================================================

describe("Parameter Detection Properties", () => {
  it("hasParameterReferences is true iff the AST contains at least one ParameterRef", () => {
    fc.assert(
      fc.property(
        fc.array(nodePredicateArb, { minLength: 0, maxLength: 5 }),
        (predicates) => {
          const ast = makeAstFromPredicates(predicates);

          // Manually check if any parameter exists
          const allParamNames = new Set<string>();
          for (const predicate of predicates) {
            collectFromExpr(predicate.expression, allParamNames);
          }

          const expected = allParamNames.size > 0;
          expect(hasParameterReferences(ast)).toBe(expected);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("hasParameterReferences also checks the having clause", () => {
    fc.assert(
      fc.property(compositePredicateArb, (having) => {
        const ast = makeAstFromPredicates([], having);
        const expectedParams = collectParamNames(having);
        const expected = expectedParams.size > 0;
        expect(hasParameterReferences(ast)).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  it("composableQueryHasParameterReferences matches hasParameterReferences for plain ASTs", () => {
    fc.assert(
      fc.property(
        fc.array(nodePredicateArb, { minLength: 0, maxLength: 3 }),
        (predicates) => {
          const ast = makeAstFromPredicates(predicates);
          expect(composableQueryHasParameterReferences(ast)).toBe(
            hasParameterReferences(ast),
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it("set operations propagate parameter references from either side", () => {
    fc.assert(
      fc.property(
        fc.array(nodePredicateArb, { minLength: 0, maxLength: 3 }),
        fc.array(nodePredicateArb, { minLength: 0, maxLength: 3 }),
        fc.constantFrom("union", "unionAll", "intersect", "except"),
        (leftPreds, rightPreds, operator) => {
          const left = makeAstFromPredicates(leftPreds);
          const right = makeAstFromPredicates(rightPreds);
          const setOp = {
            __type: "set_operation" as const,
            operator,
            left,
            right,
          };

          const leftHas = hasParameterReferences(left);
          const rightHas = hasParameterReferences(right);
          const expected = leftHas || rightHas;

          expect(composableQueryHasParameterReferences(setOp)).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Parameter Name Collection Consistency", () => {
  it("parameter-free predicates never cause hasParameterReferences to be true", () => {
    // Generate only literal-value predicates (no parameters)
    const literalOnlyComparison: fc.Arbitrary<ComparisonPredicate> = fc.record({
      __type: fc.constant("comparison" as const),
      op: fc.constantFrom(
        "eq",
        "neq",
        "gt",
        "gte",
        "lt",
        "lte",
      ) as fc.Arbitrary<ComparisonPredicate["op"]>,
      left: fieldRefArb,
      right: literalValueArb,
    });

    const literalOnlyPredicate: fc.Arbitrary<NodePredicate> = fc.record({
      targetAlias: aliasArb,
      expression: literalOnlyComparison,
    });

    fc.assert(
      fc.property(
        fc.array(literalOnlyPredicate, { minLength: 1, maxLength: 5 }),
        (predicates) => {
          const ast = makeAstFromPredicates(predicates);
          expect(hasParameterReferences(ast)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("adding a parameter to a literal-only AST makes hasParameterReferences true", () => {
    const literalComparison: fc.Arbitrary<ComparisonPredicate> = fc.record({
      __type: fc.constant("comparison" as const),
      op: fc.constant("eq" as const),
      left: fieldRefArb,
      right: literalValueArb,
    });

    fc.assert(
      fc.property(
        fc.array(literalComparison, { minLength: 0, maxLength: 3 }),
        parameterNameArb,
        (existingComparisons, parameterName) => {
          const parameterComparison: ComparisonPredicate = {
            __type: "comparison",
            op: "eq",
            left: { __type: "field_ref", alias: "p", path: ["props", "name"] },
            right: { __type: "parameter", name: parameterName },
          };

          const predicates: NodePredicate[] = [
            ...existingComparisons.map((expression) => ({
              targetAlias: "p",
              expression,
            })),
            { targetAlias: "p", expression: parameterComparison },
          ];

          const ast = makeAstFromPredicates(predicates);
          expect(hasParameterReferences(ast)).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });
});
