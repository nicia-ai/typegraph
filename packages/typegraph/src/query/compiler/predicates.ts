/**
 * Predicate Expression Compilation
 *
 * Compiles predicate AST nodes to SQL using dialect adapters.
 * Handles comparisons, string operations, null checks, array/object predicates,
 * and subqueries.
 */
import {
  assertRecursiveTraversal,
  type RecursiveTraversalVerdict,
} from "../../backend/capabilities/recursive-traversal";
import {
  CompilerInvariantError,
  UnsupportedPredicateError,
} from "../../errors";
import { requireDefined } from "../../utils/presence";
import {
  type AggregateExpr,
  type ArrayPredicate,
  type ExistsSubquery,
  type FieldRef,
  type FulltextMatchPredicate,
  type InSubquery,
  type LiteralValue,
  type ObjectPredicate,
  type ParameterRef,
  type PredicateExpression,
  type QueryAst,
  type RelevanceComparisonPredicate,
  type ValueType,
  type VectorSimilarityPredicate,
} from "../ast";
import {
  inSubqueryComparisonValueType,
  inSubqueryProjectsDateValue,
} from "../compared-operands";
import {
  LIKE_ESCAPE_CHARACTER,
  nullIfTrailingLikeEscape,
} from "../dialect/like-escape";
import { type DialectAdapter } from "../dialect/types";
import { type VectorStrategy } from "../dialect/vector-strategy";
import type { DatabaseExpression } from "../expressions";
import {
  joinJsonPointers,
  type JsonPointer,
  jsonPointer,
} from "../json-pointer";
import { isParameterRef } from "../predicates";
import { sql, type SqlFragment } from "../sql-fragment";
import {
  getSingleSubqueryColumnValueType,
  getSubqueryColumnCount,
  isInSubqueryTypeCompatible,
  isUnsupportedInSubqueryValueType,
} from "../subquery-utils";
import { validateAggregateOperand } from "./aggregate-validation";
import { aliasColumnName } from "./alias-names";
import { readColumn, readUnresolvedColumn } from "./column-reads";
import {
  compileDatabaseExpression,
  compileLegacyAggregateExpression,
  type DatabaseExpressionCompilerContext,
} from "./database-expressions";
import {
  type RecordedReadBinding,
  type SqlSchema,
  type VectorSlotMap,
} from "./schema";
import { type ReadInstantMode } from "./temporal";

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
): SqlFragment {
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

  // Default behavior: use aliased column names (e.g., "p_props"), written
  // through the column-read owner so the statement records each read.
  const column =
    field.path.length > 0 && field.path[0] === "props" ?
      "props"
    : field.path.join("_");
  const name = aliasColumnName(field.alias, column);
  return cteAlias === undefined || cteAlias === "" ?
      readUnresolvedColumn(name)
    : readColumn(cteAlias, name);
}

/**
 * Gets the JSON pointer for a field reference.
 */
