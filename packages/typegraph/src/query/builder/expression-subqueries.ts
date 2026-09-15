import { ConfigurationError } from "../../errors";
import type { QueryAst } from "../ast";
import { isAggregateExpression } from "../compiler/expression-inspection";
import {
  createExistsSubqueryExpression,
  createScalarSubqueryExpression,
  type DatabaseExpression,
} from "../expressions";
import type { OneStatementReadProvenance } from "./one-statement-provenance";

export type ExpressionProjectionEntry<T = unknown> = Readonly<{
  outputName: string;
  expression: DatabaseExpression<T>;
}>;

type ExpressionValue<Expression> =
  Expression extends DatabaseExpression<infer Value> ? Value : never;
type IsUnion<Value, Whole = Value> =
  Value extends Whole ?
    [Whole] extends [Value] ?
      false
    : true
  : never;

/** Preserves a one-field projection as a tuple so `$scalar()` can reject wider records. */
export type ExpressionProjectionEntries<
  Fields extends Readonly<Record<string, DatabaseExpression>>,
> =
  keyof Fields extends never ? readonly []
  : string extends keyof Fields ? readonly ExpressionProjectionEntry[]
  : IsUnion<keyof Fields> extends true ? readonly ExpressionProjectionEntry[]
  : readonly [ExpressionProjectionEntry<ExpressionValue<Fields[keyof Fields]>>];

export type ExpressionSubqueryRelation<
  Projection extends readonly ExpressionProjectionEntry[],
> = Readonly<{
  getExpressionProjection: () => Projection;
  getExpressionScopeIdentity: () => symbol;
  getOneStatementReadProvenance: () => OneStatementReadProvenance;
  toAst: () => QueryAst;
}>;

type ProjectedExpressionSubqueryRelation = ExpressionSubqueryRelation<
  readonly ExpressionProjectionEntry[]
>;

type ScalarExpressionSubqueryRelation<T> = ExpressionSubqueryRelation<
  readonly [ExpressionProjectionEntry<T>]
>;

export type ExpressionSubqueryHelpers<
  Builder,
  OuterContext,
  ParentScope extends string,
> = Readonly<{
  $exists: (
    build: (
      subquery: Builder,
      outer: OuterContext,
    ) => ProjectedExpressionSubqueryRelation,
  ) => DatabaseExpression<boolean, ParentScope>;
  $scalar: <T>(
    build: (
      subquery: Builder,
      outer: OuterContext,
    ) => ScalarExpressionSubqueryRelation<T>,
  ) => DatabaseExpression<T | undefined, ParentScope>;
}>;

export type CreateExpressionSubqueryHelpersInput<Builder, OuterContext> =
  Readonly<{
    parentScopeIdentity: symbol;
    parentProvenance: OneStatementReadProvenance;
    parentCoordinate: Pick<QueryAst, "recordedAsOf" | "temporalMode">;
    createSubquery: () => Builder;
    createOuterContext: (childScopeIdentity: symbol) => OuterContext;
  }>;

/** Creates the correlated subquery helpers exposed by an expression context. */
export function createExpressionSubqueryHelpers<
  Builder,
  OuterContext,
  ParentScope extends string,
