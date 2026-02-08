/**
 * PostgreSQL Dialect Adapter
 *
 * Implements dialect-specific SQL generation for PostgreSQL databases.
 * Uses PostgreSQL's native JSONB operators for JSON operations.
 */
import { type SQL, sql } from "drizzle-orm";

import { type JsonPointer, parseJsonPointer } from "../json-pointer";
import { type DialectAdapter } from "./types";

/**
 * Escapes a string for use in a PostgreSQL string literal.
 * Uses single quotes and escapes embedded single quotes.
 */
function escapePostgresLiteral(value: string): string {
  // PostgreSQL uses '' to escape single quotes inside string literals
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Converts a JSON pointer to PostgreSQL's text array path.
 *
 * Uses raw SQL (non-parameterized) to ensure the same expression text
 * is generated when the same field is used in multiple clauses (SELECT, GROUP BY).
 * This is safe because JSON pointers come from schema definitions, not user input.
 *
 * @example
 * "/name" → ARRAY['name']
 * "/items/0" → ARRAY['items', '0']
 * "/a/b/c" → ARRAY['a', 'b', 'c']
 */
function toPostgresPath(pointer: JsonPointer): SQL {
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
    .map((segment) => escapePostgresLiteral(segment))
    .join(", ");
  return sql.raw(`ARRAY[${escapedSegments}]`);
}

/**
 * PostgreSQL dialect adapter implementation.
 */
export const postgresDialect: DialectAdapter = {
  name: "postgres",

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
    // Check both SQL NULL and JSON null literal
    return sql`(${column} #> ${path} IS NULL OR ${column} #>> ${path} = 'null')`;
  },

  jsonPathIsNotNull(column, pointer) {
    const path = toPostgresPath(pointer);
    return sql`(${column} #> ${path} IS NOT NULL AND ${column} #>> ${path} != 'null')`;
  },

  // ============================================================
  // String Operations
  // ============================================================

  ilike(column, pattern) {
    // PostgreSQL has native ILIKE operator
    return sql`${column} ILIKE ${pattern}`;
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
  // Type Utilities
  // ============================================================

  currentTimestamp() {
    return sql`NOW()`;
  },

  // ============================================================
  // Value Binding & Literals
  // ============================================================

  bindValue(value) {
    // PostgreSQL supports native booleans, no conversion needed
    return value;
  },

  booleanLiteral(value) {
    return sql.raw(this.booleanLiteralString(value));
  },

  booleanLiteralString(value) {
    return value ? "TRUE" : "FALSE";
  },

  quoteIdentifier(name) {
    // PostgreSQL uses double quotes, escape embedded quotes by doubling
    return `"${name.replaceAll('"', '""')}"`;
  },

  // ============================================================
  // Vector Operations
  // ============================================================

  supportsVectors: true,

  vectorDistance(column, embedding, metric) {
    const formatted = this.formatEmbedding(embedding);
    // Column is native VECTOR type, no cast needed
    switch (metric) {
      case "cosine": {
        // Cosine distance: 1 - cosine_similarity
        // Lower is more similar (0 = identical)
        return sql`(${column} <=> ${formatted})`;
      }
      case "l2": {
        // Euclidean (L2) distance
        // Lower is more similar (0 = identical)
        return sql`(${column} <-> ${formatted})`;
      }
      case "inner_product": {
        // Inner product distance (negative inner product)
        // Note: pgvector uses <#> which returns NEGATIVE inner product
        // More negative = more similar for normalized vectors
        return sql`(${column} <#> ${formatted})`;
      }
    }
  },

  formatEmbedding(embedding) {
    // Validate all values are finite numbers to prevent injection
    for (const [index, value] of embedding.entries()) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TypeError(
          `embedding[${index}] must be a finite number, got: ${value}`,
        );
      }
    }
    // Format as PostgreSQL vector literal: '[1.0,2.0,3.0]'::vector
    // Query embedding still needs cast since it's a literal string
    const asString = `[${embedding.join(",")}]`;
    return sql`${asString}::vector`;
  },
};
