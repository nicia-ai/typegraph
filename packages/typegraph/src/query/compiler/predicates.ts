/**
 * Predicate Expression Compilation
 *
 * Compiles predicate AST nodes to SQL using dialect adapters.
 * Handles comparisons, string operations, null checks, array/object predicates,
 * and subqueries.
 */
import { type SQL, sql } from "drizzle-orm";

import { UnsupportedPredicateError } from "../../errors";
import {
  type ArrayPredicate,
  type ExistsSubquery,
  type FieldRef,
  type InSubquery,
  type LiteralValue,
  type ObjectPredicate,
  type ParameterRef,
  type PredicateExpression,
  type QueryAst,
  type ValueType,
  type VectorSimilarityPredicate,
} from "../ast";
import { type DialectAdapter } from "../dialect";
import {
  joinJsonPointers,
  type JsonPointer,
  jsonPointer,
} from "../json-pointer";
import { isParameterRef } from "../predicates";
import {
  getSingleSubqueryColumnValueType,
  getSubqueryColumnCount,
  isInSubqueryTypeCompatible,
  isUnsupportedInSubqueryValueType,
} from "../subquery-utils";
import { type SqlSchema } from "./schema";

const COMPARISON_OP_SQL: Record<string, string> = {
  eq: "=",
  neq: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

// ============================================================
// Field Reference Compilation
// ============================================================

/**
 * Compiles a field reference to a base column name.
 *
 * @param field - The field reference to compile
 * @param cteAlias - Optional CTE alias for main query context (e.g., "cte_p")
 * @param cteColumnPrefix - Optional prefix for CTE WHERE context:
 *   - undefined: Use aliased column names (e.g., "p_props")
 *   - "": Use raw column names (e.g., "props") for start CTE
 *   - "n": Use table-qualified names (e.g., "n.props") for traversal CTE
 */
export function compileFieldColumn(
  field: FieldRef,
  cteAlias?: string,
  cteColumnPrefix?: string,
): SQL {
  // When cteColumnPrefix is defined (including empty string), use raw column names
  // This is for CTE WHERE clauses which operate on raw table columns
  if (cteColumnPrefix !== undefined) {
    const qualifier = cteColumnPrefix === "" ? "" : `${cteColumnPrefix}.`;

    if (field.path.length === 1 && field.path[0] === "id") {
      return sql.raw(`${qualifier}id`);
    }
    if (field.path.length === 1 && field.path[0] === "kind") {
      return sql.raw(`${qualifier}kind`);
    }
    if (field.path.length > 0 && field.path[0] === "props") {
      return sql.raw(`${qualifier}props`);
    }

    return sql.raw(`${qualifier}${field.path.join("_")}`);
  }

  // Default behavior: use aliased column names (e.g., "p_props")
  const prefix = field.alias;
  const qualifier = cteAlias ? `${cteAlias}.` : "";

  if (field.path.length === 1 && field.path[0] === "id") {
    return sql.raw(`${qualifier}${prefix}_id`);
  }
  if (field.path.length === 1 && field.path[0] === "kind") {
    return sql.raw(`${qualifier}${prefix}_kind`);
  }
  if (field.path.length > 0 && field.path[0] === "props") {
    return sql.raw(`${qualifier}${prefix}_props`);
  }

  return sql.raw(`${qualifier}${prefix}_${field.path.join("_")}`);
}

/**
 * Gets the JSON pointer for a field reference.
 */
function getFieldPointer(field: FieldRef): JsonPointer | undefined {
  if (field.jsonPointer !== undefined) {
    return field.jsonPointer;
  }

  if (field.path.length > 1 && field.path[0] === "props") {
    return jsonPointer(field.path.slice(1));
  }

  return undefined;
}

/**
 * Checks if a field reference points to a JSON props column.
 */
function isJsonField(field: FieldRef): boolean {
  return field.path.length > 0 && field.path[0] === "props";
}

/**
 * Normalizes a value type, treating "unknown" as undefined.
 */
function normalizeValueType(
  valueType: ValueType | undefined,
): ValueType | undefined {
  if (!valueType || valueType === "unknown") {
    return undefined;
  }
  return valueType;
}

/**
 * Compiles a field reference to SQL with appropriate type extraction.
 */
export function compileFieldValue(
  field: FieldRef,
  dialect: DialectAdapter,
  valueType?: ValueType,
  cteAlias?: string,
  pointerOverride?: JsonPointer,
  cteColumnPrefix?: string,
): SQL {
  const resolved = normalizeValueType(valueType);
  const column = compileFieldColumn(field, cteAlias, cteColumnPrefix);

  if (!isJsonField(field)) {
    return column;
  }

  const pointer = pointerOverride ?? getFieldPointer(field);
  if (!pointer || pointer === "") {
    return column;
  }

  switch (resolved) {
    case "number": {
      return dialect.jsonExtractNumber(column, pointer);
    }
    case "boolean": {
      return dialect.jsonExtractBoolean(column, pointer);
    }
    case "date": {
      return dialect.jsonExtractDate(column, pointer);
    }
    case "array":
    case "object":
    case "embedding": {
      // Embeddings are stored in a separate table, but if we need to
      // extract from JSON, treat like a regular JSON value
      return dialect.jsonExtract(column, pointer);
    }
    case "string":
    case "unknown":
    case undefined: {
      return dialect.jsonExtractText(column, pointer);
    }
  }
}

/**
 * Compiles a field reference for text comparison.
 */
function compileFieldTextValue(
  field: FieldRef,
  dialect: DialectAdapter,
  cteAlias?: string,
  pointerOverride?: JsonPointer,
  cteColumnPrefix?: string,
): SQL {
  const column = compileFieldColumn(field, cteAlias, cteColumnPrefix);
  if (!isJsonField(field)) {
    return column;
  }

  const pointer = pointerOverride ?? getFieldPointer(field);
  if (!pointer || pointer === "") {
    return column;
  }

  return dialect.jsonExtractText(column, pointer);
}

/**
 * Compiles a field reference for JSON value extraction.
 */
function compileFieldJsonValue(
  field: FieldRef,
  dialect: DialectAdapter,
  cteAlias?: string,
  pointerOverride?: JsonPointer,
  cteColumnPrefix?: string,
): SQL {
  const column = compileFieldColumn(field, cteAlias, cteColumnPrefix);
  if (!isJsonField(field)) {
    return column;
  }

  const pointer = pointerOverride ?? getFieldPointer(field);
  if (!pointer || pointer === "") {
    return column;
  }

  return dialect.jsonExtract(column, pointer);
}

// ============================================================
// Value Type Resolution
// ============================================================

/**
 * Resolves literal value types from an array of literals.
 */
function resolveLiteralValueTypes(
  literals: readonly LiteralValue[],
): ValueType | undefined {
  const resolved = new Set<ValueType>();

  for (const literal of literals) {
    const valueType = normalizeValueType(literal.valueType);
    if (valueType) {
      resolved.add(valueType);
    }
  }

  if (resolved.size > 1) {
    throw new UnsupportedPredicateError(
      "Mixed literal value types are not supported in predicates",
      { valueTypes: [...resolved] },
    );
  }

  return resolved.values().next().value;
}

/**
 * Resolves the value type for a comparison predicate.
 */
function resolveComparisonValueType(
  field: FieldRef,
  right: LiteralValue | readonly LiteralValue[] | ParameterRef,
): ValueType | undefined {
  if (isParameterRef(right)) {
    return (
      normalizeValueType(right.valueType) ?? normalizeValueType(field.valueType)
    );
  }
  const literals = Array.isArray(right) ? right : [right];
  const literalType = resolveLiteralValueTypes(literals);
  const fieldType = normalizeValueType(field.valueType);

  // Date fields compared with string literals should use date type
  if (fieldType === "date" && literalType === "string") {
    return fieldType;
  }

  if (literalType) {
    return literalType;
  }

  return fieldType;
}

/**
 * Resolves value type with preference for explicit type.
 */
function resolvePredicateValueType(
  preferred: ValueType | undefined,
  literal: LiteralValue | undefined,
): ValueType | undefined {
  const normalizedPreferred = normalizeValueType(preferred);
  if (normalizedPreferred) {
    return normalizedPreferred;
  }

  return literal ? normalizeValueType(literal.valueType) : undefined;
}

// ============================================================
// Value Conversion
// ============================================================

/**
 * Converts a literal value for SQL binding.
 * Delegates to dialect adapter for proper type conversion (e.g., boolean → 0/1 for SQLite).
 */
function convertValueForSql(value: unknown, dialect: DialectAdapter): unknown {
  return dialect.bindValue(value);
}

// ============================================================
// String Pattern Compilation
// ============================================================

/**
 * Compiles a string pattern for LIKE operations.
 */
function compileStringPattern(op: string, pattern: string): string {
  const escaped = pattern
    .replaceAll("%", String.raw`\%`)
    .replaceAll("_", String.raw`\_`);

  switch (op) {
    case "contains": {
      return `%${escaped}%`;
    }
    case "startsWith": {
      return `${escaped}%`;
    }
    case "endsWith": {
      return `%${escaped}`;
    }
    case "like":
    case "ilike": {
      return pattern;
    }
    default: {
      return escaped;
    }
  }
}

/**
 * Escapes wildcard characters in a SQL pattern parameter.
 */
function escapeLikePatternParameter(parameter: SQL): SQL {
  return sql`REPLACE(REPLACE(REPLACE(${parameter}, '\\', '\\\\'), '%', '\\%'), '_', '\\_')`;
}

/**
 * Builds a SQL pattern expression for parameterized string operations.
 */
function compileParameterizedStringPattern(op: string, parameter: SQL): SQL {
  switch (op) {
    case "contains": {
      const escaped = escapeLikePatternParameter(parameter);
      return sql`'%' || ${escaped} || '%'`;
    }
    case "startsWith": {
      const escaped = escapeLikePatternParameter(parameter);
      return sql`${escaped} || '%'`;
    }
    case "endsWith": {
      const escaped = escapeLikePatternParameter(parameter);
      return sql`'%' || ${escaped}`;
    }
    case "like":
    case "ilike": {
      return parameter;
    }
    default: {
      return escapeLikePatternParameter(parameter);
    }
  }
}

// ============================================================
// Predicate Compilation
// ============================================================

/**
 * Compiler context passed to recursive compilation functions.
 *
 * When compiling predicates inside CTE WHERE clauses, `cteColumnPrefix` specifies
 * how to reference columns:
 * - undefined: Use aliased column names (e.g., "p_props") - for main query context
 * - "": Use raw column names (e.g., "props") - for start CTE WHERE clause
 * - "n": Use table-qualified names (e.g., "n.props") - for traversal CTE WHERE clause
 */
export type PredicateCompilerContext = Readonly<{
  dialect: DialectAdapter;
  schema: SqlSchema;
  compileQuery: (ast: QueryAst, graphId: string) => SQL;
  cteColumnPrefix?: string;
}>;

/**
 * Compiles a predicate expression to SQL.
 */
export function compilePredicateExpression(
  expr: PredicateExpression,
  ctx: PredicateCompilerContext,
): SQL {
  const { dialect } = ctx;

  const cteColumnPrefix = ctx.cteColumnPrefix;

  switch (expr.__type) {
    case "comparison": {
      return compileComparisonPredicate(expr, dialect, cteColumnPrefix);
    }

    case "string_op": {
      const field = compileFieldTextValue(
        expr.field,
        dialect,
        undefined,
        undefined,
        cteColumnPrefix,
      );

      if (isParameterRef(expr.pattern)) {
        const placeholder = sql`${sql.placeholder(expr.pattern.name)}`;
        const pattern = compileParameterizedStringPattern(expr.op, placeholder);
        if (
          expr.op === "ilike" ||
          expr.op === "contains" ||
          expr.op === "startsWith" ||
          expr.op === "endsWith"
        ) {
          return dialect.ilike(field, pattern);
        }
        return sql`${field} LIKE ${pattern}`;
      }

      const pattern = compileStringPattern(expr.op, expr.pattern);
      // Use case-insensitive matching for contains, startsWith, endsWith, and ilike
      // This ensures consistent behavior across PostgreSQL (case-sensitive LIKE)
      // and SQLite (case-insensitive LIKE for ASCII)
      if (
        expr.op === "ilike" ||
        expr.op === "contains" ||
        expr.op === "startsWith" ||
        expr.op === "endsWith"
      ) {
        return dialect.ilike(field, pattern);
      }
      // Use case-sensitive LIKE only for explicit 'like' operator
      return sql`${field} LIKE ${pattern}`;
    }

    case "null_check": {
      const field = compileFieldTextValue(
        expr.field,
        dialect,
        undefined,
        undefined,
        cteColumnPrefix,
      );
      return expr.op === "isNull" ?
          sql`${field} IS NULL`
        : sql`${field} IS NOT NULL`;
    }

    case "between": {
      const lowerIsParam = isParameterRef(expr.lower);
      const upperIsParam = isParameterRef(expr.upper);

      // Resolve value type from non-param bounds
      const boundsForType: LiteralValue[] = [];
      if (!lowerIsParam) boundsForType.push(expr.lower);
      if (!upperIsParam) boundsForType.push(expr.upper);

      const valueType =
        boundsForType.length > 0 ?
          resolveComparisonValueType(expr.field, boundsForType)
        : normalizeValueType(expr.field.valueType);

      if (valueType === "array" || valueType === "object") {
        throw new UnsupportedPredicateError(
          "Between comparisons are not supported for JSON arrays or objects",
        );
      }
      const field = compileFieldValue(
        expr.field,
        dialect,
        valueType,
        undefined,
        undefined,
        cteColumnPrefix,
      );
      const lower =
        lowerIsParam ?
          sql.placeholder(expr.lower.name)
        : convertValueForSql(expr.lower.value, dialect);
      const upper =
        upperIsParam ?
          sql.placeholder(expr.upper.name)
        : convertValueForSql(expr.upper.value, dialect);
      return sql`${field} BETWEEN ${lower} AND ${upper}`;
    }

    case "and": {
      const parts = expr.predicates.map((p) =>
        compilePredicateExpression(p, ctx),
      );
      return sql`(${sql.join(parts, sql` AND `)})`;
    }

    case "or": {
      const parts = expr.predicates.map((p) =>
        compilePredicateExpression(p, ctx),
      );
      return sql`(${sql.join(parts, sql` OR `)})`;
    }

    case "not": {
      const inner = compilePredicateExpression(expr.predicate, ctx);
      return sql`NOT (${inner})`;
    }

    case "array_op": {
      return compileArrayPredicate(expr, dialect, cteColumnPrefix);
    }

    case "object_op": {
      return compileObjectPredicate(expr, dialect, cteColumnPrefix);
    }

    case "aggregate_comparison": {
      return compileAggregatePredicate(expr, dialect);
    }

    case "exists": {
      return compileExistsSubquery(expr, ctx);
    }

    case "in_subquery": {
      return compileInSubquery(expr, ctx);
    }

    case "vector_similarity": {
      return compileVectorSimilarityPredicate(expr, ctx);
    }
  }
}

/**
 * Compiles a comparison predicate.
 */
function compileComparisonPredicate(
  expr: {
    __type: "comparison";
    op: string;
    left: FieldRef;
    right: LiteralValue | readonly LiteralValue[] | ParameterRef;
  },
  dialect: DialectAdapter,
  cteColumnPrefix?: string,
): SQL {
  // Handle ParameterRef on the right side
  if (isParameterRef(expr.right)) {
    const parameterValueType =
      normalizeValueType(expr.right.valueType) ??
      normalizeValueType(expr.left.valueType);
    const left = compileFieldValue(
      expr.left,
      dialect,
      parameterValueType,
      undefined,
      undefined,
      cteColumnPrefix,
    );
    const opSql = COMPARISON_OP_SQL[expr.op];
    if (!opSql) {
      throw new UnsupportedPredicateError(
        `Comparison operation "${expr.op}" is not supported for parameterized predicates`,
      );
    }
    return sql`${left} ${sql.raw(opSql)} ${sql.placeholder(expr.right.name)}`;
  }

  const valueType = resolveComparisonValueType(expr.left, expr.right);

  if (valueType === "array" || valueType === "object") {
    throw new UnsupportedPredicateError(
      `Comparison operation "${expr.op}" is not supported for ${valueType} values`,
    );
  }

  const left = compileFieldValue(
    expr.left,
    dialect,
    valueType,
    undefined,
    undefined,
    cteColumnPrefix,
  );

  if (expr.op === "in" || expr.op === "notIn") {
    const values: readonly LiteralValue[] =
      Array.isArray(expr.right) ? expr.right : [expr.right as LiteralValue];
    if (values.length === 0) {
      return expr.op === "in" ? sql.raw("1=0") : sql.raw("1=1");
    }
    const placeholders = values.map(
      (v) => sql`${convertValueForSql(v.value, dialect)}`,
    );
    const op = expr.op === "in" ? sql.raw("IN") : sql.raw("NOT IN");
    return sql`${left} ${op} (${sql.join(placeholders, sql`, `)})`;
  }

  // For single-value comparisons, extract the literal value
  const right = expr.right;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Type narrowing with Array.isArray
  const rightValue: LiteralValue = Array.isArray(right) ? right[0]! : right;

  const convertedRight = convertValueForSql(rightValue.value, dialect);
  const opSql = COMPARISON_OP_SQL[expr.op];
  if (!opSql) {
    throw new UnsupportedPredicateError(
      `Comparison operation "${expr.op}" is not supported`,
    );
  }
  return sql`${left} ${sql.raw(opSql)} ${convertedRight}`;
}

/**
 * Compiles an array predicate.
 */
function compileArrayPredicate(
  expr: ArrayPredicate,
  dialect: DialectAdapter,
  cteColumnPrefix?: string,
): SQL {
  const field = compileFieldJsonValue(
    expr.field,
    dialect,
    undefined,
    undefined,
    cteColumnPrefix,
  );
  const values =
    expr.values?.map((v) => convertValueForSql(v.value, dialect)) ?? [];

  switch (expr.op) {
    case "isEmpty": {
      return sql`(${field} IS NULL OR ${dialect.jsonArrayLength(field)} = 0)`;
    }
    case "isNotEmpty": {
      return sql`(${field} IS NOT NULL AND ${dialect.jsonArrayLength(field)} > 0)`;
    }
    case "lengthEq": {
      return sql`${dialect.jsonArrayLength(field)} = ${expr.length}`;
    }
    case "lengthGt": {
      return sql`${dialect.jsonArrayLength(field)} > ${expr.length}`;
    }
    case "lengthGte": {
      return sql`${dialect.jsonArrayLength(field)} >= ${expr.length}`;
    }
    case "lengthLt": {
      return sql`${dialect.jsonArrayLength(field)} < ${expr.length}`;
    }
    case "lengthLte": {
      return sql`${dialect.jsonArrayLength(field)} <= ${expr.length}`;
    }
    case "contains": {
      const value = values[0];
      if (value === undefined) {
        return sql.raw("1=0");
      }
      return dialect.jsonArrayContains(field, value);
    }
    case "containsAll": {
      return dialect.jsonArrayContainsAll(field, values);
    }
    case "containsAny": {
      return dialect.jsonArrayContainsAny(field, values);
    }
  }
}

/**
 * Compiles an object/JSON predicate.
 */
function compileObjectPredicate(
  expr: ObjectPredicate,
  dialect: DialectAdapter,
  cteColumnPrefix?: string,
): SQL {
  const basePointer = getFieldPointer(expr.field);
  const pointer = joinJsonPointers(basePointer, expr.pointer);
  const column = compileFieldColumn(expr.field, undefined, cteColumnPrefix);

  switch (expr.op) {
    case "hasKey":
    case "hasPath": {
      return dialect.jsonHasPath(column, pointer);
    }

    case "pathEquals": {
      if (!expr.value) {
        throw new UnsupportedPredicateError(
          "pathEquals requires a comparison value",
        );
      }
      const valueType = resolvePredicateValueType(expr.valueType, expr.value);
      if (valueType === "array" || valueType === "object") {
        throw new UnsupportedPredicateError(
          "pathEquals is not supported for JSON arrays or objects",
        );
      }
      const left = compileFieldValue(
        expr.field,
        dialect,
        valueType,
        undefined,
        pointer,
        cteColumnPrefix,
      );
      return sql`${left} = ${convertValueForSql(expr.value.value, dialect)}`;
    }

    case "pathContains": {
      if (!expr.value) {
        throw new UnsupportedPredicateError(
          "pathContains requires a comparison value",
        );
      }
      const arrayField = compileFieldJsonValue(
        expr.field,
        dialect,
        undefined,
        pointer,
        cteColumnPrefix,
      );
      return dialect.jsonArrayContains(
        arrayField,
        convertValueForSql(expr.value.value, dialect),
      );
    }

    case "pathIsNull": {
      return dialect.jsonPathIsNull(column, pointer);
    }

    case "pathIsNotNull": {
      return dialect.jsonPathIsNotNull(column, pointer);
    }
  }
}

/**
 * AggregateExpr structure from AST.
 */
type AggregateExprInput = Readonly<{
  __type: "aggregate";
  function: string;
  field: FieldRef;
}>;

/**
 * Compiles an aggregate comparison predicate.
 */
function compileAggregatePredicate(
  expr: {
    __type: "aggregate_comparison";
    op: string;
    aggregate: AggregateExprInput;
    value: LiteralValue;
  },
  dialect: DialectAdapter,
): SQL {
  const aggregate = compileAggregateExpr(expr.aggregate, dialect);

  const op = COMPARISON_OP_SQL[expr.op];
  if (!op) {
    throw new UnsupportedPredicateError(
      `Comparison operation "${expr.op}" is not supported for aggregate predicates`,
    );
  }

  const convertedValue = convertValueForSql(expr.value.value, dialect);
  return sql`${aggregate} ${sql.raw(op)} ${convertedValue}`;
}

/**
 * Compiles an aggregate expression.
 */
function compileAggregateExpr(
  expr: AggregateExprInput,
  dialect: DialectAdapter,
): SQL {
  const cteAlias = `cte_${expr.field.alias}`;
  const field = compileFieldValue(
    expr.field,
    dialect,
    expr.field.valueType,
    cteAlias,
  );

  switch (expr.function) {
    case "count": {
      return sql`COUNT(${field})`;
    }
    case "countDistinct": {
      return sql`COUNT(DISTINCT ${field})`;
    }
    case "sum": {
      return sql`SUM(${field})`;
    }
    case "avg": {
      return sql`AVG(${field})`;
    }
    case "min": {
      return sql`MIN(${field})`;
    }
    case "max": {
      return sql`MAX(${field})`;
    }
    default: {
      throw new UnsupportedPredicateError(
        `Unknown aggregate function: ${expr.function}`,
      );
    }
  }
}

/**
 * Compiles an EXISTS subquery predicate.
 */
function compileExistsSubquery(
  expr: ExistsSubquery,
  ctx: PredicateCompilerContext,
): SQL {
  if (expr.subquery.graphId === undefined) {
    throw new UnsupportedPredicateError("EXISTS subquery must have a graphId");
  }
  const subSql = ctx.compileQuery(expr.subquery, expr.subquery.graphId);
  return expr.negated ? sql`NOT EXISTS (${subSql})` : sql`EXISTS (${subSql})`;
}

/**
 * Compiles an IN subquery predicate.
 */
function compileInSubquery(
  expr: InSubquery,
  ctx: PredicateCompilerContext,
): SQL {
  const subqueryColumnCount = getSubqueryColumnCount(expr.subquery);
  if (subqueryColumnCount !== 1) {
    throw new UnsupportedPredicateError(
      `IN/NOT IN subquery must project exactly 1 column, but got ${subqueryColumnCount}`,
      { subqueryColumnCount },
    );
  }

  const fieldValueType = normalizeValueType(expr.field.valueType);
  const subqueryValueType = getSingleSubqueryColumnValueType(expr.subquery);
  const resolvedValueType = fieldValueType ?? subqueryValueType;

  if (isUnsupportedInSubqueryValueType(resolvedValueType)) {
    throw new UnsupportedPredicateError(
      `IN/NOT IN subquery does not support ${String(resolvedValueType)} values`,
      { valueType: resolvedValueType },
    );
  }

  if (!isInSubqueryTypeCompatible(fieldValueType, subqueryValueType)) {
    throw new UnsupportedPredicateError(
      `IN/NOT IN type mismatch: field type "${String(fieldValueType)}" does not match subquery column type "${String(subqueryValueType)}"`,
      {
        fieldValueType,
        subqueryValueType,
      },
    );
  }

  const valueType = fieldValueType ?? subqueryValueType;
  if (expr.subquery.graphId === undefined) {
    throw new UnsupportedPredicateError(
      "IN/NOT IN subquery must have a graphId",
    );
  }
  const fieldSql = compileFieldValue(
    expr.field,
    ctx.dialect,
    valueType,
    undefined,
    undefined,
    ctx.cteColumnPrefix,
  );
  const subSql = ctx.compileQuery(expr.subquery, expr.subquery.graphId);
  return expr.negated ?
      sql`${fieldSql} NOT IN (${subSql})`
    : sql`${fieldSql} IN (${subSql})`;
}

/**
 * Compiles a vector similarity predicate.
 *
 * Vector similarity predicates require special handling at the query compilation
 * level to handle:
 * - JOIN to embeddings table
 * - ORDER BY distance ASC
 * - LIMIT k
 *
 * This function handles the minScore filter if present. The main query compiler
 * must detect vector_similarity predicates and set up the appropriate JOINs
 * and ordering.
 */
function compileVectorSimilarityPredicate(
  _expr: VectorSimilarityPredicate,
  _ctx: PredicateCompilerContext,
): SQL {
  // No-op: vector similarity is handled structurally (JOINs, ORDER BY, LIMIT)
  // by the main query compiler, not as a WHERE predicate. Returns 1=1 so it
  // composes safely with AND.
  return sql.raw("1=1");
}

// ============================================================
// Vector Similarity Helpers
// ============================================================

/**
 * Extracts all vector similarity predicates from a query's predicates.
 * Used by the main query compiler to set up JOINs, ORDER BY, and LIMIT.
 *
 * Vector predicates must appear at top level or under AND groups only.
 * Nesting under OR/NOT is rejected because vector search rewrites query
 * structure rather than behaving like a pure boolean predicate.
 */
export function extractVectorSimilarityPredicates(
  predicates: readonly { expression: PredicateExpression }[],
): VectorSimilarityPredicate[] {
  const results: VectorSimilarityPredicate[] = [];

  function visit(expr: PredicateExpression, inDisallowedBranch: boolean): void {
    switch (expr.__type) {
      case "vector_similarity": {
        if (inDisallowedBranch) {
          throw new UnsupportedPredicateError(
            "Vector similarity predicates cannot be nested under OR or NOT. " +
              "Use top-level AND combinations instead.",
          );
        }
        results.push(expr);
        break;
      }
      case "and": {
        for (const p of expr.predicates) {
          visit(p, inDisallowedBranch);
        }
        break;
      }
      case "or": {
        for (const p of expr.predicates) {
          visit(p, true);
        }
        break;
      }
      case "not": {
        visit(expr.predicate, true);
        break;
      }
      case "comparison":
      case "string_op":
      case "null_check":
      case "between":
      case "array_op":
      case "object_op":
      case "aggregate_comparison":
      case "exists":
      case "in_subquery": {
        // These predicate types don't contain nested vector_similarity
        break;
      }
    }
  }

  for (const pred of predicates) {
    visit(pred.expression, false);
  }

  return results;
}

// ============================================================
// Exports for aggregate compilation
// ============================================================

export { compileAggregateExpr };
