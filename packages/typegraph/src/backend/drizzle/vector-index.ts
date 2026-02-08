/**
 * Vector Index Management
 *
 * Provides utilities for creating and managing vector indexes
 * on the embeddings table for efficient similarity search.
 */
import { type SQL, sql } from "drizzle-orm";
import { type PgDatabase } from "drizzle-orm/pg-core";

import { type VectorIndexType, type VectorMetric } from "../types";

// ============================================================
// Validation
// ============================================================

/**
 * Validates that a value is a positive integer.
 */
function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${value}`);
  }
}

/**
 * Validates that a string is a safe SQL identifier (alphanumeric + underscore only).
 */
function assertSafeIdentifier(value: string, name: string): void {
  if (!/^[a-z0-9_]+$/i.test(value)) {
    throw new Error(
      `${name} must contain only alphanumeric characters and underscores, got: ${value}`,
    );
  }
}

// ============================================================
// Types
// ============================================================

/**
 * Options for creating a vector index.
 */
export type VectorIndexOptions = Readonly<{
  /** The graph ID */
  graphId: string;
  /** The node kind to index */
  nodeKind: string;
  /** The field path (embedding property name) */
  fieldPath: string;
  /** The number of dimensions (required for pgvector) */
  dimensions: number;
  /** The index type: "hnsw" (default) or "ivfflat" */
  indexType?: VectorIndexType;
  /** The similarity metric for the index */
  metric?: VectorMetric;
  /** HNSW-specific: maximum number of connections per layer (default: 16) */
  hnswM?: number;
  /** HNSW-specific: size of dynamic candidate list during construction (default: 64) */
  hnswEfConstruction?: number;
  /** IVFFlat-specific: number of inverted lists (default: 100) */
  ivfflatLists?: number;
}>;

/**
 * Result of a vector index operation.
 */
export type VectorIndexResult = Readonly<{
  /** The generated index name */
  indexName: string;
  /** Whether the operation succeeded */
  success: boolean;
  /** Optional message */
  message?: string;
}>;

// ============================================================
// Index Name Generation
// ============================================================

/**
 * Sanitizes a string to be a valid SQL identifier component.
 */
function sanitizeIdentifier(s: string): string {
  return s
    .toLowerCase()
    .replaceAll(/[^a-z0-9_]/g, "_")
    .slice(0, 20);
}

/**
 * Generates a consistent index name for a vector index.
 *
 * Format: `idx_emb_{graphId}_{nodeKind}_{fieldPath}_{metric}`
 * Names are sanitized to be valid SQL identifiers.
 */
export function generateVectorIndexName(
  graphId: string,
  nodeKind: string,
  fieldPath: string,
  metric: VectorMetric = "cosine",
): string {
  const parts = [
    "idx_emb",
    sanitizeIdentifier(graphId),
    sanitizeIdentifier(nodeKind),
    sanitizeIdentifier(fieldPath),
    metric,
  ];

  return parts.join("_");
}

// ============================================================
// PostgreSQL Vector Index Operations
// ============================================================

/**
 * Gets the pgvector operator class for a given metric.
 */
function getOperatorClass(metric: VectorMetric): string {
  switch (metric) {
    case "cosine": {
      return "vector_cosine_ops";
    }
    case "l2": {
      return "vector_l2_ops";
    }
    case "inner_product": {
      return "vector_ip_ops";
    }
  }
}

/**
 * Escapes a string for use in a SQL string literal.
 * Uses dollar quoting to avoid issues with embedded quotes.
 */
function escapeSqlString(value: string): string {
  // Use dollar quoting with a unique tag to safely embed any string
  // This handles single quotes, backslashes, and any other special chars
  const tag = `tg${Date.now()}`;
  return `$${tag}$${value}$${tag}$`;
}

/**
 * Creates a vector index on the embeddings table (PostgreSQL/pgvector).
 *
 * This should be called after the embeddings table is created.
 * The index significantly improves similarity search performance.
 *
 * @example
 * ```typescript
 * await createVectorIndex(db, {
 *   graphId: "my-graph",
 *   nodeKind: "Document",
 *   fieldPath: "embedding",
 *   dimensions: 1536,
 *   indexType: "hnsw",
 *   metric: "cosine",
 * });
 * ```
 */
export async function createPostgresVectorIndex(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle's generic database type
  db: PgDatabase<any>,
  options: VectorIndexOptions,
): Promise<VectorIndexResult> {
  const {
    graphId,
    nodeKind,
    fieldPath,
    dimensions,
    indexType = "hnsw",
    metric = "cosine",
    hnswM = 16,
    hnswEfConstruction = 64,
    ivfflatLists = 100,
  } = options;

  // Validate all numeric parameters
  assertPositiveInteger(dimensions, "dimensions");
  assertPositiveInteger(hnswM, "hnswM");
  assertPositiveInteger(hnswEfConstruction, "hnswEfConstruction");
  assertPositiveInteger(ivfflatLists, "ivfflatLists");

  const indexName = generateVectorIndexName(graphId, nodeKind, fieldPath, metric);
  const operatorClass = getOperatorClass(metric);

  // Validate that the generated index name is safe
  assertSafeIdentifier(indexName, "indexName");

  // Use dollar quoting for string values to prevent SQL injection
  const safeGraphId = escapeSqlString(graphId);
  const safeNodeKind = escapeSqlString(nodeKind);
  const safeFieldPath = escapeSqlString(fieldPath);

  // Build the CREATE INDEX statement
  let indexSql: SQL;

  if (indexType === "hnsw") {
    // HNSW index with optional parameters
    // Column is native VECTOR type, but we still specify dimensions in the
    // index expression to ensure consistent index behavior
    indexSql = sql.raw(`
      CREATE INDEX IF NOT EXISTS ${indexName}
      ON typegraph_node_embeddings
      USING hnsw ((embedding::vector(${dimensions})) ${operatorClass})
      WITH (m = ${hnswM}, ef_construction = ${hnswEfConstruction})
      WHERE graph_id = ${safeGraphId}
        AND node_kind = ${safeNodeKind}
        AND field_path = ${safeFieldPath}
    `);
  } else if (indexType === "ivfflat") {
    // IVFFlat index
    // Column is native VECTOR type, but we still specify dimensions in the
    // index expression to ensure consistent index behavior
    indexSql = sql.raw(`
      CREATE INDEX IF NOT EXISTS ${indexName}
      ON typegraph_node_embeddings
      USING ivfflat ((embedding::vector(${dimensions})) ${operatorClass})
      WITH (lists = ${ivfflatLists})
      WHERE graph_id = ${safeGraphId}
        AND node_kind = ${safeNodeKind}
        AND field_path = ${safeFieldPath}
    `);
  } else {
    // No index (or unsupported type)
    return {
      indexName,
      success: true,
      message: `Index type "${indexType}" not supported, skipping index creation`,
    };
  }

  try {
    await db.execute(indexSql);
    return {
      indexName,
      success: true,
      message: `Created ${indexType.toUpperCase()} index "${indexName}" for ${nodeKind}.${fieldPath}`,
    };
  } catch (error) {
    return {
      indexName,
      success: false,
      message: `Failed to create index: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Drops a vector index (PostgreSQL).
 *
 * @param indexName - Must be a valid SQL identifier (alphanumeric + underscore only)
 */
