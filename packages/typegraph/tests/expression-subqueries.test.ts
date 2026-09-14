import { describe, expect, expectTypeOf, it } from "vitest";

import type { QueryAst } from "../src/query/ast";
import {
  createExpressionSubqueryHelpers,
  type ExpressionProjectionEntry,
  type ExpressionSubqueryRelation,
} from "../src/query/builder/expression-subqueries";
import type { DatabaseExpression } from "../src/query/expressions";
import { expr } from "../src/query/expressions";

const EMPTY_QUERY = {
  groupBy: undefined,
  limit: 1,
  temporalMode: { mode: "current" },
} as unknown as QueryAst;

function createFixture() {
  const parentScopeIdentity = Symbol("parent");
  const childScopeIdentity = Symbol("child");
  const executionTarget = {};
  const provenance = { executionTarget, graphId: "graph" };
  const builder = {
    getExpressionScopeIdentity: () => childScopeIdentity,
  };
  const projected = {
    expression: expr.literal("Alice"),
    outputName: "name",
  } satisfies ExpressionProjectionEntry<string>;
  function relation(
    projection: readonly ExpressionProjectionEntry[],
    overrides: Partial<
      Pick<
        ExpressionSubqueryRelation<readonly ExpressionProjectionEntry[]>,
        "getExpressionScopeIdentity" | "getOneStatementReadProvenance"
      >
    > = {},
  ): ExpressionSubqueryRelation<readonly ExpressionProjectionEntry[]> {
    return {
      getExpressionProjection: () => projection,
      getExpressionScopeIdentity:
        overrides.getExpressionScopeIdentity ?? (() => childScopeIdentity),
      getOneStatementReadProvenance:
        overrides.getOneStatementReadProvenance ?? (() => provenance),
      toAst: () => EMPTY_QUERY,
    };
  }
  const helpers = createExpressionSubqueryHelpers({
    createOuterContext: (scopeIdentity) => ({ scopeIdentity }),
    createSubquery: () => builder,
    parentProvenance: provenance,
    parentCoordinate: EMPTY_QUERY,
    parentScopeIdentity,
  });
  return { builder, childScopeIdentity, helpers, projected, relation };
}

describe("typed expression subqueries", () => {
  it("creates typed EXISTS and nullable scalar nodes", () => {
    const fixture = createFixture();
    const exists = fixture.helpers.$exists((subquery, outer) => {
      expect(subquery).toBe(fixture.builder);
      expect(outer.scopeIdentity).toBe(fixture.childScopeIdentity);
      return fixture.relation([fixture.projected]);
    });
    const scalar = fixture.helpers.$scalar(
      () =>
        fixture.relation([fixture.projected]) as ExpressionSubqueryRelation<
          readonly [typeof fixture.projected]
        >,
    );

    expect(exists.node.kind).toBe("exists_subquery");
    expect(scalar.node.kind).toBe("scalar_subquery");
    expect(scalar.nullable).toBe(true);
    expectTypeOf(scalar).toExtend<DatabaseExpression<string | undefined>>();
  });

  it("refuses invalid projection widths and unbounded scalar relations", () => {
    const fixture = createFixture();
    expect(() => fixture.helpers.$exists(() => fixture.relation([]))).toThrow(
      "nonempty project",
    );
    expect(() =>
      fixture.helpers.$scalar(
        () => fixture.relation([fixture.projected, fixture.projected]) as never,
      ),
    ).toThrow("exactly one projected field");

    const unbounded = {
      ...EMPTY_QUERY,
      limit: undefined,
    } as unknown as QueryAst;
    const relation = fixture.relation([fixture.projected]);
    expect(() =>
      fixture.helpers.$scalar(
        () => ({ ...relation, toAst: () => unbounded }) as never,
      ),
    ).toThrow("requires limit(1)");
  });

  it("refuses a foreign returned relation", () => {
    const fixture = createFixture();
    expect(() =>
      fixture.helpers.$exists(() =>
        fixture.relation([fixture.projected], {
          getExpressionScopeIdentity: () => Symbol("foreign"),
        }),
      ),
    ).toThrow("relation built by their subquery argument");
    expect(() =>
      fixture.helpers.$exists(() =>
        fixture.relation([fixture.projected], {
          getOneStatementReadProvenance: () => ({
            executionTarget: {},
            graphId: "graph",
          }),
        }),
      ),
    ).toThrow("enclosing query's graph and execution target");
  });

  it("refuses a different temporal coordinate", () => {
    const fixture = createFixture();
    const historical = {
      ...EMPTY_QUERY,
      temporalMode: { asOf: "2025-01-01T00:00:00.000Z", mode: "asOf" },
    } as unknown as QueryAst;

    expect(() =>
      fixture.helpers.$exists(() => ({
        ...fixture.relation([fixture.projected]),
        toAst: () => historical,
      })),
    ).toThrow("enclosing query's temporal coordinate");
  });
});
