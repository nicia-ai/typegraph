/**
 * SQLite Dialect Adapter
 *
 * Implements dialect-specific SQL generation for SQLite databases.
 * Uses SQLite's JSON1 extension for JSON operations.
 */
import { type JsonPointer, parseJsonPointer } from "../json-pointer";
import { sql } from "../sql-fragment";
import { fts5Strategy } from "./fulltext-strategy";
import { likeEscapeClause } from "./like-escape";
import { getSqlDialectProfile } from "./profile";
import { type DialectAdapter } from "./types";

/**
 * Escapes a string for use in a SQLite string literal.
 * SQLite uses single quotes and escapes embedded single quotes by doubling them.
 */
function escapeSqliteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Converts a JSON pointer to SQLite's JSON path syntax.
 *
 * @example
 * "/name" → "$.\"name\""
 * "/items/0" → "$.\"items\"[0]"
 * "/a/b/c" → "$.\"a\".\"b\".\"c\""
 */
function toSqlitePath(pointer: JsonPointer): string {
  if (!pointer || pointer === "" || pointer === "/") {
    return "$";
  }

  const segments = parseJsonPointer(pointer);
  const parts: string[] = ["$"];

  for (const segment of segments) {
    if (isArrayIndex(segment)) {
      parts.push(`[${segment}]`);
    } else {
      // Quote the key to handle special characters
      parts.push(`.${JSON.stringify(segment)}`);
    }
  }

  return parts.join("");
}

/**
 * Checks if a JSON pointer segment is an array index.
 */
function isArrayIndex(segment: string): boolean {
  return /^\d+$/.test(segment);
}

/**
 * SQLite dialect adapter implementation.
 */
