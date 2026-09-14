import { describe, expect, it } from "vitest";

import type { PredicateExpression, QueryAst } from "../src/query/ast";
import {
  bindQueryParameters,
  collectParameterMetadata,
} from "../src/query/builder/prepared-query";

function parameterComparison(name: string): PredicateExpression {
  return {
    __type: "comparison",
    left: {
      __type: "field_ref",
      alias: "target",
      path: ["props", "name"],
      valueType: "string",
    },
    op: "eq",
    right: { __type: "parameter", name, valueType: "string" },
  };
}

function queryWithResultAndStopParameters(): QueryAst {
  return {
    graphId: "prepared-predicates",
    start: { alias: "root", includeSubClasses: false, kinds: ["Node"] },
    traversals: [
      {
        direction: "out",
        edgeAlias: "edge",
        edgeKinds: ["links"],
        joinEdgeField: "from_id",
        joinFromAlias: "root",
        nodeAlias: "target",
        nodeKinds: ["Node"],
        optional: false,
        variableLength: {
          cyclePolicy: "prevent",
          maxDepth: 3,
          minDepth: 1,
          stopExpansion: {
            emitStopNode: true,
            expression: parameterComparison("stopName"),
          },
        },
      },
    ],
    predicates: [],
    projection: { fields: [] },
    resultPredicate: parameterComparison("resultName"),
    temporalMode: { mode: "current" },
  };
}

describe("prepared completed-match and recursive-stop predicates", () => {
  it("collects and substitutes parameters from both predicate stages", () => {
    const ast = queryWithResultAndStopParameters();
    expect([...collectParameterMetadata(ast).names].toSorted()).toEqual([
      "resultName",
      "stopName",
    ]);

    const bound = bindQueryParameters(ast, {
      resultName: "kept",
      stopName: "halt",
    });
    expect(bound.resultPredicate).toMatchObject({
      right: { __type: "literal", value: "kept" },
    });
    expect(
      bound.traversals[0]?.variableLength?.stopExpansion?.expression,
    ).toMatchObject({ right: { __type: "literal", value: "halt" } });
  });

  it("requires bindings discovered only in completed-match and stop predicates", () => {
    expect(() =>
      bindQueryParameters(queryWithResultAndStopParameters(), {
        resultName: "kept",
      }),
    ).toThrow(/stopName/);
  });
});