export function getFieldPointer(field: FieldRef): JsonPointer | undefined {
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
 * The value type a `param()` in a comparison binds as: the parameter's own
 * declared type when it has one, else the field's.
 *
 * Shared so the two things that must agree about it cannot drift — the
 * compiler picks the `jsonExtract*` variant (and, for a list parameter, the
 * matching element cast) from this, and `PreparedQuery` validates the caller's
 * bindings against the same answer.
 */
export function resolveParameterValueType(
  left: FieldRef,
  right: ParameterRef,
): ValueType | undefined {
  return (
    normalizeValueType(right.valueType) ?? normalizeValueType(left.valueType)
  );
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
): SqlFragment {
  const column = compileFieldColumn(field, cteAlias, cteColumnPrefix);
  return compileFieldValueFromColumn(
    field,
    dialect,
    valueType,
    column,
    pointerOverride,
  );
}

/** Applies a field's JSON/value decoding to an already-resolved column token. */
export function compileFieldValueFromColumn(
  field: FieldRef,
  dialect: DialectAdapter,
  valueType: ValueType | undefined,
  column: SqlFragment,
  pointerOverride?: JsonPointer,
): SqlFragment {
  const resolved = normalizeValueType(valueType);

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
): SqlFragment {
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
): SqlFragment {
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
  right: FieldRef | LiteralValue | readonly LiteralValue[] | ParameterRef,
): ValueType | undefined {
  if (isParameterRef(right)) {
    return (
      normalizeValueType(right.valueType) ?? normalizeValueType(field.valueType)
    );
  }
  if (isFieldReference(right)) {
    const fieldType = normalizeValueType(field.valueType);
    const rightType = normalizeValueType(right.valueType);
    if (fieldType && rightType && fieldType !== rightType) {
      throw new UnsupportedPredicateError(
        `Cannot compare ${fieldType} and ${rightType} fields`,
        { leftValueType: fieldType, rightValueType: rightType },
      );
    }
    return fieldType ?? rightType;
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

function isFieldReference(value: unknown): value is FieldRef {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Readonly<{ __type?: unknown }>).__type === "field_ref"
  );
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
  // Escape the escape character first so the wildcards we prefix below aren't
  // double-escaped, then neutralize the LIKE wildcards. Mirrors
  // escapeLikePatternParameter for the parameterized path. The emitted
  // LIKE/ILIKE declares this same character as its ESCAPE (see likeEscapeClause).
  const escaped = pattern
    .replaceAll(
      LIKE_ESCAPE_CHARACTER,
      `${LIKE_ESCAPE_CHARACTER}${LIKE_ESCAPE_CHARACTER}`,
    )
    .replaceAll("%", `${LIKE_ESCAPE_CHARACTER}%`)
    .replaceAll("_", `${LIKE_ESCAPE_CHARACTER}_`);

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
 * Escapes wildcard characters in a SQL pattern parameter. Mirrors
 * `compileStringPattern`'s escaping for the literal-pattern path, both driven
 * by the same {@link LIKE_ESCAPE_CHARACTER} so they can't drift apart.
 */
function escapeLikePatternParameter(parameter: SqlFragment): SqlFragment {
  const doubledEscape = `${LIKE_ESCAPE_CHARACTER}${LIKE_ESCAPE_CHARACTER}`;
  return sql`REPLACE(REPLACE(REPLACE(${parameter}, ${LIKE_ESCAPE_CHARACTER}, ${doubledEscape}), '%', ${`${LIKE_ESCAPE_CHARACTER}%`}), '_', ${`${LIKE_ESCAPE_CHARACTER}_`})`;
}

/**
 * Builds a SQL pattern expression for parameterized string operations.
 */
function compileParameterizedStringPattern(
  op: string,
  parameter: SqlFragment,
): SqlFragment {
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
      return nullIfTrailingLikeEscape(parameter);
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
  /**
   * Compiles a keyset cursor's `relevance_comparison`. Supplied only where
   * the comparison means something: the completed-match filter of a
   * full-text, vector or hybrid statement (`buildStandardResultWhere`). A
   * `relevance_comparison` compiled anywhere else is refused.
   */
  compileRelevanceComparison?: (
    predicate: RelevanceComparisonPredicate,
  ) => SqlFragment;
  schema: SqlSchema;
  compileQuery: (ast: QueryAst, graphId: string) => SqlFragment;
  compileExpressionSubquery?: (ast: QueryAst) => SqlFragment;
  compileExpressionOuterReference?: (
    expression: DatabaseExpression,
    outerScopeIdentity: symbol,
  ) => SqlFragment;
  cteColumnPrefix?: string;
  /**
   * Active vector strategy for `field.similarTo(...)` compilation. When
   * present, the embeddings CTE scans the strategy's per-`(kind, field)`
   * tables and uses its `distanceExpression`; absent on backends without
   * vector support (the vector pass rejects the predicate before the CTE
   * builder runs).
   */
  vectorStrategy?: VectorStrategy;
  /**
   * Whether the active backend supports SQL window functions such as
   * `ROW_NUMBER()`.
   */
  windowFunctions: boolean;
  orderedAggregates?: boolean;
  /**
   * Declared embedding slots `(kind, fieldPath) -> {dimensions, metric,
   * indexType}`. The embeddings CTE consults it to know which kinds in
   * an alias actually declare the field — only those get a per-field
   * table scan in the UNION ALL.
   */
  vectorSlots?: VectorSlotMap;
  /** Per-kind declared fulltext language for constant-tsquery parsing. */
  fulltextLanguages?: ReadonlyMap<string, string>;
  /**
   * Mutable collector: the emitter records each ANN slot index type it
   * compiles an engine-form branch for, and the compiler entry brands
   * the finished statement with them (see markAnnIndexScan).
   */
  annIndexTypes?: Set<string>;
  /**
   * How the temporal pass emits the "current" read instant. Threaded from
   * {@link CompileQueryOptions.readInstant} so the standard and recursive
   * pipelines can compile a reusable placeholder statement for the query
   * builder's template cache. Absent means `"literal"`.
   */
  readInstant?: ReadInstantMode;
  /**
   * Recorded read binding whose `source`/`predicate` seam the temporal
   * filter pass consults when the query carries a recorded pin. Threaded
   * from `CompileQueryOptions.recordedReadBinding`.
   */
  recordedReadBinding?: RecordedReadBinding;
  /** Equal-id behavior for historical identity traversal reconstruction. */
  identitySameIdAcrossKinds?: "fold" | "ignore";
  /** Registered node kinds allowed to conduct historical identity. */
  identityRegisteredKinds?: readonly string[];
  compileFieldExpression?: DatabaseExpressionCompilerContext["compileFieldExpression"];
  /**
   * The name the caller wrote for an alias of the statement being compiled.
   * A correlated subquery compiles with its aliases renamed; a refusal raised
   * while compiling it names the caller's alias through this. Absent means
   * the aliases were not renamed.
   */
  callerAlias?: (alias: string) => string;
  /**
   * Whether the active backend can compute a bounded transitive closure in
   * one round trip. Optional per Contract E: a required member here would
   * churn every predicate-context literal across the compiler's tests for
   * no added protection, since the only site that reads it today
   * (`compileVariableLengthQuery`) already asserts its presence.
   */
  recursiveTraversal?: RecursiveTraversalVerdict;
  databaseExpressionAggregates?: boolean;
  /**
   * Resolves completed-match fields to the CTE carrying their columns. Read
   * by database expressions and by the comparison, tuple-comparison and
   * null-check predicates a keyset cursor is built from; the other predicate
   * forms are never placed in a completed-match filter.
   */
  resolveFieldCteAlias?: FieldCteAliasResolver;
  /** Final recursive CTE qualifier used by completed-result expressions. */
  recursiveResultAlias?: string;
}>;

/**
 * Returns the compiler context's {@link RecursiveTraversalVerdict}, or
 * refuses because the plumbing was bypassed: every path that reaches this
 * function threads the verdict through `CompileQueryOptions` /
 * `propagateOptions`, so a missing verdict means a caller skipped that
 * threading, which is a compiler invariant violation, not a capability
 * refusal.
 *
 * @throws {CompilerInvariantError} when `ctx.recursiveTraversal` is undefined.
 */
export function requireRecursiveTraversalVerdict(
  ctx: PredicateCompilerContext,
  operation: string,
): RecursiveTraversalVerdict {
  const verdict = ctx.recursiveTraversal;
  if (verdict === undefined) {
    throw new CompilerInvariantError(
      "recursive traversal verdict missing from compiler context",
      { operation },
    );
  }
  return verdict;
}

/**
 * Refuses a variable-length traversal when the compiler context carries no
 * {@link RecursiveTraversalVerdict}, or when the verdict says the backend
 * cannot recurse.
 *
 * A missing verdict is never silently treated as supported: every path that
 * reaches this function threads the verdict through `CompileQueryOptions` /
 * `propagateOptions`, so its absence means a caller bypassed that plumbing,
 * which is a compiler invariant violation, not a capability refusal.
 *
 * @throws {CompilerInvariantError} when `ctx.recursiveTraversal` is undefined.
 * @throws {ConfigurationError} when the verdict declares no support.
 */
export function assertRecursiveTraversalSupported(
  ctx: PredicateCompilerContext,
  operation: string,
): void {
  assertRecursiveTraversal(
    requireRecursiveTraversalVerdict(ctx, operation),
    operation,
  );
}

type FieldCteAliasResolver = (field: FieldRef) => string | undefined;

/**
 * Compiles a predicate expression to SQL.
 */
export function compilePredicateExpression(
  expr: PredicateExpression,
  ctx: PredicateCompilerContext,
): SqlFragment {
  const { dialect } = ctx;

  const cteColumnPrefix = ctx.cteColumnPrefix;

  switch (expr.__type) {
    case "comparison": {
      return compileComparisonPredicate(
        expr,
        dialect,
        cteColumnPrefix,
        ctx.resolveFieldCteAlias,
      );
    }

    case "tuple_comparison": {
      return compileTupleComparisonPredicate(
        expr,
        dialect,
        cteColumnPrefix,
        ctx.resolveFieldCteAlias,
      );
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
        return dialect.like(field, pattern);
      }

      const pattern = sql`${compileStringPattern(expr.op, expr.pattern)}`;
      // contains, startsWith, endsWith and ilike are case-insensitive; like is
      // case-sensitive. Both go through the dialect, because SQLite's own LIKE
      // ignores ASCII case and PostgreSQL's does not.
      if (
        expr.op === "ilike" ||
        expr.op === "contains" ||
        expr.op === "startsWith" ||
        expr.op === "endsWith"
      ) {
        return dialect.ilike(field, pattern);
      }
      return dialect.like(field, pattern);
    }

    case "null_check": {
      const field = compileFieldTextValue(
        expr.field,
        dialect,
        ctx.resolveFieldCteAlias?.(expr.field),
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

    case "database_expression_predicate": {
      return compileDatabaseExpression(expr.expression, {
        allowAggregates: ctx.databaseExpressionAggregates ?? false,
        aggregateClause: "predicate",
        ...(ctx.cteColumnPrefix === undefined ?
          {}
        : { cteColumnPrefix: ctx.cteColumnPrefix }),
        dialect,
        ...(ctx.compileExpressionSubquery === undefined ?
          {}
        : { compileSubquery: ctx.compileExpressionSubquery }),
        ...(ctx.compileExpressionOuterReference === undefined ?
          {}
        : { compileOuterReference: ctx.compileExpressionOuterReference }),
        ...(ctx.compileFieldExpression === undefined ?
          {}
        : { compileFieldExpression: ctx.compileFieldExpression }),
        resolveFieldCteAlias(field) {
          if (ctx.resolveFieldCteAlias !== undefined)
            return ctx.resolveFieldCteAlias(field);
          return ctx.cteColumnPrefix === undefined ?
              `cte_${field.alias}`
            : undefined;
        },
      });
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

    case "vector_similarity":
    case "fulltext_match": {
      // Structural predicates — handled by the main compiler via JOINs,
      // ORDER BY, and LIMIT. Compile to 1=1 so they compose safely with
      // surrounding AND branches.
      return STRUCTURAL_PREDICATE_NOOP;
    }

    case "relevance_comparison": {
      if (ctx.compileRelevanceComparison === undefined)
        throw new CompilerInvariantError(
          "A relevance cursor comparison reached a predicate outside the completed-match filter of a relevance-ordered statement",
          { phase: "relevance-cursor-key" },
        );
      return ctx.compileRelevanceComparison(expr);
    }
  }
}

const STRUCTURAL_PREDICATE_NOOP = sql.raw("1=1");

/**
 * Compiles a comparison predicate.
 */
function compileComparisonPredicate(
  expr: {
    __type: "comparison";
    op: string;
    left: FieldRef;
    right: FieldRef | LiteralValue | readonly LiteralValue[] | ParameterRef;
  },
  dialect: DialectAdapter,
  cteColumnPrefix?: string,
  resolveFieldCteAlias?: FieldCteAliasResolver,
): SqlFragment {
  // Handle ParameterRef on the right side
  if (isParameterRef(expr.right)) {
    const parameterValueType = resolveParameterValueType(expr.left, expr.right);
    const left = compileFieldValue(
      expr.left,
      dialect,
      parameterValueType,
      resolveFieldCteAlias?.(expr.left),
      undefined,
      cteColumnPrefix,
    );
    if (expr.op === "in" || expr.op === "notIn") {
      return compileListParameterPredicate(
        left,
        expr.right.name,
        parameterValueType,
        expr.op === "notIn",
        dialect,
      );
    }
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
    resolveFieldCteAlias?.(expr.left),
    undefined,
    cteColumnPrefix,
  );

  if (expr.op === "in" || expr.op === "notIn") {
    if (isFieldReference(expr.right)) {
      throw new UnsupportedPredicateError(
        `${expr.op}() does not support a field-reference operand`,
      );
    }
    const values: readonly LiteralValue[] =
      Array.isArray(expr.right) ? expr.right : [expr.right as LiteralValue];
    if (values.length === 0) {
      return expr.op === "in" ? sql.raw("1=0") : sql.raw("1=1");
    }
    const convertedValues = values.map((value) =>
      convertValueForSql(value.value, dialect),
    );
    return dialect.inList(left, convertedValues, expr.op === "notIn");
  }

  // For single-value comparisons, extract the literal value
  const right = expr.right;
  if (isFieldReference(right)) {
    const rightValue = compileFieldValue(
      right,
      dialect,
      valueType,
      resolveFieldCteAlias?.(right),
      undefined,
      cteColumnPrefix,
    );
    const opSql = COMPARISON_OP_SQL[expr.op];
    if (!opSql) {
      throw new UnsupportedPredicateError(
        `Comparison operation "${expr.op}" is not supported`,
      );
    }
    return sql`${left} ${sql.raw(opSql)} ${rightValue}`;
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Type narrowing with Array.isArray
  const rightValue: LiteralValue =
    Array.isArray(right) ? requireDefined(right[0]) : right;

  const convertedRight = convertValueForSql(rightValue.value, dialect);
  const opSql = COMPARISON_OP_SQL[expr.op];
  if (!opSql) {
    throw new UnsupportedPredicateError(
      `Comparison operation "${expr.op}" is not supported`,
    );
  }
  return sql`${left} ${sql.raw(opSql)} ${convertedRight}`;
}

function compileTupleComparisonPredicate(
  expr: Extract<PredicateExpression, { __type: "tuple_comparison" }>,
  dialect: DialectAdapter,
  cteColumnPrefix?: string,
  resolveFieldCteAlias?: FieldCteAliasResolver,
): SqlFragment {
  if (expr.fields.length !== expr.values.length)
    throw new UnsupportedPredicateError(
      "Tuple comparisons require equally sized field and value tuples",
    );
  const fields = expr.fields.map((field, index) =>
    compileFieldValue(
      field,
      dialect,
      resolveComparisonValueType(field, requireDefined(expr.values[index])),
      resolveFieldCteAlias?.(field),
      undefined,
      cteColumnPrefix,
    ),
  );
  const values = expr.values.map(
    (value) => sql`${convertValueForSql(value.value, dialect)}`,
  );
  if (dialect.rowValueComparison === undefined)
    return compileTupleComparisonFallback(expr.op, fields, values);
  return dialect.rowValueComparison(
    expr.op === "gt" ? ">" : "<",
    fields,
    values,
  );
}

/** Preserves lexicographic cursor semantics for adapters without row values. */
function compileTupleComparisonFallback(
  operator: "gt" | "lt",
  fields: readonly SqlFragment[],
  values: readonly SqlFragment[],
): SqlFragment {
  const comparison = sql.raw(operator === "gt" ? ">" : "<");
  const terms = fields.map((field, index) => {
    const prefix = fields
      .slice(0, index)
      .map(
        (prefixField, prefixIndex) =>
          sql`${prefixField} = ${requireDefined(values[prefixIndex])}`,
      );
    const currentValue = requireDefined(values[index]);
    const current = sql`${field} ${comparison} ${currentValue}`;
    return prefix.length === 0 ?
        current
      : sql`(${sql.join([...prefix, current], sql` AND `)})`;
  });
  return sql`(${sql.join(terms, sql` OR `)})`;
}

/**
 * Compiles `field.in(param("ids"))` / `field.notIn(param("ids"))`.
 *
 * The whole list rides on ONE placeholder — the dialect unpacks it — so the
 * emitted SQL text is independent of how many elements the caller eventually
 * binds. That is what lets a prepared query compile once and serve every
 * arity from the same cached template, including the empty list (which yields
 * an empty relation, hence `IN` false / `NOT IN` true, matching the literal
 * form's short circuit).
 */
function compileListParameterPredicate(
  left: SqlFragment,
  parameterName: string,
  elementType: ValueType | undefined,
  negated: boolean,
  dialect: DialectAdapter,
): SqlFragment {
  if (
    elementType === "array" ||
    elementType === "object" ||
    elementType === "embedding"
  ) {
    throw new UnsupportedPredicateError(
      `IN/NOT IN is not supported for ${elementType} values`,
      { valueType: elementType },
      {
        suggestion:
          "Use scalar fields (string/number/boolean/date) in IN/NOT IN predicates.",
      },
    );
  }
  return dialect.inListParameter(left, sql.placeholder(parameterName), {
    negated,
    elementType,
  });
}

/**
 * Compiles an array predicate.
 */
function compileArrayPredicate(
  expr: ArrayPredicate,
  dialect: DialectAdapter,
  cteColumnPrefix?: string,
): SqlFragment {
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
): SqlFragment {
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
  function: AggregateExpr["function"];
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
): SqlFragment {
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
): SqlFragment {
  validateAggregateOperand(expr);
  return compileLegacyAggregateExpression(expr, {
    dialect,
    resolveFieldCteAlias() {
      return `cte_${expr.field.alias}`;
    },
  });
}

/**
 * Compiles an EXISTS subquery predicate.
 */
function compileExistsSubquery(
  expr: ExistsSubquery,
  ctx: PredicateCompilerContext,
): SqlFragment {
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
): SqlFragment {
  const subqueryColumnCount = getSubqueryColumnCount(expr.subquery);
  if (subqueryColumnCount !== 1) {
    throw new UnsupportedPredicateError(
      `IN/NOT IN subquery must project exactly 1 column, but got ${subqueryColumnCount}`,
      { subqueryColumnCount },
    );
  }

  const fieldValueType = normalizeValueType(expr.field.valueType);
  const subqueryValueType = getSingleSubqueryColumnValueType(expr.subquery);
  const valueType = inSubqueryComparisonValueType(expr.field, expr.subquery);

  if (isUnsupportedInSubqueryValueType(valueType)) {
    throw new UnsupportedPredicateError(
      `IN/NOT IN subquery does not support ${String(valueType)} values`,
      { valueType },
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
  const compiledSubquery = ctx.compileQuery(
    expr.subquery,
    expr.subquery.graphId,
  );
  const subSql =
    inSubqueryProjectsDateValue(expr.field, expr.subquery) ?
      dateTypedSubqueryValues(expr.subquery, compiledSubquery, ctx.dialect)
    : compiledSubquery;
  return expr.negated ?
      sql`${fieldSql} NOT IN (${subSql})`
    : sql`${fieldSql} IN (${subSql})`;
}

/** The derived-table alias {@link dateTypedSubqueryValues} reads through. */
const DATE_TYPED_SUBQUERY_ALIAS = "tg_date_values";

/**
 * The values an `in` / `notIn` subquery projects, typed as dates
 * (`DialectAdapter.dateValue`): a literal or parameter the subquery projects
 * is typed `text` on PostgreSQL, where comparing a `timestamptz` field with it
 * fails. Read through a derived table, so the subquery itself compiles as it
 * would anywhere else and only the compared value is typed.
 */
function dateTypedSubqueryValues(
  subquery: InSubquery["subquery"],
  compiled: SqlFragment,
  dialect: DialectAdapter,
): SqlFragment {
  const [projected] = subquery.projection.fields;
  if (projected === undefined)
    throw new CompilerInvariantError(
      "A date-typed IN/NOT IN subquery has no projected column",
    );
  const column = sql`${sql.identifier(DATE_TYPED_SUBQUERY_ALIAS)}.${sql.identifier(projected.outputName)}`;
  return sql`SELECT ${dialect.dateValue(column)} FROM (${compiled}) AS ${sql.identifier(DATE_TYPED_SUBQUERY_ALIAS)}`;
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

// ============================================================
// Structural Predicate Extraction
// ============================================================

/**
 * Extracts all instances of a "structural" predicate (one that rewrites
 * the query into JOIN + ORDER BY + LIMIT, rather than acting as a
 * boolean WHERE clause). Both `vector_similarity` and `fulltext_match`
 * have the same placement rules: top-level or under AND only — nesting
 * under OR/NOT is rejected because the rewrite is incompatible with
 * disjunction and negation.
 */
function extractStructuralPredicates<T extends PredicateExpression>(
  predicates: readonly { expression: PredicateExpression }[],
  isMatch: (expr: PredicateExpression) => expr is T,
  rejectionMessage: string,
): T[] {
  const results: T[] = [];

  function visit(expr: PredicateExpression, inDisallowedBranch: boolean): void {
    if (isMatch(expr)) {
      if (inDisallowedBranch) {
        throw new UnsupportedPredicateError(rejectionMessage);
      }
      results.push(expr);
      return;
    }
    switch (expr.__type) {
      case "and": {
        for (const child of expr.predicates) visit(child, inDisallowedBranch);
        return;
      }
      case "or": {
        for (const child of expr.predicates) visit(child, true);
        return;
      }
      case "not": {
        visit(expr.predicate, true);
        return;
      }
      case "comparison":
      case "tuple_comparison":
      case "string_op":
      case "null_check":
      case "between":
      case "array_op":
      case "object_op":
      case "aggregate_comparison":
      case "exists":
      case "in_subquery":
      case "vector_similarity":
      case "fulltext_match":
      case "relevance_comparison": {
        return;
      }
      case "database_expression_predicate": {
        return;
      }
    }
  }

  for (const pred of predicates) visit(pred.expression, false);
  return results;
}

export function extractVectorSimilarityPredicates(
  predicates: readonly { expression: PredicateExpression }[],
): VectorSimilarityPredicate[] {
  return extractStructuralPredicates(
    predicates,
    (expr): expr is VectorSimilarityPredicate =>
      expr.__type === "vector_similarity",
    "Vector similarity predicates cannot be nested under OR or NOT. " +
      "Use top-level AND combinations instead.",
  );
}

export function extractFulltextMatchPredicates(
  predicates: readonly { expression: PredicateExpression }[],
): FulltextMatchPredicate[] {
  return extractStructuralPredicates(
    predicates,
    (expr): expr is FulltextMatchPredicate => expr.__type === "fulltext_match",
    "Fulltext match predicates cannot be nested under OR or NOT. " +
      "Use top-level AND combinations instead.",
  );
}

// ============================================================
// Exports for aggregate compilation
// ============================================================

export { compileAggregateExpr };
