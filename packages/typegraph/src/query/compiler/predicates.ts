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
  type PredicateExpression,
  type ValueType,
  type VectorSimilarityPredicate,
} from "../ast";
import { type DialectAdapter } from "../dialect";
import {
  joinJsonPointers,
  type JsonPointer,
  jsonPointer,
} from "../json-pointer";
import { type SqlSchema } from "./schema";

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
  right: LiteralValue | readonly LiteralValue[],
): ValueType | undefined {
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
  compileQuery: (ast: unknown, graphId: string) => SQL;
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
      const valueType = resolveComparisonValueType(expr.field, [
        expr.lower,
        expr.upper,
      ]);
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
      const lower = convertValueForSql(expr.lower.value, dialect);
      const upper = convertValueForSql(expr.upper.value, dialect);
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
    right: LiteralValue | readonly LiteralValue[];
  },
  dialect: DialectAdapter,
  cteColumnPrefix?: string,
): SQL {
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
      Array.isArray(expr.right) ? expr.right : [expr.right];
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

  const opMap: Record<string, string> = {
    eq: "=",
    neq: "!=",
    gt: ">",
    gte: ">=",
    lt: "<",
    lte: "<=",
  };

  const convertedRight = convertValueForSql(rightValue.value, dialect);
  return sql`${left} ${sql.raw(opMap[expr.op]!)} ${convertedRight}`;
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

  const opMap: Record<string, string> = {
    eq: "=",
    neq: "!=",
    gt: ">",
    gte: ">=",
    lt: "<",
    lte: "<=",
  };

  const op = opMap[expr.op];
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
  const graphId = expr.subquery.graphId ?? "";
  const subSql = ctx.compileQuery(expr.subquery, graphId);
  return expr.negated ? sql`NOT EXISTS (${subSql})` : sql`EXISTS (${subSql})`;
}

/**
 * Compiles an IN subquery predicate.
 */
function compileInSubquery(
  expr: InSubquery,
  ctx: PredicateCompilerContext,
): SQL {
  const graphId = expr.subquery.graphId ?? "";
  const fieldSql = compileFieldTextValue(
    expr.field,
    ctx.dialect,
    undefined,
    undefined,
    ctx.cteColumnPrefix,
  );
  const subSql = ctx.compileQuery(expr.subquery, graphId);
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
  // Vector similarity predicates affect query structure (JOINs, ORDER BY, LIMIT).
  // The main query compiler detects these predicates and handles:
  // - Creating a cte_embeddings CTE with the embeddings table
  // - Computing distance using dialect.vectorDistance()
  // - Applying minScore filter inside cte_embeddings (if specified)
  // - Ordering by distance ascending
  // - Limiting to expr.limit results
  //
  // The minScore filtering is handled in compileVectorSimilarityCte(), not here.
  // This predicate compilation is called for the nodes CTE, which doesn't have
  // an embedding column. Return a no-op condition (1=1).
  //
  // NOTE: The minScore filter is intentionally NOT applied here because:
  // 1. The nodes table doesn't have an embedding column
  // 2. The filtering is already done in the cte_embeddings CTE
  // 3. Applying it here would generate invalid SQL (referencing non-existent column)

  // Return a SQL "true" condition (1=1).
  //
  // This is intentional: vector similarity predicates affect query structure
  // (JOINs to embeddings table, ORDER BY distance, LIMIT k) which are handled
  // by the main query compiler in compileStandardQuery(). The predicate
  // compilation here only handles the optional WHERE clause filtering.
  //
  // When minScore is not specified, we still need to return valid SQL that
  // integrates with other predicates via AND. The "1=1" idiom is a standard
  // SQL no-op that:
  // - Always evaluates to true
  // - Has zero performance impact (optimized away by query planners)
  // - Composes correctly: "WHERE other_condition AND 1=1" = "WHERE other_condition"
  //
  // The actual similarity search behavior (k nearest neighbors) is enforced
  // by the JOIN and ORDER BY clauses added in compileEmbeddingsCte() and
  // compileVectorOrderBy().
  return sql.raw("1=1");
}

// ============================================================
// Vector Similarity Helpers
// ============================================================

/**
 * Extracts all vector similarity predicates from a query's predicates.
 * Used by the main query compiler to set up JOINs, ORDER BY, and LIMIT.
 */
export function extractVectorSimilarityPredicates(
  predicates: readonly { expression: PredicateExpression }[],
): VectorSimilarityPredicate[] {
  const results: VectorSimilarityPredicate[] = [];

  function visit(expr: PredicateExpression): void {
    switch (expr.__type) {
      case "vector_similarity": {
        results.push(expr);
        break;
      }
      case "and":
      case "or": {
        for (const p of expr.predicates) {
          visit(p);
        }
        break;
      }
      case "not": {
        visit(expr.predicate);
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
    visit(pred.expression);
  }

  return results;
}

// ============================================================
// Exports for aggregate compilation
// ============================================================

export { compileAggregateExpr };
