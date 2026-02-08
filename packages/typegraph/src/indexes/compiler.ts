import { type SQL, sql } from "drizzle-orm";

import { type ValueType } from "../query/ast";
import { getDialect, type SqlDialect } from "../query/dialect";
import { type JsonPointer, jsonPointer } from "../query/json-pointer";
import {
  type EdgeIndex,
  type IndexWhereExpression,
  type IndexWhereLiteral,
  type IndexWhereOp,
  type IndexWhereOperand,
  type NodeIndex,
  type SystemColumnName,
} from "./types";

// ============================================================
// Public Types
// ============================================================

export type IndexCompilationContext = Readonly<{
  dialect: SqlDialect;
  propsColumn: SQL;
  systemColumn: (column: SystemColumnName) => SQL;
}>;

type CompiledIndexKeys = Readonly<{
  /** SQL expressions in index key order */
  keys: readonly SQL[];
}>;

// ============================================================
// Index Key Compilation
// ============================================================

export function compileNodeIndexKeys(
  index: NodeIndex,
  dialect: SqlDialect,
  propsColumn: SQL,
  systemColumn: (column: SystemColumnName) => SQL,
): CompiledIndexKeys {
  const adapter = getDialect(dialect);
  const keys: SQL[] = [];

  for (const column of getNodeScopeColumns(index.scope)) {
    keys.push(systemColumn(column));
  }

  const allPointers = [...index.fields, ...index.coveringFields];
  const allValueTypes = [
    ...index.fieldValueTypes,
    ...index.coveringFieldValueTypes,
  ];

  for (const [pointerIndex, pointer] of allPointers.entries()) {
    const valueType = allValueTypes[pointerIndex];
    const extracted = compileIndexKeyValue(
      adapter,
      propsColumn,
      pointer,
      valueType,
    );
    keys.push(sql`(${extracted})`);
  }

  return { keys };
}

export function compileEdgeIndexKeys(
  index: EdgeIndex,
  dialect: SqlDialect,
  propsColumn: SQL,
  systemColumn: (column: SystemColumnName) => SQL,
): CompiledIndexKeys {
  const adapter = getDialect(dialect);
  const keys: SQL[] = [];

  for (const column of getEdgeScopeColumns(index.scope, index.direction)) {
    keys.push(systemColumn(column));
  }

  const allPointers = [...index.fields, ...index.coveringFields];
  const allValueTypes = [
    ...index.fieldValueTypes,
    ...index.coveringFieldValueTypes,
  ];

  for (const [pointerIndex, pointer] of allPointers.entries()) {
    const valueType = allValueTypes[pointerIndex];
    const extracted = compileIndexKeyValue(
      adapter,
      propsColumn,
      pointer,
      valueType,
    );
    keys.push(sql`(${extracted})`);
  }

  return { keys };
}

function compileIndexKeyValue(
  dialect: ReturnType<typeof getDialect>,
  propsColumn: SQL,
  pointer: JsonPointer,
  valueType: ValueType | undefined,
): SQL {
  switch (valueType) {
    case "number": {
      return dialect.jsonExtractNumber(propsColumn, pointer);
    }
    case "boolean": {
      return dialect.jsonExtractBoolean(propsColumn, pointer);
    }
    case "date": {
      return dialect.jsonExtractDate(propsColumn, pointer);
    }
    case "string":
    case "unknown":
    case undefined: {
      return dialect.jsonExtractText(propsColumn, pointer);
    }
    case "array":
    case "object":
    case "embedding": {
      // For advanced index types (GIN/json), callers should use dialect.jsonExtract
      // or index the props column directly. We keep this as a conservative fallback.
      return dialect.jsonExtract(propsColumn, pointer);
    }
  }
}

function getNodeScopeColumns(
  scope: NodeIndex["scope"],
): readonly SystemColumnName[] {
  switch (scope) {
    case "graphAndKind": {
      return ["graph_id", "kind"];
    }
    case "graph": {
      return ["graph_id"];
    }
    case "none": {
      return [];
    }
  }
}

function getEdgeScopeColumns(
  scope: EdgeIndex["scope"],
  direction: EdgeIndex["direction"],
): readonly SystemColumnName[] {
  const base =
    scope === "graphAndKind" ? (["graph_id", "kind"] as const)
    : scope === "graph" ? (["graph_id"] as const)
    : ([] as const);

  if (direction === "out") {
    return [...base, "from_id"];
  }
  if (direction === "in") {
    return [...base, "to_id"];
  }
  return [...base];
}

