import { ConfigurationError, UnsupportedPredicateError } from "../../errors";
import {
  assertPortableCountDistinctValueType,
  assertPortableScalarValueType,
} from "../aggregate-value-types";
import { type AggregateExpr, type FieldRef, type QueryAst } from "../ast";
import { type DialectAdapter } from "../dialect/types";
import {
  type AggregateOperator,
  type DatabaseExpression,
  type DatabaseExpressionNode,
  type DatabaseLiteral,
  resolveCollectOrder,
} from "../expressions";
import { sql, type SqlFragment } from "../sql-fragment";
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
}>;

function compileLiteral(
  value: DatabaseLiteral,
  dialect: DialectAdapter,
): SqlFragment {
  if (value === undefined) return sql.raw("NULL");
  if (value instanceof Date) return sql`${value.toISOString()}`;
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
    case "collect": {
      throw new UnsupportedPredicateError(
        "COLLECT must be compiled through its ordered operand-aware path",
      );
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

function compileNode(
  expression: DatabaseExpression,
  context: DatabaseExpressionCompilerContext,
  aggregateDepth: number,
): SqlFragment {
  const node: DatabaseExpressionNode = expression.node;
  function compile(expression: DatabaseExpression): SqlFragment {
    return compileNode(expression, context, aggregateDepth);
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
      return sql`(${compile(node.left)} ${comparisonOperator(node.operator)} ${compile(node.right)})`;
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
    case "aggregate": {
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
      if (node.operator !== "collect" && node.orderBy !== undefined) {
        throw new UnsupportedPredicateError(
          `${node.operator.toUpperCase()} does not accept aggregate ordering`,
        );
      }
      const operand =
        node.operand === undefined ?
          sql.raw("*")
        : compileNode(node.operand, context, aggregateDepth + 1);
      if (node.operator === "collect") {
        if (context.orderedAggregates !== true)
          throw new ConfigurationError(
            "COLLECT requires ordered aggregate support from the active backend profile.",
            { capability: "orderedAggregates", orderedAggregates: false },
          );
        if (node.operand === undefined)
          throw new UnsupportedPredicateError("COLLECT requires an operand");
        assertPortableScalarValueType(node.operand.valueType, "COLLECT");
        const ordering = resolveCollectOrder(node.orderBy).map((order) => {
          const { direction, nulls } = order;
          const directionSql =
            direction === "asc" ? sql.raw("ASC") : sql.raw("DESC");
          const nullsSql =
            nulls === "first" ? sql.raw("NULLS FIRST") : sql.raw("NULLS LAST");
          return sql`${compileNode(order.expression, context, aggregateDepth + 1)} ${directionSql} ${nullsSql}`;
        });
        return context.dialect.orderedScalarJsonArray(
          operand,
          node.operand.valueType,
          ordering,
        );
      }
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
      return sql`(${context.compileSubquery(node.subquery, "scalar")})`;
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