export const sqliteDialect: DialectAdapter = {
  name: "sqlite",
  capabilities: {
    standardQueryStrategy: "cte_project",
    recursiveQueryStrategy: "recursive_cte",
    materializeIntermediateTraversalCtes: true,
    emitNotMaterializedHint: false,
    forceRecursiveWorktableOuterJoinOrder: true,
    vectorPredicateStrategy: "native",
    vectorMetrics: ["cosine", "l2"] as const,
    supportsFulltext: true,
  },

  binaryText(expression) {
    return expression;
  },

  analyzeTemporaryTable(): undefined {
    return;
  },

  setTransactionWorkingMemory(): undefined {
    // SQLite has no per-transaction working-memory budget to raise.
    return;
  },

  // ============================================================
  // JSON Path Operations
  // ============================================================

  compilePath(pointer) {
    // Use raw SQL to ensure the path is a literal, which allows expression
    // indexes on json_extract(...) to be used by the query planner.
    return sql.raw(escapeSqliteLiteral(toSqlitePath(pointer)));
  },

  jsonExtract(column, pointer) {
    const path = toSqlitePath(pointer);
    return sql`json_extract(${column}, ${sql.raw(escapeSqliteLiteral(path))})`;
  },

  jsonExtractText(column, pointer) {
    // SQLite's json_extract returns the native JSON type, which works
    // for text comparisons. For explicit text, we use the same function.
    const path = toSqlitePath(pointer);
    return sql`json_extract(${column}, ${sql.raw(escapeSqliteLiteral(path))})`;
  },

  jsonExtractNumber(column, pointer) {
    // SQLite json_extract returns numbers natively when the value is numeric
    const path = toSqlitePath(pointer);
    return sql`json_extract(${column}, ${sql.raw(escapeSqliteLiteral(path))})`;
  },

  jsonExtractDouble(column, pointer) {
    // json_extract already yields INTEGER/REAL affinity for JSON numbers,
    // and SQLite arithmetic on those values is IEEE 754 double.
    const path = toSqlitePath(pointer);
    return sql`json_extract(${column}, ${sql.raw(escapeSqliteLiteral(path))})`;
  },

  jsonExtractBoolean(column, pointer) {
    // SQLite json_extract returns 0/1 for boolean values
    const path = toSqlitePath(pointer);
    return sql`json_extract(${column}, ${sql.raw(escapeSqliteLiteral(path))})`;
  },

  jsonExtractDate(column, pointer) {
    // SQLite stores dates as ISO strings, json_extract returns them as text
    const path = toSqlitePath(pointer);
    return sql`json_extract(${column}, ${sql.raw(escapeSqliteLiteral(path))})`;
  },

  // ============================================================
  // JSON Array Operations
  // ============================================================

  jsonArrayLength(column) {
    return sql`json_array_length(${column})`;
  },

  jsonArrayContains(column, value) {
    return sql`EXISTS (SELECT 1 FROM json_each(${column}) WHERE json_each.value = ${value})`;
  },

  jsonArrayContainsAll(column, values) {
    if (values.length === 0) {
      return sql.raw("1=1");
    }
    const packedValues = JSON.stringify(values);
    return sql`
      NOT EXISTS (
            SELECT 1 FROM json_each(${packedValues}) AS tg_required
            WHERE NOT EXISTS (
              SELECT 1 FROM json_each(${column}) AS tg_actual
              WHERE tg_actual.value = tg_required.value
            )
          )
    `;
  },

  jsonArrayContainsAny(column, values) {
    if (values.length === 0) {
      return sql.raw("1=0");
    }
    const packedValues = JSON.stringify(values);
    return sql`
      EXISTS (
            SELECT 1
            FROM json_each(${column}) AS tg_actual
            JOIN json_each(${packedValues}) AS tg_wanted
              ON tg_actual.value = tg_wanted.value
          )
    `;
  },

  // ============================================================
  // JSON Object Operations
  // ============================================================

  jsonHasPath(column, pointer) {
    const path = toSqlitePath(pointer);
    return sql`json_type(${column}, ${sql.raw(escapeSqliteLiteral(path))}) IS NOT NULL`;
  },

  jsonPathIsNull(column, pointer) {
    const path = toSqlitePath(pointer);
    const pathSql = sql.raw(escapeSqliteLiteral(path));
    return sql`COALESCE(json_type(${column}, ${pathSql}) = 'null', 1)`;
  },

  jsonPathIsNumber(column, pointer) {
    const path = toSqlitePath(pointer);
    const pathSql = sql.raw(escapeSqliteLiteral(path));
    // json_type returns NULL for a missing path; COALESCE keeps the
    // predicate two-valued so negations don't silently drop rows.
    return sql`COALESCE(json_type(${column}, ${pathSql}) IN ('integer', 'real'), 0)`;
  },

  jsonPathIsNotNull(column, pointer) {
    const path = toSqlitePath(pointer);
    const pathSql = sql.raw(escapeSqliteLiteral(path));
    return sql`COALESCE(json_type(${column}, ${pathSql}) <> 'null', 0)`;
  },

  // ============================================================
  // Comparison Operations
  // ============================================================

  nullSafeEquals(left, right) {
    // SQLite's IS operator is null-safe equality (equivalent to = for
    // non-null operands, TRUE when both sides are NULL).
    return sql`${left} IS ${right}`;
  },

  inList(left, values, negated) {
    const operator = negated ? sql.raw("NOT IN") : sql.raw("IN");
    const packedValues = JSON.stringify(values);
    return sql`${left} ${operator} (SELECT value FROM json_each(${packedValues}))`;
  },

  // ============================================================
  // String Operations
  // ============================================================

  ilike(column, pattern) {
    // SQLite LIKE is case-insensitive for ASCII by default, but we use
    // LOWER() for consistency with non-ASCII characters. SQLite has no default
    // LIKE escape character, so declare backslash explicitly to honor the
    // escaping the compiler applies to the pattern (parity with Postgres).
    return sql`LOWER(${column}) LIKE LOWER(${pattern}) ${likeEscapeClause}`;
  },

  // ============================================================
  // Set Operations
  // ============================================================

  wrapSetOperationOperand(inner) {
    // SQLite forbids parenthesized compound operands, but a FROM-subquery may
    // carry its own WITH clause, so wrap each operand as a subquery.
    return sql`SELECT * FROM (${inner})`;
  },

  // ============================================================
  // Recursive CTE Path Operations
  // ============================================================

  initializePath(nodeId) {
    // SQLite uses string-based paths with delimiters: '|id|'
    return sql`'|' || ${nodeId} || '|'`;
  },

  extendPath(currentPath, nodeId) {
    // Append: path || id || '|'
    return sql`${currentPath} || ${nodeId} || '|'`;
  },

  cycleCheck(nodeId, path) {
    // Check that id is NOT in path using INSTR
    // Returns TRUE if no cycle (id not found in path)
    return sql`INSTR(${path}, '|' || ${nodeId} || '|') = 0`;
  },

  // ============================================================
  // Value Binding & Literals
  // ============================================================

  bindValue(value) {
    return getSqlDialectProfile("sqlite").bindValue(value);
  },

  booleanLiteral(value) {
    return sql.raw(getSqlDialectProfile("sqlite").booleanLiteralString(value));
  },

  booleanLiteralString(value) {
    return getSqlDialectProfile("sqlite").booleanLiteralString(value);
  },

  quoteIdentifier(name) {
    // SQLite uses double quotes (or backticks), escape embedded quotes by doubling
    return `"${name.replaceAll('"', '""')}"`;
  },

  // ============================================================
  // Vector Operations
  // ============================================================

  // Compile-time gate for `field.similarTo(...)`; the active
  // `VectorStrategy` (sqlite-vec / libSQL-native) owns the distance SQL.
  supportsVectors: true,

  // ============================================================
  // Fulltext Operations
  // ============================================================

  fulltext: fts5Strategy,
};