// ============================================================
// WHERE Clause Compilation
// ============================================================

function isIndexWhereLiteralList(
  value: IndexWhereLiteral | readonly IndexWhereLiteral[],
): value is readonly IndexWhereLiteral[] {
  return Array.isArray(value);
}

export function compileIndexWhere(
  ctx: IndexCompilationContext,
  expression: IndexWhereExpression,
): SQL {
  switch (expression.__type) {
    case "index_where_and": {
      return sql`(${sql.join(
        expression.predicates.map((p) => compileIndexWhere(ctx, p)),
        sql` AND `,
      )})`;
    }
    case "index_where_or": {
      return sql`(${sql.join(
        expression.predicates.map((p) => compileIndexWhere(ctx, p)),
        sql` OR `,
      )})`;
    }
    case "index_where_not": {
      return sql`(NOT ${compileIndexWhere(ctx, expression.predicate)})`;
    }
    case "index_where_null_check": {
      const operand = compileIndexWhereOperand(ctx, expression.operand);
      return expression.op === "isNull" ?
          sql`${operand} IS NULL`
        : sql`${operand} IS NOT NULL`;
    }
    case "index_where_comparison": {
      const left = compileIndexWhereOperand(ctx, expression.left);

      const right = expression.right;
      if (isIndexWhereLiteralList(right)) {
        if (expression.op !== "in" && expression.op !== "notIn") {
          throw new Error(
            `Operator "${expression.op}" does not support list comparison in index WHERE clause`,
          );
        }
        const values = right.map((literal) =>
          compileIndexWhereLiteral(ctx.dialect, literal),
        );
        const operator = expression.op === "in" ? sql`IN` : sql`NOT IN`;
        return sql`${left} ${operator} (${sql.join(values, sql`, `)})`;
      }

      if (expression.op === "in" || expression.op === "notIn") {
        throw new Error(
          `Operator "${expression.op}" requires a list of values in index WHERE clause`,
        );
      }

      const rightLiteral = compileIndexWhereLiteral(ctx.dialect, right);
      const opSql = compileComparisonOperator(expression.op);
      return sql`${left} ${opSql} ${rightLiteral}`;
    }
  }
}

function compileIndexWhereOperand(
  ctx: IndexCompilationContext,
  operand: IndexWhereOperand,
): SQL {
  if (operand.__type === "index_operand_system") {
    return ctx.systemColumn(operand.column);
  }

  const adapter = getDialect(ctx.dialect);
  const pointer = jsonPointer([operand.field]);

  switch (operand.valueType) {
    case "number": {
      return adapter.jsonExtractNumber(ctx.propsColumn, pointer);
    }
    case "boolean": {
      return adapter.jsonExtractBoolean(ctx.propsColumn, pointer);
    }
    case "date": {
      return adapter.jsonExtractDate(ctx.propsColumn, pointer);
    }
    case "array":
    case "object":
    case "embedding": {
      return adapter.jsonExtract(ctx.propsColumn, pointer);
    }
    case "string":
    case "unknown":
    case undefined: {
      return adapter.jsonExtractText(ctx.propsColumn, pointer);
    }
  }
}

function compileIndexWhereLiteral(
  dialect: SqlDialect,
  literal: IndexWhereLiteral,
): SQL {
  switch (literal.valueType) {
    case "string":
    case "date": {
      return sql.raw(escapeStringLiteral(literal.value.toString()));
    }
    case "number": {
      return sql.raw(literal.value.toString());
    }
    case "boolean": {
      return getDialect(dialect).booleanLiteral(literal.value as boolean);
    }
    case "array":
    case "object":
    case "embedding":
    case "unknown": {
      return sql.raw(escapeStringLiteral(literal.value.toString()));
    }
  }
}

type ComparisonIndexWhereOp = Exclude<IndexWhereOp, "in" | "notIn">;

function compileComparisonOperator(op: ComparisonIndexWhereOp): SQL {
  switch (op) {
    case "eq": {
      return sql`=`;
    }
    case "neq": {
      return sql`<>`;
    }
    case "gt": {
      return sql`>`;
    }
    case "gte": {
      return sql`>=`;
    }
    case "lt": {
      return sql`<`;
    }
    case "lte": {
      return sql`<=`;
    }
  }
}

function escapeStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
