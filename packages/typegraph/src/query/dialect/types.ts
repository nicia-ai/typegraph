/**
 * SQL Dialect Abstraction Layer
 *
 * Provides a unified interface for dialect-specific SQL generation.
 * Implementing a new dialect (MySQL, SQL Server, etc.) requires
 * implementing this interface.
 */
import { type SQL } from "drizzle-orm";

import { type VectorMetric } from "../../backend/types";
import { type JsonPointer } from "../json-pointer";

/**
 * Supported SQL dialects.
 */
export type SqlDialect = "sqlite" | "postgres";

/**
 * Strategy for compiling set operations.
 */
export type DialectSetOperationStrategy =
  | "standard_parenthesized"
  | "sqlite_compound";

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
   * Set operation compilation strategy.
   */
  setOperationStrategy: DialectSetOperationStrategy;

  /**
   * Whether intermediate traversal CTEs should be materialized.
   */
  materializeIntermediateTraversalCtes: boolean;

  /**
   * Whether recursive CTEs should enforce worktable-first join ordering.
   */
  forceRecursiveWorktableOuterJoinOrder: boolean;

  /**
   * Strategy for vector predicate support.
   */
  vectorPredicateStrategy: DialectVectorPredicateStrategy;

  /**
   * Metrics supported by vector predicates for this dialect.
   */
  vectorMetrics: readonly VectorMetric[];
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
  // Type Utilities
  // ============================================================

  /**
   * Returns the current timestamp expression.
   *
   * @example
   * SQLite: datetime('now')
   * PostgreSQL: NOW()
   */
  currentTimestamp(): SQL;

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
   * Whether this dialect supports vector similarity operations.
   * When false, vector operations will throw an error.
   *
   * Note: This indicates dialect-level support. Actual availability
   * depends on whether the vector extension is loaded at runtime.
   */
  readonly supportsVectors: boolean;

  /**
   * Computes the distance between a column and a query embedding.
   * Lower values indicate higher similarity.
   *
   * @param column - The column containing the embedding (e.g., from embeddings table)
   * @param embedding - The query embedding as a number array
   * @param metric - The similarity metric to use
   * @returns SQL expression computing the distance
   *
   * @example
   * PostgreSQL (cosine): column <=> '[1,2,3]'::vector
   * PostgreSQL (L2): column <-> '[1,2,3]'::vector
   * PostgreSQL (inner product): column <#> '[1,2,3]'::vector
   * SQLite: vec_distance_cosine(column, vec_f32('[1,2,3]'))
   */
  vectorDistance(
    column: SQL,
    embedding: readonly number[],
    metric: VectorMetric,
  ): SQL;

  /**
   * Formats an embedding array for use in SQL.
   *
   * @param embedding - The embedding as a number array
   * @returns SQL expression representing the embedding
   *
   * @example
   * PostgreSQL: '[1.0,2.0,3.0]'::vector
   * SQLite: vec_f32('[1.0,2.0,3.0]')
   */
  formatEmbedding(embedding: readonly number[]): SQL;
}
