import { ConfigurationError } from "../errors";
import { type ValueType } from "../query/ast";
import { getDialect } from "../query/dialect";
import { type SqlDialect } from "../query/dialect/types";
import { type JsonPointer, jsonPointer } from "../query/json-pointer";
import { sql, type SqlFragment } from "../query/sql-fragment";
import {
  getNodeScopeColumns,
  parseNodeIndexKeyDirection,
  validateEdgeIndexKeysPresence,
  validateIndexFieldValueTypes,
  validateNodeIndexKeyContract,
} from "./node-key-contract";
import {
  type EdgeIndexDeclaration,
  type IndexWhereExpression,
  type IndexWhereLiteral,
  type IndexWhereOp,
  type IndexWhereOperand,
  type NodeIndexDeclaration,
  type RelationalIndexDeclaration,
  type SystemColumnName,
} from "./types";

// ============================================================
// Public Types
// ============================================================

export type IndexCompilationContext = Readonly<{
  dialect: SqlDialect;
  propsColumn: SqlFragment;
  systemColumn: (column: SystemColumnName) => SqlFragment;
}>;

type CompiledIndexKeys = Readonly<{
  /** SQL expressions in index key order */
  keys: readonly SqlFragment[];
}>;

// ============================================================
// Index Key Compilation
// ============================================================

/**
 * One field of a relational index paired with its value type: a lookup
 * field (`position: "key"`) or a covering column (`"coveringField"`).
 */
export type IndexFieldValueType = Readonly<{
  pointer: JsonPointer;
  valueType: ValueType | undefined;
  position: "key" | "coveringField";
}>;

/**
 * Every lookup field, then every covering field, of `index`, each paired
 * with its own value type — the order the index key columns are built in.
 *
 * The one pairing of a field with the value type its extraction uses: the
 * key compilation below, {@link compileNodeIndexFieldKeys} and
 * {@link findDateIndexExpression} all read it, so the field the DDL casts is
 * the field the capability gate classifies. Refuses with a
 * `ConfigurationError` (`INDEX_FIELD_VALUE_TYPES_MISMATCH`) when an array of
 * fields and its array of value types differ in length, rather than pairing a
 * field with a neighbour's type.
 */
export function pairIndexFieldValueTypes(
  index: RelationalIndexDeclaration,
): readonly IndexFieldValueType[] {
  const mismatch = validateIndexFieldValueTypes(index);
  if (mismatch !== undefined) {
    throw new ConfigurationError(mismatch, {
      code: "INDEX_FIELD_VALUE_TYPES_MISMATCH",
      indexName: index.name,
      kind: index.kind,
    });
  }
  return [
    ...index.fields.map((pointer, position) => ({
      pointer,
      valueType: index.fieldValueTypes[position],
      position: "key" as const,
    })),
    ...index.coveringFields.map((pointer, position) => ({
      pointer,
      valueType: index.coveringFieldValueTypes[position],
      position: "coveringField" as const,
    })),
  ];
}

