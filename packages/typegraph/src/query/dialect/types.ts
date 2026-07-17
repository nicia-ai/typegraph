/**
 * SQL Dialect Abstraction Layer
 *
 * Provides a unified interface for dialect-specific SQL generation.
 * Implementing a new dialect (MySQL, SQL Server, etc.) requires
 * implementing this interface.
 */
import { type SQL, type SQLWrapper } from "drizzle-orm";

import { type VectorMetric } from "../../backend/types";
import { type JsonPointer } from "../json-pointer";
import { type FulltextStrategy } from "./fulltext-strategy";

/**
 * Supported SQL dialects.
 */
export type SqlDialect = "sqlite" | "postgres";

/**
 * Strategy for compiling standard (non-recursive, non-set-op) queries.
 */
export type DialectStandardQueryStrategy = "cte_project";

/**
 * Strategy for compiling recursive queries.
 */
export type DialectRecursiveQueryStrategy = "recursive_cte";

/**
 * Strategy for handling vector predicates.
 */
export type DialectVectorPredicateStrategy = "native" | "unsupported";

/**
 * Capability and strategy profile for a SQL dialect.
 */
export type DialectCapabilities = Readonly<{
  /**
   * Standard query compilation strategy.
   */
  standardQueryStrategy: DialectStandardQueryStrategy;

  /**
   * Recursive query compilation strategy.
   */
  recursiveQueryStrategy: DialectRecursiveQueryStrategy;

  /**
   * Whether intermediate traversal CTEs should be materialized.
   */
  materializeIntermediateTraversalCtes: boolean;

  /**
   * When true, emit an explicit `NOT MATERIALIZED` hint on non-materialized
   * CTEs so the planner can inline them and see their row statistics. PostgreSQL
   * otherwise defaults to materializing any CTE referenced more than once,
   * which makes its planner opaque to the inner statistics. SQLite ignores
   * CTE materialization hints entirely.
   */
  emitNotMaterializedHint: boolean;

  /**
   * Whether recursive CTEs should enforce worktable-first join ordering.
   */
  forceRecursiveWorktableOuterJoinOrder: boolean;

  /**
   * Strategy for vector predicate support.
   */
  vectorPredicateStrategy: DialectVectorPredicateStrategy;

  /**
   * Metrics supported by vector predicates for this dialect — a FALLBACK only.
   * The active `VectorStrategy.capabilities.metrics` is the real authority and
   * is what the vector pass validates against on the normal compile path; this
   * dialect list is consulted ONLY by the strategy-less plan-lowering path
   * (recursive / set-operation queries, which don't plumb a strategy). It must
   * therefore stay a superset of every strategy that runs on this dialect, or a
   * metric a strategy supports could be wrongly rejected when a query happens to
   * lower through that path. (The bundled dialects mirror their strategies.)
   */
  vectorMetrics: readonly VectorMetric[];

  /**
   * Whether the dialect supports fulltext MATCH predicates.
   */
  supportsFulltext: boolean;
}>;

/**
 * Adapter interface for SQL dialect differences.
 *
 * Each method generates dialect-specific SQL for a common operation.
 * All methods return Drizzle SQL objects that can be composed together.
 */
export interface DialectAdapter {
  /**
   * The dialect name this adapter handles.
   */
  readonly name: SqlDialect;

  /**
   * Dialect capabilities and strategy selection used by query compilers.
   */
  readonly capabilities: DialectCapabilities;

  /**
   * Applies the dialect's binary/code-point text collation to an expression.
   * SQLite's default BINARY collation already has this order; PostgreSQL must
   * force `COLLATE "C"` so database locale cannot change deterministic graph
   * labels or query tie-breaks.
   */
  binaryText(expression: SQL): SQL;

  /**
   * Builds the dialect's planner-statistics refresh for a temporary table.
   * Returns undefined when the engine plans temporary tables well enough
   * without an explicit refresh.
   */
  analyzeTemporaryTable(table: SQLWrapper): SQL | undefined;

  /**
   * Builds the dialect's transaction-scoped working-memory override for
   * sort/hash-heavy iterative rounds. PostgreSQL emits the parameterized
   * `SET LOCAL work_mem` form (`set_config(..., is_local => true)`), which
   * reverts automatically when the transaction ends and never touches the
   * session or server setting. Returns undefined when the engine has no
   * per-operation memory budget to raise (SQLite). Callers must run the
   * statement inside a transaction and validate the value's shape first.
   */
  setTransactionWorkingMemory(workingMemory: string): SQL | undefined;

