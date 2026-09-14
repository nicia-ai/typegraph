import { describe, expect, it } from "vitest";

import type {
  FieldRef,
  PredicateExpression,
  QueryAst,
  Traversal,
} from "../src/query/ast";
import { assertTraversalStagePredicatesSupported } from "../src/query/compiler/traversal-stage-validation";
import {
  createFieldExpression,
  createOuterReferenceExpression,
  expr,
} from "../src/query/expressions";

const traversal = {
  direction: "out",
  edgeAlias: "edge",
  edgeKinds: ["connects"],
  joinEdgeField: "from_id",
  joinFromAlias: "middle",
  nodeAlias: "target",
  nodeKinds: ["Target"],
  optional: false,
} satisfies Traversal;

function queryWith(expression: PredicateExpression): QueryAst {
  return {
    projection: { fields: [] },
    predicates: [{ expression, targetAlias: "target" }],
    start: { alias: "root", includeSubClasses: false, kinds: ["Root"] },
    temporalMode: { mode: "current" },
    traversals: [traversal],
  } satisfies QueryAst;
}

function field(alias: string): FieldRef<string> {
  return {
    __type: "field_ref",
    alias,
    path: ["id"],
    valueType: "string",
  } satisfies FieldRef<string>;
}

describe("isolated traversal-stage validation", () => {
  it("accepts references owned by the stage", () => {
    const ast = queryWith({
      __type: "comparison",
      left: field("target"),
      op: "eq",
      right: field("target"),
    });

    expect(() => {
      assertTraversalStagePredicatesSupported(ast, traversal, 1);
    }).not.toThrow();
  });

  it("refuses a reference to the isolated stage source alias", () => {
    const ast = queryWith({
      __type: "comparison",
      left: field("target"),
      op: "eq",
      right: field("middle"),
    });

    expect(() => {
      assertTraversalStagePredicatesSupported(ast, traversal, 1);
    }).toThrow('cannot evaluate cross-alias reference "middle"');
  });

  it("refuses a direct reference to an unavailable earlier alias", () => {
    const ast = queryWith({
      __type: "comparison",
      left: field("target"),
      op: "eq",
      right: field("root"),
    });

    expect(() => {
      assertTraversalStagePredicatesSupported(ast, traversal, 1);
    }).toThrow('cannot evaluate cross-alias reference "root"');
  });

  it("refuses a correlated outer reference to an unavailable earlier alias", () => {
    const parentScope = Symbol("parent");
    const childScope = Symbol("child");
    const outer = createOuterReferenceExpression(
      createFieldExpression(field("root"), parentScope, false),
      childScope,
    );
    const comparison = expr.eq(
      createFieldExpression(field("target"), childScope, false),
      outer,
    );
    const ast = queryWith({
      __type: "database_expression_predicate",
      expression: comparison,
    });

    expect(() => {
      assertTraversalStagePredicatesSupported(ast, traversal, 1);
    }).toThrow('cannot evaluate cross-alias reference "root"');
  });

  it("does not validate predicates assigned to an earlier stage", () => {
    const ast = {
      projection: { fields: [] },
      predicates: [
        {
          expression: {
            __type: "null_check",
            field: field("root"),
            op: "isNotNull",
          },
          targetAlias: "root",
        },
      ],
      start: { alias: "root", includeSubClasses: false, kinds: ["Root"] },
      temporalMode: { mode: "current" },
      traversals: [traversal],
    } satisfies QueryAst;

    expect(() => {
      assertTraversalStagePredicatesSupported(ast, traversal, 1);
    }).not.toThrow();
  });
});