>(
  input: CreateExpressionSubqueryHelpersInput<Builder, OuterContext>,
): ExpressionSubqueryHelpers<Builder, OuterContext, ParentScope> {
  function buildRelation<
    Projection extends readonly ExpressionProjectionEntry[],
  >(
    build: (
      subquery: Builder,
      outer: OuterContext,
    ) => ExpressionSubqueryRelation<Projection>,
  ): Readonly<{
    ast: QueryAst;
    projection: Projection;
  }> {
    const subquery = input.createSubquery();
    if (!hasExpressionScope(subquery)) {
      throw new ConfigurationError(
        "Expression subquery builders must expose their query scope.",
        { operation: "expressionSubquery" },
      );
    }
    const childScopeIdentity = subquery.getExpressionScopeIdentity();
    const relation = build(
      subquery,
      input.createOuterContext(childScopeIdentity),
    );
    const ast = relation.toAst();
    assertRelationProvenance(relation, childScopeIdentity, input);
    assertCoordinateMatches(ast, input.parentCoordinate);
    return {
      ast,
      projection: relation.getExpressionProjection(),
    };
  }

  function exists(
    build: (
      subquery: Builder,
      outer: OuterContext,
    ) => ProjectedExpressionSubqueryRelation,
  ): DatabaseExpression<boolean, ParentScope> {
    const { ast, projection } = buildRelation(build);
    if (projection.length === 0) {
      throw new ConfigurationError(
        "$exists() requires an explicit nonempty project() result.",
        { operation: "$exists" },
      );
    }
    return createExistsSubqueryExpression<ParentScope>(
      ast,
      input.parentScopeIdentity,
    );
  }

  function scalar<T>(
    build: (
      subquery: Builder,
      outer: OuterContext,
    ) => ScalarExpressionSubqueryRelation<T>,
  ): DatabaseExpression<T | undefined, ParentScope> {
    const { ast, projection } = buildRelation(build);
    const projected = requireSingleProjection<T>(projection);
    const ungroupedAggregate =
      ast.groupBy === undefined && isAggregateExpression(projected.expression);
    if (!ungroupedAggregate && (ast.limit === undefined || ast.limit > 1)) {
      throw new ConfigurationError(
        "$scalar() requires limit(1) or an ungrouped aggregate subquery.",
        { operation: "$scalar" },
      );
    }
    return createScalarSubqueryExpression<T, ParentScope>(
      ast,
      projected.expression,
      input.parentScopeIdentity,
    );
  }

  return { $exists: exists, $scalar: scalar };
}

function assertCoordinateMatches(
  ast: QueryAst,
  parent: Pick<QueryAst, "recordedAsOf" | "temporalMode">,
): void {
  if (
    ast.temporalMode.mode !== parent.temporalMode.mode ||
    ast.temporalMode.asOf !== parent.temporalMode.asOf ||
    ast.recordedAsOf !== parent.recordedAsOf
  ) {
    throw new ConfigurationError(
      "Expression subqueries must use the enclosing query's temporal coordinate.",
      { operation: "expressionSubquery" },
    );
  }
}

function hasExpressionScope(
  value: unknown,
): value is Readonly<{ getExpressionScopeIdentity: () => symbol }> {
  return (
    typeof value === "object" &&
    value !== null &&
    "getExpressionScopeIdentity" in value &&
    typeof value.getExpressionScopeIdentity === "function"
  );
}

function assertRelationProvenance<Builder, OuterContext>(
  relation: ExpressionSubqueryRelation<readonly ExpressionProjectionEntry[]>,
  childScopeIdentity: symbol,
  input: CreateExpressionSubqueryHelpersInput<Builder, OuterContext>,
): void {
  if (relation.getExpressionScopeIdentity() !== childScopeIdentity) {
    throw new ConfigurationError(
      "Expression subquery callbacks must return the relation built by their subquery argument.",
      { operation: "expressionSubquery" },
    );
  }
  const provenance = relation.getOneStatementReadProvenance();
  if (
    provenance.graphId !== input.parentProvenance.graphId ||
    provenance.executionTarget !== input.parentProvenance.executionTarget
  ) {
    throw new ConfigurationError(
      "Expression subqueries must use the enclosing query's graph and execution target.",
      { operation: "expressionSubquery" },
    );
  }
}

function requireSingleProjection<T>(
  projection: readonly ExpressionProjectionEntry<T>[],
): ExpressionProjectionEntry<T> {
  if (projection.length !== 1 || projection[0] === undefined) {
    throw new ConfigurationError(
      "$scalar() requires exactly one projected field.",
      { operation: "$scalar", projectionWidth: projection.length },
    );
  }
  return projection[0];
}