  // ============================================================
  // JSON Path Operations
  // ============================================================

  /**
   * Converts a JSON pointer to dialect-specific path syntax.
   *
   * @example
   * SQLite: "$.name" or "$[0].value"
   * PostgreSQL: ARRAY['name'] or ARRAY['0', 'value']
   */
  compilePath(pointer: JsonPointer): SQL;

  /**
   * Extracts a JSON value at a path (returns JSON type).
   *
   * @example
   * SQLite: json_extract(column, '$.path')
   * PostgreSQL: column #> ARRAY['path']
   */
  jsonExtract(column: SQL, pointer: JsonPointer): SQL;

  /**
   * Extracts a JSON value at a path as text.
   *
   * @example
   * SQLite: json_extract(column, '$.path')
   * PostgreSQL: column #>> ARRAY['path']
   */
  jsonExtractText(column: SQL, pointer: JsonPointer): SQL;

  /**
   * Extracts a JSON value at a path and casts to numeric.
   *
   * @example
   * SQLite: json_extract(column, '$.path')
   * PostgreSQL: (column #>> ARRAY['path'])::numeric
   */
  jsonExtractNumber(column: SQL, pointer: JsonPointer): SQL;

  /**
   * Extracts a JSON value at a path and casts to boolean.
   *
   * @example
   * SQLite: json_extract(column, '$.path')
   * PostgreSQL: (column #>> ARRAY['path'])::boolean
   */
  jsonExtractBoolean(column: SQL, pointer: JsonPointer): SQL;

  /**
   * Extracts a JSON value at a path and casts to timestamp.
   *
   * @example
   * SQLite: json_extract(column, '$.path')
   * PostgreSQL: (column #>> ARRAY['path'])::timestamptz
   */
  jsonExtractDate(column: SQL, pointer: JsonPointer): SQL;

  // ============================================================
  // JSON Array Operations
  // ============================================================

  /**
   * Returns the length of a JSON array.
   *
   * @example
   * SQLite: json_array_length(column)
   * PostgreSQL: jsonb_array_length(column)
   */
  jsonArrayLength(column: SQL): SQL;

  /**
   * Checks if a JSON array contains a specific value.
   *
   * @example
   * SQLite: EXISTS (SELECT 1 FROM json_each(column) WHERE value = ?)
   * PostgreSQL: column @> '[value]'::jsonb
   */
  jsonArrayContains(column: SQL, value: unknown): SQL;

  /**
   * Checks if a JSON array contains all specified values.
   *
   * @example
   * SQLite: Multiple EXISTS subqueries ANDed
   * PostgreSQL: column @> '[values]'::jsonb
   */
  jsonArrayContainsAll(column: SQL, values: readonly unknown[]): SQL;

  /**
   * Checks if a JSON array contains any of the specified values.
   *
   * @example
   * SQLite: Multiple EXISTS subqueries ORed
   * PostgreSQL: Multiple @> checks ORed
   */
  jsonArrayContainsAny(column: SQL, values: readonly unknown[]): SQL;

  // ============================================================
  // JSON Object Operations
  // ============================================================

  /**
   * Checks if a JSON object has a key at a path.
   *
   * @example
   * SQLite: json_type(column, '$.path') IS NOT NULL
   * PostgreSQL: column #> ARRAY['path'] IS NOT NULL
   */
  jsonHasPath(column: SQL, pointer: JsonPointer): SQL;

  /**
   * Checks if a JSON value at a path is SQL NULL or JSON null.
   *
   * @example
   * SQLite: json_extract(column, '$.path') IS NULL OR json_type(column, '$.path') = 'null'
   * PostgreSQL: column #> path IS NULL OR column #>> path = 'null'
   */
  jsonPathIsNull(column: SQL, pointer: JsonPointer): SQL;

  /**
   * Checks if a JSON value at a path is not null (neither SQL NULL nor JSON null).
   */
  jsonPathIsNotNull(column: SQL, pointer: JsonPointer): SQL;

  /**
   * Checks if the JSON value at a path exists and is a JSON number.
   *
   * Never evaluates to SQL NULL: a missing path yields FALSE, so the
   * predicate can be negated safely inside audit-style WHERE clauses.
   *
   * @example
   * SQLite: json_type(column, '$.path') IN ('integer', 'real')
   * PostgreSQL: jsonb_typeof(column #> path) = 'number'
   */
  jsonPathIsNumber(column: SQL, pointer: JsonPointer): SQL;

  // ============================================================
  // Comparison Operations
  // ============================================================

