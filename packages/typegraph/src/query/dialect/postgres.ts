/**
 * PostgreSQL Dialect Adapter
 *
 * Implements dialect-specific SQL generation for PostgreSQL databases.
 * Uses PostgreSQL's native JSONB operators for JSON operations.
 */
import { type JsonPointer, parseJsonPointer } from "../json-pointer";
import { sql, type SqlFragment } from "../sql-fragment";
import { tsvectorStrategy } from "./fulltext-strategy";
import { likeEscapeClause } from "./like-escape";
import { getSqlDialectProfile, inlineSqlStringLiteral } from "./profile";
import { type DialectAdapter } from "./types";

/**
 * Escapes a string for use in a PostgreSQL string literal, independent of
 * server configuration.
 *
 * A plain `'…'` literal is only safe when the value contains no backslash:
 * under the legacy `standard_conforming_strings = off` setting, backslashes
 * act as escape characters inside regular literals, so a value ending in
 * `\` could swallow the closing quote and change how the statement parses.
 * Values containing a backslash therefore use the `E'…'` form — where
 * backslash is an escape character under BOTH settings — with backslashes
 * and quotes doubled. Backslash-free values keep the plain form so the
 * emitted SQL text (which callers rely on being identical across clauses)
 * is unchanged for the common case.
 */
/**
 * Converts a JSON pointer to PostgreSQL's text array path.
 *
 * Uses raw SQL (non-parameterized) to ensure the same expression text
 * is generated when the same field is used in multiple clauses (SELECT, GROUP BY).
 * Pointers usually come from schema definitions, but some (e.g. a weighted
 * traversal's `weightProperty`) are runtime strings — safe either way
 * because the shared PostgreSQL literal renderer escapes independently of server
 * configuration.
 *
 * @example
 * "/name" → ARRAY['name']
 * "/items/0" → ARRAY['items', '0']
 * "/a/b/c" → ARRAY['a', 'b', 'c']
 */
function toPostgresPath(pointer: JsonPointer): SqlFragment {
  if (!pointer || pointer === "" || pointer === "/") {
    return sql.raw("ARRAY[]::text[]");
  }

  const segments = parseJsonPointer(pointer);
  if (segments.length === 0) {
    return sql.raw("ARRAY[]::text[]");
  }

  // Use raw SQL for path segments to ensure identical SQL text
  // when the same field is used in multiple clauses (e.g., SELECT and GROUP BY)
  const escapedSegments = segments
    .map((segment) => inlineSqlStringLiteral(segment, "postgres"))
    .join(", ");
  return sql.raw(`ARRAY[${escapedSegments}]`);
}

/**
 * PostgreSQL dialect adapter implementation.
 */
