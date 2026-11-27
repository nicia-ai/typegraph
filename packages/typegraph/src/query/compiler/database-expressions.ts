import { ConfigurationError, UnsupportedPredicateError } from "../../errors";
import { dateInstantText } from "../../utils/date";
import {
  assertPortableCountDistinctValueType,
  assertPortableScalarValueType,
} from "../aggregate-value-types";
import {
  type AggregateExpr,
  type FieldRef,
  type QueryAst,
  type ValueType,
} from "../ast";
import { dateTypedComparisonSubqueries } from "../compared-operands";
import { type DialectAdapter } from "../dialect/types";
import {
  type AggregateOperator,
  arrayExpressionElementType,
  assertPortableArrayMembershipElementType,
  type DatabaseExpression,
  type DatabaseExpressionNode,
  type DatabaseLiteral,
  isCollectRecordOperand,
  isCollectScalarOperand,
  resolveCollectFilter,
  resolveCollectOrder,
  resolveCollectRecordFields,
} from "../expressions";
import { compileOrderTerm } from "../order";
import { sql, type SqlFragment } from "../sql-fragment";
import { isAggregateExpression } from "./expression-inspection";
import { compileFieldValue } from "./predicates";

export type DatabaseExpressionCompilerContext = Readonly<{
  dialect: DialectAdapter;
  cteColumnPrefix?: string;
  allowAggregates?: boolean;
  aggregateClause?: string;
  orderedAggregates?: boolean;
  /** Resolves fields for non-graph sources such as derived relation outputs. */
  compileFieldExpression?: (
    field: FieldRef,
    expression: DatabaseExpression,
  ) => SqlFragment | undefined;
  resolveFieldCteAlias?: (field: FieldRef) => string | undefined;
  compileSubquery?: (
    subquery: QueryAst,
    kind: "exists" | "scalar",
  ) => SqlFragment;
  compileOuterReference?: (
    expression: DatabaseExpression,
    outerScopeIdentity: symbol,
  ) => SqlFragment;
  /**
   * The `$scalar()` subqueries an enclosing comparison compares with a date
   * whose projected literal or parameter the engine cannot type
   * (`dateTypedComparisonSubqueries`); each compiles typed as a date.
   */
  dateTypedSubqueries?: ReadonlySet<DatabaseExpression>;
}>;

/**
 * `context` with `subqueries` added to the subqueries it types as dates.
 */
function withDateTypedSubqueries(
  context: DatabaseExpressionCompilerContext,
  subqueries: readonly DatabaseExpression[],
): DatabaseExpressionCompilerContext {
  if (subqueries.length === 0) return context;
  return {
    ...context,
    dateTypedSubqueries: new Set([
      ...(context.dateTypedSubqueries ?? []),
      ...subqueries,
    ]),
  };
}

function compileLiteral(
  value: DatabaseLiteral,
  dialect: DialectAdapter,
): SqlFragment {
  if (value === undefined) return sql.raw("NULL");
  if (value instanceof Date) return sql`${dateInstantText(value)}`;
  if (typeof value === "object") return sql`${JSON.stringify(value)}`;
  if (typeof value === "boolean") return dialect.booleanLiteral(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new UnsupportedPredicateError(
        "Database expression numeric literals must be finite",
      );
    }
    return sql.raw(String(value));
  }
  return sql`${value}`;
}

function comparisonOperator(
  operator: "eq" | "gt" | "gte" | "lt" | "lte" | "neq",
): SqlFragment {
  switch (operator) {
    case "eq": {
      return sql.raw("=");
    }
    case "neq": {
      return sql.raw("<>");
    }
    case "gt": {
      return sql.raw(">");
    }
    case "gte": {
      return sql.raw(">=");
    }
    case "lt": {
      return sql.raw("<");
    }
    case "lte": {
      return sql.raw("<=");
    }
  }
}

function aggregateFunction(operator: AggregateOperator): SqlFragment {
  switch (operator) {
    case "avg": {
      return sql.raw("AVG");
    }
    case "count": {
      return sql.raw("COUNT");
    }
    case "max": {
      return sql.raw("MAX");
    }
    case "min": {
      return sql.raw("MIN");
    }
    case "sum": {
      return sql.raw("SUM");
    }
    case "countDistinct": {
      throw new UnsupportedPredicateError(
        "COUNT DISTINCT must be compiled through its operand-aware path",
      );
    }
    default: {
      throw new UnsupportedPredicateError(
        `Unknown aggregate function: ${String(operator)}`,
      );
    }
  }
}

