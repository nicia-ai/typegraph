import { describe, expect, it } from "vitest";

import { UnsupportedPredicateError } from "../src/errors";
import type { FieldRef, PredicateExpression, QueryAst } from "../src/query/ast";
import { assertIsolatedStageReadsNoEnclosingQuery } from "../src/query/compiler/traversal-stage-validation";
import {
  createExistsSubqueryExpression,
  createFieldExpression,
  createOuterReferenceExpression,
  expr,
} from "../src/query/expressions";

const enclosingScope = Symbol("enclosing");
const stageScope = Symbol("stage");
const nestedScope = Symbol("nested");

function field(alias: string): FieldRef<string> {
  return {
    __type: "field_ref",
    alias,
    path: ["id"],
    valueType: "string",
  } satisfies FieldRef<string>;
}

/** An isolated fixed stage `middle -edge-> target` with one predicate on `target`. */
function isolatedStage(expression: PredicateExpression): QueryAst {
  return {
    expressionScope: stageScope,
    projection: { fields: [] },
    predicates: [{ expression, targetAlias: "target" }],
    start: { alias: "middle", expansion: "exact", kinds: ["Middle"] },
    temporalMode: { mode: "current" },
    traversals: [
      {
        direction: "out",
        edgeAlias: "edge",
        edgeKinds: ["connects"],
        joinEdgeField: "from_id",
        joinFromAlias: "middle",
        nodeAlias: "target",
        nodeKinds: ["Target"],
        optional: false,
      },
    ],
  } satisfies QueryAst;
}

function targetEquals(
  right: ReturnType<typeof createFieldExpression<string, string>>,
) {
  return isolatedStage({
    __type: "database_expression_predicate",
    expression: expr.eq(
      createFieldExpression(field("target"), stageScope, false),
      right,
    ),
  });
}

describe("isolated traversal-stage scope", () => {
  it("accepts a predicate that reads only the stage's own statement", () => {
    expect(() => {
      assertIsolatedStageReadsNoEnclosingQuery(
        targetEquals(createFieldExpression(field("target"), stageScope, false)),
      );
    }).not.toThrow();
  });

  it("refuses an outer reference to the enclosing query, naming the caller's alias", () => {
    const ast = targetEquals(
      createOuterReferenceExpression(
        createFieldExpression(field("p"), enclosingScope, false),
        stageScope,
      ),
    );

    expect(() => {
      assertIsolatedStageReadsNoEnclosingQuery(ast);
    }).toThrow(UnsupportedPredicateError);
    let refusal: unknown;
    try {
      assertIsolatedStageReadsNoEnclosingQuery(ast, (alias) =>
        alias === "target" ? "callerTarget" : alias,
      );
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(UnsupportedPredicateError);
    expect((refusal as UnsupportedPredicateError).details).toEqual({
      targetAlias: "callerTarget",
    });
    expect((refusal as UnsupportedPredicateError).message).toMatch(
      /^The predicate on alias "callerTarget" reads an enclosing query/,
    );
  });

  it("accepts a nested subquery correlated with the stage itself", () => {
    const nested: QueryAst = {
      expressionScope: nestedScope,
      projection: { fields: [] },
      predicates: [
        {
          targetAlias: "inner",
          expression: {
            __type: "database_expression_predicate",
            expression: expr.eq(
              createFieldExpression(field("inner"), nestedScope, false),
              createOuterReferenceExpression(
                createFieldExpression(field("target"), stageScope, false),
                nestedScope,
              ),
            ),
          },
        },
      ],
      start: { alias: "inner", expansion: "exact", kinds: ["Target"] },
      temporalMode: { mode: "current" },
      traversals: [],
    };
    const ast = isolatedStage({
      __type: "database_expression_predicate",
      expression: createExistsSubqueryExpression(nested, stageScope),
    });

    expect(() => {
      assertIsolatedStageReadsNoEnclosingQuery(ast);
    }).not.toThrow();
  });

  it("refuses a nested subquery correlated with the enclosing query", () => {
    const nested: QueryAst = {
      expressionScope: nestedScope,
      projection: { fields: [] },
      predicates: [
        {
          targetAlias: "inner",
          expression: {
            __type: "database_expression_predicate",
            expression: expr.eq(
              createFieldExpression(field("inner"), nestedScope, false),
              createOuterReferenceExpression(
                createFieldExpression(field("p"), enclosingScope, false),
                nestedScope,
              ),
            ),
          },
        },
      ],
      start: { alias: "inner", expansion: "exact", kinds: ["Target"] },
      temporalMode: { mode: "current" },
      traversals: [],
    };
    const ast = isolatedStage({
      __type: "database_expression_predicate",
      expression: createExistsSubqueryExpression(nested, stageScope),
    });

    expect(() => {
      assertIsolatedStageReadsNoEnclosingQuery(ast);
    }).toThrow('The predicate on alias "target" reads an enclosing query');
  });
});