export const postgresDialect: DialectAdapter = {
  name: "postgres",
  capabilities: {
    standardQueryStrategy: "cte_project",
    recursiveQueryStrategy: "recursive_cte",
    materializeIntermediateTraversalCtes: false,
    emitNotMaterializedHint: true,
    forceRecursiveWorktableOuterJoinOrder: false,
    vectorPredicateStrategy: "native",
    vectorMetrics: ["cosine", "l2", "inner_product"] as const,
    supportsFulltext: true,
  },

  binaryText(expression) {
    return sql`${expression} COLLATE "C"`;
  },

  analyzeTemporaryTable(table) {
    return sql`ANALYZE ${table}`;
  },

  setTransactionWorkingMemory(workingMemory) {
    // The parameterizable form of `SET LOCAL work_mem`: is_local => true
    // scopes the override to the current transaction, matching the pgvector
    // iterative-scan GUC handling elsewhere in the backend.
    return sql`SELECT set_config('work_mem', ${workingMemory}, true)`;
  },

  // ============================================================
  // JSON Path Operations
  // ============================================================

  compilePath(pointer) {
    return toPostgresPath(pointer);
  },

  jsonExtract(column, pointer) {
    // #> returns JSONB value at path
    const path = toPostgresPath(pointer);
    return sql`${column} #> ${path}`;
  },

  jsonExtractText(column, pointer) {
    // #>> returns text value at path
    const path = toPostgresPath(pointer);
    return sql`${column} #>> ${path}`;
  },

  jsonExtractNumber(column, pointer) {
    // Extract as text then cast to numeric
    const path = toPostgresPath(pointer);
    return sql`(${column} #>> ${path})::numeric`;
  },

  jsonExtractDouble(column, pointer) {
    // float8, not ::numeric — decimal arithmetic would diverge from
    // SQLite's binary doubles when values accumulate.
    const path = toPostgresPath(pointer);
    return sql`(${column} #>> ${path})::double precision`;
  },

  jsonExtractBoolean(column, pointer) {
    // Extract as text then cast to boolean
    const path = toPostgresPath(pointer);
    return sql`(${column} #>> ${path})::boolean`;
  },

  jsonExtractDate(column, pointer) {
    // Extract as text then cast to timestamptz
    const path = toPostgresPath(pointer);
    return sql`(${column} #>> ${path})::timestamptz`;
  },

  // ============================================================
  // JSON Array Operations
  // ============================================================

  jsonArrayLength(column) {
    return sql`jsonb_array_length(${column})`;
  },

  jsonArrayContains(column, value) {
    // @> checks if left contains right
    const jsonValue = JSON.stringify([value]);
    return sql`${column} @> ${jsonValue}::jsonb`;
  },

  jsonArrayContainsAll(column, values) {
    if (values.length === 0) {
      return sql.raw("1=1");
    }

    // @> with full array checks all values
    const jsonValue = JSON.stringify(values);
    return sql`${column} @> ${jsonValue}::jsonb`;
  },

  jsonArrayContainsAny(column, values) {
    if (values.length === 0) {
      return sql.raw("1=0");
    }

    // Check each value with @> and OR them together
    // PostgreSQL doesn't have a native "overlaps" for jsonb arrays
    const conditions = values.map((value) => {
      const jsonValue = JSON.stringify([value]);
      return sql`${column} @> ${jsonValue}::jsonb`;
    });
    return sql`(${sql.join(conditions, sql` OR `)})`;
  },

  // ============================================================
  // JSON Object Operations
  // ============================================================

  jsonHasPath(column, pointer) {
    const path = toPostgresPath(pointer);
    return sql`${column} #> ${path} IS NOT NULL`;
  },

  jsonPathIsNull(column, pointer) {
    const path = toPostgresPath(pointer);
    // Type-based, not the `#>> path = 'null'` text comparison this used to
    // be: `#>>` renders a JSON null as SQL NULL (making the old form
    // three-valued, so `.pathIsNull()` silently missed stored JSON nulls) and
    // renders the JSON *string* "null" as the same text 'null' (falsely
    // matching it). jsonb_typeof distinguishes both, and COALESCE maps a
    // missing path to TRUE, keeping the predicate two-valued.
    return sql`COALESCE(jsonb_typeof(${column} #> ${path}) = 'null', TRUE)`;
  },

  jsonPathIsNumber(column, pointer) {
    const path = toPostgresPath(pointer);
    // jsonb_typeof returns NULL for a missing path; COALESCE keeps the
    // predicate two-valued so negations don't silently drop rows.
    return sql`COALESCE(jsonb_typeof(${column} #> ${path}) = 'number', FALSE)`;
  },

  jsonPathIsNotNull(column, pointer) {
    const path = toPostgresPath(pointer);
    // Mirror image of jsonPathIsNull; COALESCE maps a missing path to FALSE.
    return sql`COALESCE(jsonb_typeof(${column} #> ${path}) <> 'null', FALSE)`;
  },

  // ============================================================
  // Comparison Operations
  // ============================================================

  nullSafeEquals(left, right) {
    return sql`${left} IS NOT DISTINCT FROM ${right}`;
  },

  inList(left, values, negated) {
    const operator = negated ? sql.raw("NOT IN") : sql.raw("IN");
    const placeholders = values.map((value) => sql`${value}`);
    return sql`${left} ${operator} (${sql.join(placeholders, sql`, `)})`;
  },

  // ============================================================
  // String Operations
  // ============================================================

  ilike(column, pattern) {
    // PostgreSQL has native ILIKE operator. Declaring backslash as the escape
    // character is a no-op (it is the LIKE default) but keeps the emitted SQL
    // identical in intent to SQLite, which has no default escape character.
    return sql`${column} ILIKE ${pattern} ${likeEscapeClause}`;
  },

  // ============================================================
  // Set Operations
  // ============================================================

  wrapSetOperationOperand(inner) {
    // PostgreSQL allows a complete SELECT (incl. its own WITH) as a
    // parenthesized compound operand.
    return sql`(${inner})`;
  },

  // ============================================================
  // Recursive CTE Path Operations
  // ============================================================

  initializePath(nodeId) {
    // PostgreSQL uses text arrays: ARRAY[id]
    return sql`ARRAY[${nodeId}]`;
  },

  extendPath(currentPath, nodeId) {
    // Array concatenation: path || id
    return sql`${currentPath} || ${nodeId}`;
  },

  cycleCheck(nodeId, path) {
    // Check that id is NOT in array path
    // Returns TRUE if no cycle (id not in array)
    return sql`${nodeId} != ALL(${path})`;
  },

  // ============================================================
  // Value Binding & Literals
  // ============================================================

  bindValue(value) {
    return getSqlDialectProfile("postgres").bindValue(value);
  },

  booleanLiteral(value) {
    return sql.raw(
      getSqlDialectProfile("postgres").booleanLiteralString(value),
    );
  },

  booleanLiteralString(value) {
    return getSqlDialectProfile("postgres").booleanLiteralString(value);
  },

  quoteIdentifier(name) {
    // PostgreSQL uses double quotes, escape embedded quotes by doubling
    return `"${name.replaceAll('"', '""')}"`;
  },

  // ============================================================
  // Vector Operations
  // ============================================================

  // Compile-time gate for `field.similarTo(...)`; the active
  // `VectorStrategy` (pgvector) owns the distance SQL.
  supportsVectors: true,

  // ============================================================
  // Fulltext Operations
  // ============================================================

  fulltext: tsvectorStrategy,
};