export function compileNodeIndexKeys(
  index: NodeIndexDeclaration,
  dialect: SqlDialect,
  propsColumn: SqlFragment,
  systemColumn: (column: SystemColumnName) => SqlFragment,
): CompiledIndexKeys {
  if (index.keys !== undefined) {
    const contractError = validateNodeIndexKeyContract({
      keys: index.keys,
      fields: index.fields,
      coveringFields: index.coveringFields,
      keySystemColumns: index.keySystemColumns,
      unique: index.unique,
      scope: index.scope,
      method: index.method,
    })[0];
    if (contractError !== undefined) throw new Error(contractError);
  }
  const adapter = getDialect(dialect);
  const keys: SqlFragment[] = [];

  const systemColumns = [
    ...getNodeScopeColumns(index.scope),
    ...(index.keySystemColumns ?? []),
  ];
  for (const column of systemColumns) {
    keys.push(systemColumn(column));
  }

  for (const key of index.keys ?? []) {
    const direction = compileIndexKeyDirection(key.direction);
    if (key.type === "system") {
      keys.push(sql`${systemColumn(key.column)} ${direction}`);
      continue;
    }
    const extracted = compileIndexKeyValue(
      adapter,
      propsColumn,
      key.pointer,
      key.valueType,
    );
    keys.push(sql`(${extracted}) ${direction}`);
  }

  for (const { pointer, valueType } of pairIndexFieldValueTypes(index)) {
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

function compileIndexKeyDirection(direction: unknown): SqlFragment {
  const parsed = parseNodeIndexKeyDirection(direction);
  if (parsed === undefined) {
    throw new Error(`Invalid index key direction: ${String(direction)}`);
  }
  return parsed === "asc" ? sql.raw("ASC") : sql.raw("DESC");
}

export function compileEdgeIndexKeys(
  index: EdgeIndexDeclaration,
  dialect: SqlDialect,
  propsColumn: SqlFragment,
  systemColumn: (column: SystemColumnName) => SqlFragment,
): CompiledIndexKeys {
  const edgeKeyError = validateEdgeIndexKeysPresence(index);
  if (edgeKeyError !== undefined) throw new Error(edgeKeyError);
  const adapter = getDialect(dialect);
  const keys: SqlFragment[] = [];

  for (const column of getEdgeScopeColumns(index.scope, index.direction)) {
    keys.push(systemColumn(column));
  }

  for (const { pointer, valueType } of pairIndexFieldValueTypes(index)) {
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

/**
 * Compiles the per-field key-extraction expressions for a node index's
 * **lookup keys** — `index.fields` only, excluding scope columns and
 * `coveringFields` (which are index payload, not part of the lookup key).
 *
 * Each expression is the exact extraction the index DDL builds for that
 * field (via the shared {@link compileIndexKeyValue}), so a runtime lookup
 * predicate stays byte-identical to the materialized index expression —
 * the single source of truth that lets the planner use the physical index.
 */
export function compileNodeIndexFieldKeys(
  index: NodeIndexDeclaration,
  ctx: IndexCompilationContext,
): readonly SqlFragment[] {
  const adapter = getDialect(ctx.dialect);
  const keys: SqlFragment[] = [];
  for (const { pointer, valueType, position } of pairIndexFieldValueTypes(
    index,
  )) {
    if (position !== "key") continue;
    const extracted = compileIndexKeyValue(
      adapter,
      ctx.propsColumn,
      pointer,
      valueType,
    );
    keys.push(sql`(${extracted})`);
  }
  return keys;
}

/**
 * Where a relational index declaration reads a date-typed property: a lookup
 * or ordered key, a covering column (also an index key column), or an operand
 * of its partial-index `where` clause.
 */
export type DateIndexExpression = Readonly<{
  field: JsonPointer;
  position: "key" | "coveringField" | "where";
}>;

/**
 * The first place a relational index declaration reads a date-typed property,
 * or `undefined` when it reads none.
 *
 * The one classifier behind the `dateIndexExpressions` capability. It walks
 * exactly the `(pointer, valueType)` pairs the DDL compilation above hands to
 * {@link compileIndexKeyValue} (through {@link pairIndexFieldValueTypes}, so it
 * refuses the same mismatched declarations) and
 * {@link compileIndexWhereOperand}, the two
 * places a `"date"` value type becomes `jsonExtractDate` — the cast PostgreSQL
 * refuses in an index. A GIN-family declaration indexes one array or string
 * field and has no partial clause (both enforced at declaration), so it never
 * reaches a date extraction.
 */
export function findDateIndexExpression(
  index: RelationalIndexDeclaration,
): DateIndexExpression | undefined {
  if (index.method !== undefined) return undefined;
  if (index.entity === "node") {
    for (const key of index.keys ?? []) {
      if (key.type === "field" && key.valueType === "date") {
        return { field: key.pointer, position: "key" };
      }
    }
  }
  for (const { pointer, valueType, position } of pairIndexFieldValueTypes(
    index,
  )) {
    if (valueType === "date") return { field: pointer, position };
  }
  const whereField =
    index.where === undefined ? undefined : findDateWhereOperand(index.where);
  return whereField === undefined ? undefined : (
      { field: whereField, position: "where" }
    );
}

function findDateWhereOperand(
  expression: IndexWhereExpression,
): JsonPointer | undefined {
  switch (expression.__type) {
    case "index_where_and":
    case "index_where_or": {
      for (const predicate of expression.predicates) {
        const found = findDateWhereOperand(predicate);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    case "index_where_not": {
      return findDateWhereOperand(expression.predicate);
    }
    case "index_where_null_check": {
      return dateWhereOperandField(expression.operand);
    }
    case "index_where_comparison": {
      return dateWhereOperandField(expression.left);
    }
  }
}

function dateWhereOperandField(
  operand: IndexWhereOperand,
): JsonPointer | undefined {
  return (
      operand.__type === "index_operand_prop" && operand.valueType === "date"
    ) ?
      jsonPointer([operand.field])
    : undefined;
}

function compileIndexKeyValue(
  dialect: ReturnType<typeof getDialect>,
  propsColumn: SqlFragment,
  pointer: JsonPointer,
  valueType: ValueType | undefined,
): SqlFragment {
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

function getEdgeScopeColumns(
  scope: EdgeIndexDeclaration["scope"],
  direction: EdgeIndexDeclaration["direction"],
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
): SqlFragment {
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
): SqlFragment {
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
): SqlFragment {
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

function compileComparisonOperator(op: ComparisonIndexWhereOp): SqlFragment {
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