  /**
   * Null-safe equality: `TRUE` when both sides are equal OR both are NULL.
   * Unlike `=`, a NULL on either side does not yield NULL/unknown.
   *
   * Used by batched declared-index lookup so a NULL probe value matches a
   * NULL stored index-field value. Plain `=` would silently never match
   * NULLs, diverging from the lookup's documented null semantics.
   *
   * @example
   * SQLite: left IS right
   * PostgreSQL: left IS NOT DISTINCT FROM right
   */
  nullSafeEquals(left: SQL, right: SQL): SQL;

  // ============================================================
  // String Operations
  // ============================================================

  /**
   * Case-insensitive LIKE comparison.
   *
   * @example
   * SQLite: LOWER(column) LIKE LOWER(pattern)
   * PostgreSQL: column ILIKE pattern
   */
  ilike(column: SQL, pattern: SQL | string): SQL;

  // ============================================================
  // Set Operations
  // ============================================================

  /**
   * Wraps a single operand of a compound SELECT (UNION/INTERSECT/EXCEPT) so it
   * is a valid compound member for this dialect. The inner SQL is a complete
   * leaf SELECT (which may carry its own WITH clause) or an already-combined
   * nested compound.
   *
   * @example
   * SQLite: SELECT * FROM (inner)   // parenthesized operands are forbidden,
   *                                 // but a WITH may live in a FROM-subquery
   * PostgreSQL: (inner)
   */
  wrapSetOperationOperand(inner: SQL): SQL;

  // ============================================================
  // Recursive CTE Path Operations
  // ============================================================

  /**
   * Creates the initial path value for cycle detection.
   *
   * @example
   * SQLite: '|' || id || '|'
   * PostgreSQL: ARRAY[id]
   */
  initializePath(nodeId: SQL): SQL;

  /**
   * Extends a path with a new node ID.
   *
   * @example
   * SQLite: path || id || '|'
   * PostgreSQL: path || id
   */
  extendPath(currentPath: SQL, nodeId: SQL): SQL;

  /**
   * Checks if a node ID is NOT already in the path (for cycle prevention).
   * Returns a condition that is TRUE if there is no cycle.
   *
   * @example
   * SQLite: INSTR(path, '|' || id || '|') = 0
   * PostgreSQL: id != ALL(path)
   */
  cycleCheck(nodeId: SQL, path: SQL): SQL;

  // ============================================================
  // Value Binding & Literals
  // ============================================================

  /**
   * Converts a value for SQL binding.
   * SQLite doesn't support booleans directly, so they must be converted to 0/1.
   *
   * @example
   * SQLite: true → 1, false → 0
   * PostgreSQL: true → true (unchanged)
   */
  bindValue(value: unknown): unknown;

  /**
   * Returns a boolean literal for use in static SQL contexts (DDL, etc).
   *
   * @example
   * SQLite: sql.raw("1") or sql.raw("0")
   * PostgreSQL: sql.raw("TRUE") or sql.raw("FALSE")
   */
  booleanLiteral(value: boolean): SQL;

  /**
   * Returns a boolean literal as a raw string for DDL generation.
   *
   * @example
   * SQLite: "1" or "0"
   * PostgreSQL: "TRUE" or "FALSE"
   */
  booleanLiteralString(value: boolean): string;

  /**
   * Quotes an identifier (table name, column name, alias) with proper escaping.
   *
   * @example
   * SQLite: "name" → "\"name\"", "foo\"bar" → "\"foo\"\"bar\""
   * PostgreSQL: "name" → "\"name\"", "foo\"bar" → "\"foo\"\"bar\""
   */
  quoteIdentifier(name: string): string;

  // ============================================================
  // Vector Operations
  // ============================================================

  /**
   * Whether this dialect supports vector similarity predicates
   * (`field.similarTo(...)`) at compile time. The vector predicate pass
   * checks this before reaching for the backend's {@link VectorStrategy};
   * the strategy owns the actual distance SQL (`distanceExpression`), so
   * no per-dialect distance/format method lives on the dialect anymore.
   */
  readonly supportsVectors: boolean;

  // ============================================================
  // Fulltext Operations
  // ============================================================

  /**
   * Pluggable fulltext implementation for this dialect. `undefined` when
   * the dialect does not support fulltext. The query compiler checks
   * `capabilities.supportsFulltext` before reaching for this and throws
   * if a fulltext predicate runs against a dialect without a strategy.
   */
  readonly fulltext: FulltextStrategy | undefined;
}