export async function dropPostgresVectorIndex(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle's generic database type
  db: PgDatabase<any>,
  indexName: string,
): Promise<VectorIndexResult> {
  // Validate index name to prevent SQL injection
  assertSafeIdentifier(indexName, "indexName");

  try {
    const dropSql = sql.raw(`DROP INDEX IF EXISTS ${indexName}`);
    await db.execute(dropSql);
    return {
      indexName,
      success: true,
      message: `Dropped index "${indexName}"`,
    };
  } catch (error) {
    return {
      indexName,
      success: false,
      message: `Failed to drop index: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================================
// SQLite Vector Index Operations
// ============================================================

/**
 * SQLite/sqlite-vec doesn't support traditional indexes on virtual tables.
 * Vector search is optimized through the extension itself.
 *
 * This function is a no-op for SQLite but provides a consistent API.
 */
export function createSqliteVectorIndex(
  _options: VectorIndexOptions,
): VectorIndexResult {
  const indexName = generateVectorIndexName(
    _options.graphId,
    _options.nodeKind,
    _options.fieldPath,
    _options.metric,
  );

  return {
    indexName,
    success: true,
    message: "SQLite/sqlite-vec uses optimized internal indexing, no explicit index needed",
  };
}

/**
 * SQLite vector index drop (no-op for consistency).
 */
export function dropSqliteVectorIndex(
  graphId: string,
  nodeKind: string,
  fieldPath: string,
  metric: VectorMetric = "cosine",
): VectorIndexResult {
  const indexName = generateVectorIndexName(graphId, nodeKind, fieldPath, metric);

  return {
    indexName,
    success: true,
    message: "SQLite/sqlite-vec does not use explicit indexes",
  };
}