/**
 * A value as it enters a collected JSON array: a date as the canonical UTC
 * text the dialect renders for JSON (`jsonDateText`), collected as the string
 * it then is, so every backend emits the same bytes whatever its session time
 * zone; any other value as compiled.
 */
function collectedValue(
  name: string,
  value: SqlFragment,
  valueType: ValueType,
  context: DatabaseExpressionCompilerContext,
): Readonly<{ name: string; value: SqlFragment; valueType: ValueType }> {
  return valueType === "date" ?
      { name, value: context.dialect.jsonDateText(value), valueType: "string" }
    : { name, value, valueType };
}

function compileNode(
  expression: DatabaseExpression,
  context: DatabaseExpressionCompilerContext,
  aggregateDepth: number,
): SqlFragment {
  const node: DatabaseExpressionNode = expression.node;
  function compile(expression: DatabaseExpression): SqlFragment {
    return compileNode(expression, context, aggregateDepth);
  }

  if (isAggregateExpression(expression)) {
    if (context.allowAggregates === false) {
      throw new UnsupportedPredicateError(
        `Aggregate expressions are not allowed in ${context.aggregateClause ?? "this query"} clauses`,
      );
    }
    if (aggregateDepth > 0) {
      throw new UnsupportedPredicateError(
        "Nested aggregate expressions are not supported",
      );
    }
  }
  switch (node.kind) {
    case "field": {
      const resolved = context.compileFieldExpression?.(node.field, expression);
      if (resolved !== undefined) return resolved;
      return compileFieldValue(
        node.field,
        context.dialect,
        expression.valueType,
        context.resolveFieldCteAlias?.(node.field),
        undefined,
        context.cteColumnPrefix,
      );
    }
    case "literal": {
      return compileLiteral(node.value, context.dialect);
    }
    case "parameter": {
      return sql.placeholder(node.name);
    }
    case "arithmetic": {
      const left = compile(node.left);
      const right = compile(node.right);
      switch (node.operator) {
        case "add": {
          return sql`(${left} + ${right})`;
        }
        case "subtract": {
          return sql`(${left} - ${right})`;
        }
        case "multiply": {
          return sql`(${left} * ${right})`;
        }
        case "divide": {
          return sql`(1.0 * ${left} / NULLIF(${right}, 0))`;
        }
      }
      throw new UnsupportedPredicateError(
        "Unknown database arithmetic operator",
      );
    }
    case "comparison": {
      const sideContext = withDateTypedSubqueries(
        context,
        dateTypedComparisonSubqueries(expression),
      );
      const left = compileNode(node.left, sideContext, aggregateDepth);
      const right = compileNode(node.right, sideContext, aggregateDepth);
      return sql`(${left} ${comparisonOperator(node.operator)} ${right})`;
    }
    case "array_contains": {
      const elementType = arrayExpressionElementType(node.array);
      if (elementType === undefined)
        throw new UnsupportedPredicateError(
          "Array membership requires a known element type",
        );
      assertPortableArrayMembershipElementType(elementType);
      if (context.dialect.jsonArrayContainsExpression === undefined) {
        throw new ConfigurationError(
          "The active dialect adapter does not support the jsonArrayContainsExpression capability.",
          { capability: "jsonArrayContainsExpression" },
        );
      }
      return context.dialect.jsonArrayContainsExpression(
        compile(node.array),
        compile(node.element),
        elementType,
      );
    }
    case "boolean": {
      const separator = node.operator === "and" ? sql` AND ` : sql` OR `;
      return sql`(${sql.join(
        node.operands.map((operand) => compile(operand)),
        separator,
      )})`;
    }
    case "not": {
      return sql`NOT (${compile(node.operand)})`;
    }
    case "null_check": {
      const operator =
        node.operator === "isNull" ?
          sql.raw("IS NULL")
        : sql.raw("IS NOT NULL");
      return sql`(${compile(node.operand)} ${operator})`;
    }
    case "collect": {
      if (context.orderedAggregates !== true)
        throw new ConfigurationError(
          "COLLECT requires ordered aggregate support from the active backend profile.",
          { capability: "orderedAggregates", orderedAggregates: false },
        );
      const operand = node.operand;
      if (!isCollectScalarOperand(operand) && !isCollectRecordOperand(operand))
        throw new UnsupportedPredicateError("Unknown COLLECT operand kind");
      const ordering = resolveCollectOrder(node.orderBy).map((order) => {
        const { direction, nulls } = order;
        return compileOrderTerm(
          compileNode(order.expression, context, aggregateDepth + 1),
          direction,
          nulls,
        );
      });
      const filter = resolveCollectFilter(node.filter);
      const compiledFilter =
        filter === undefined ? undefined : (
          compileNode(filter, context, aggregateDepth + 1)
        );
      if (isCollectRecordOperand(operand)) {
        return context.dialect.orderedRecordJsonArray({
          fields: resolveCollectRecordFields(operand.fields).map(
            ({ name, expression: value }) =>
              collectedValue(
                name,
                compileNode(value, context, aggregateDepth + 1),
                value.valueType,
                context,
              ),
          ),
          filter: compiledFilter,
          orderBy: ordering,
        });
      }
      assertPortableScalarValueType(operand.valueType, "COLLECT");
      const { value, valueType } = collectedValue(
        "",
        compileNode(operand, context, aggregateDepth + 1),
        operand.valueType,
        context,
      );
      return context.dialect.orderedScalarJsonArray({
        filter: compiledFilter,
        orderBy: ordering,
        value,
        valueType,
      });
    }
    case "aggregate": {
      const operand =
        node.operand === undefined ?
          sql.raw("*")
        : compileNode(node.operand, context, aggregateDepth + 1);
      if (node.operator === "countDistinct") {
        if (node.operand === undefined) {
          throw new UnsupportedPredicateError(
            "COUNT DISTINCT requires an operand",
          );
        }
        assertPortableCountDistinctValueType(node.operand.valueType);
        return sql`COUNT(DISTINCT ${operand})`;
      }
      return sql`${aggregateFunction(node.operator)}(${operand})`;
    }
    case "coalesce": {
      return sql`COALESCE(${sql.join(
        node.operands.map((operand) => compile(operand)),
        sql`, `,
      )})`;
    }
    case "conditional": {
      return sql`CASE WHEN ${compile(node.condition)} THEN ${compile(node.then)} ELSE ${compile(node.otherwise)} END`;
    }
    case "numeric_conversion": {
      if (node.operand.valueType === "number") return compile(node.operand);
      return context.dialect.safeNumericConversion(compile(node.operand));
    }
    case "outer_reference": {
      if (context.compileOuterReference === undefined) {
        throw new UnsupportedPredicateError(
          "Outer references are not available in this expression compiler scope",
        );
      }
      return context.compileOuterReference(
        node.expression,
        node.outerScopeIdentity,
      );
    }
    case "exists_subquery": {
      if (context.compileSubquery === undefined) {
        throw new UnsupportedPredicateError(
          "Expression subqueries are not available in this compiler scope",
        );
      }
      return sql`EXISTS (${context.compileSubquery(node.subquery, "exists")})`;
    }
    case "scalar_subquery": {
      if (context.compileSubquery === undefined) {
        throw new UnsupportedPredicateError(
          "Expression subqueries are not available in this compiler scope",
        );
      }
      const subquery = sql`(${context.compileSubquery(node.subquery, "scalar")})`;
      return context.dateTypedSubqueries?.has(expression) === true ?
          context.dialect.dateValue(subquery)
        : subquery;
    }
  }

  throw new UnsupportedPredicateError("Unknown database expression node");
}

/** Compiles a portable typed expression into the current query's SQL scope. */
export function compileDatabaseExpression(
  expression: DatabaseExpression,
  context: DatabaseExpressionCompilerContext,
): SqlFragment {
  return compileNode(expression, context, 0);
}

/** Routes the legacy aggregate AST through the shared expression emitter. */
export function compileLegacyAggregateExpression(
  aggregate: AggregateExpr,
  context: DatabaseExpressionCompilerContext,
): SqlFragment {
  const scopeIdentity = Symbol("legacy aggregate expression");
  const operand: DatabaseExpression = {
    __type: "database_expression",
    node: { field: aggregate.field, kind: "field" },
    nullable: true,
    scopeIdentity,
    valueType: aggregate.field.valueType ?? "unknown",
  };
  return compileDatabaseExpression(
    {
      __type: "database_expression",
      node: {
        kind: "aggregate",
        operand,
        operator: aggregate.function,
      },
      nullable:
        aggregate.function !== "count" &&
        aggregate.function !== "countDistinct",
      scopeIdentity,
      valueType:
        aggregate.function === "min" || aggregate.function === "max" ?
          operand.valueType
        : "number",
    },
    context,
  );
}
