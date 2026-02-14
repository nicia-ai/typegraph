/**
 * SQLite Dialect Adapter
 *
 * Implements dialect-specific SQL generation for SQLite databases.
 * Uses SQLite's JSON1 extension for JSON operations.
 */
import { sql } from "drizzle-orm";

import { type JsonPointer, parseJsonPointer } from "../json-pointer";
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
    setOperationStrategy: "sqlite_compound",
    materializeIntermediateTraversalCtes: true,
    forceRecursiveWorktableOuterJoinOrder: true,
    vectorPredicateStrategy: "native",
    vectorMetrics: ["cosine", "l2"] as const,
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

    const conditions = values.map(
      (value) =>
        sql`EXISTS (SELECT 1 FROM json_each(${column}) WHERE json_each.value = ${value})`,
    );
    return sql`(${sql.join(conditions, sql` AND `)})`;
  },

  jsonArrayContainsAny(column, values) {
    if (values.length === 0) {
      return sql.raw("1=0");
    }

    const conditions = values.map(
      (value) =>
        sql`EXISTS (SELECT 1 FROM json_each(${column}) WHERE json_each.value = ${value})`,
    );
    return sql`(${sql.join(conditions, sql` OR `)})`;
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
    return sql`(json_extract(${column}, ${pathSql}) IS NULL OR json_type(${column}, ${pathSql}) = 'null')`;
  },

  jsonPathIsNotNull(column, pointer) {
    const path = toSqlitePath(pointer);
    const pathSql = sql.raw(escapeSqliteLiteral(path));
    return sql`(json_extract(${column}, ${pathSql}) IS NOT NULL AND json_type(${column}, ${pathSql}) != 'null')`;
  },

  // ============================================================
  // String Operations
  // ============================================================

  ilike(column, pattern) {
    // SQLite LIKE is case-insensitive for ASCII by default, but we use
    // LOWER() for consistency with non-ASCII characters
    return sql`LOWER(${column}) LIKE LOWER(${pattern})`;
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
  // Type Utilities
  // ============================================================

  currentTimestamp() {
    // Keep ISO-8601 format aligned with stored timestamps from Date.toISOString()
    // so string-based temporal comparisons remain correct in SQLite TEXT columns.
    return sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
  },

  // ============================================================
  // Value Binding & Literals
  // ============================================================

  bindValue(value) {
    // SQLite doesn't support native booleans, convert to 0/1
    if (typeof value === "boolean") {
      return value ? 1 : 0;
    }
    return value;
  },

  booleanLiteral(value) {
    return sql.raw(this.booleanLiteralString(value));
  },

  booleanLiteralString(value) {
    return value ? "1" : "0";
  },

  quoteIdentifier(name) {
    // SQLite uses double quotes (or backticks), escape embedded quotes by doubling
    return `"${name.replaceAll('"', '""')}"`;
  },

  // ============================================================
  // Vector Operations
  // ============================================================

  supportsVectors: true,

  vectorDistance(column, embedding, metric) {
    // sqlite-vec functions expect vec_f32 format for the query embedding
    const formatted = this.formatEmbedding(embedding);
    switch (metric) {
      case "cosine": {
        // Cosine distance: 1 - cosine_similarity
        // Lower is more similar (0 = identical)
        return sql`vec_distance_cosine(${column}, ${formatted})`;
      }
      case "l2": {
        // Euclidean (L2) distance
        // Lower is more similar (0 = identical)
        return sql`vec_distance_l2(${column}, ${formatted})`;
      }
      case "inner_product": {
        // sqlite-vec does not support inner product distance
        // See: https://alexgarcia.xyz/sqlite-vec/api-reference.html
        throw new Error(
          "Inner product distance is not supported by sqlite-vec. Use 'cosine' or 'l2' metrics instead.",
        );
      }
      default: {
        const _exhaustive: never = metric;
        throw new Error("Unsupported vector metric: " + String(_exhaustive));
      }
    }
  },

  formatEmbedding(embedding) {
    // Validate all values are finite numbers
    for (const [index, value] of embedding.entries()) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TypeError(
          `embedding[${index}] must be a finite number, got: ${value}`,
        );
      }
    }
    // sqlite-vec uses vec_f32() to convert JSON array to binary format
    const asJson = JSON.stringify(embedding);
    return sql`vec_f32(${asJson})`;
  },
};
