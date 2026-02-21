/**
 * Backend interface types for TypeGraph storage.
 *
 * The backend abstracts database operations, allowing different
 * SQL implementations (SQLite, PostgreSQL) behind a common interface.
 */
import { type SQL } from "drizzle-orm";

import { type TemporalMode } from "../core/types";
import { type SqlTableNames } from "../query/compiler/schema";
import { type SerializedSchema } from "../schema/types";

// ============================================================
// Vector Search Types
// ============================================================

/**
 * Supported vector similarity metrics.
 */
export type VectorMetric = "cosine" | "l2" | "inner_product";

/**
 * Supported vector index types.
 */
export type VectorIndexType = "hnsw" | "ivfflat" | "none";

/**
 * Vector search capabilities.
 */
export type VectorCapabilities = Readonly<{
  /** Whether the backend supports vector operations */
  supported: boolean;
  /** Supported similarity metrics */
  metrics: readonly VectorMetric[];
  /** Supported index types */
  indexTypes: readonly VectorIndexType[];
  /** Maximum dimensions supported */
  maxDimensions: number;
}>;

// ============================================================
// SQL Dialect & Capabilities
// ============================================================

import { type SqlDialect } from "../query/dialect/types";

export type { SqlDialect } from "../query/dialect/types";

/**
 * Backend capabilities that vary by dialect.
 */
export type BackendCapabilities = Readonly<{
  /** Whether the backend supports JSONB type (vs TEXT for JSON) */
  jsonb: boolean;
  /** Whether the backend supports partial indexes */
  partialIndexes: boolean;
  /** Whether the backend supports GIN indexes for JSON */
  ginIndexes: boolean;
  /** Whether the backend supports CTE (WITH) queries */
  cte: boolean;
  /** Whether the backend supports RETURNING clause */
  returning: boolean;
  /** Whether the backend supports atomic transactions (D1 does not) */
  transactions: boolean;
  /** Vector search capabilities (undefined if not configured) */
  vector?: VectorCapabilities | undefined;
}>;

// ============================================================
// Row Types (Database Records)
// ============================================================

/**
 * A row from the typegraph_nodes table.
 */
export type NodeRow = Readonly<{
  graph_id: string;
  kind: string;
  id: string;
  props: string; // JSON string
  version: number;
  valid_from: string | undefined;
  valid_to: string | undefined;
  created_at: string;
  updated_at: string;
  deleted_at: string | undefined;
}>;

/**
 * A row from the typegraph_edges table.
 */
export type EdgeRow = Readonly<{
  graph_id: string;
  id: string;
  kind: string;
  from_kind: string;
  from_id: string;
  to_kind: string;
  to_id: string;
  props: string; // JSON string
  valid_from: string | undefined;
  valid_to: string | undefined;
  created_at: string;
  updated_at: string;
  deleted_at: string | undefined;
}>;

/**
 * A row from the typegraph_node_uniques table.
 */
export type UniqueRow = Readonly<{
  graph_id: string;
  node_kind: string;
  constraint_name: string;
  key: string;
  node_id: string;
  concrete_kind: string;
  deleted_at: string | undefined;
}>;

/**
 * A row from the typegraph_schema_versions table.
 */
export type SchemaVersionRow = Readonly<{
  graph_id: string;
  version: number;
  schema_hash: string;
  schema_doc: string; // JSON string
  created_at: string;
  is_active: boolean;
}>;

/**
 * A row from the typegraph_node_embeddings table.
 */
export type EmbeddingRow = Readonly<{
  graph_id: string;
  node_kind: string;
  node_id: string;
  field_path: string;
  embedding: readonly number[];
  dimensions: number;
  created_at: string;
  updated_at: string;
}>;

// ============================================================
// Insert Parameters
// ============================================================

/**
 * Parameters for inserting a node.
 */
export type InsertNodeParams = Readonly<{
  graphId: string;
  kind: string;
  id: string;
  props: Record<string, unknown>;
  validFrom?: string;
  validTo?: string;
}>;

/**
 * Parameters for updating a node.
 */
export type UpdateNodeParams = Readonly<{
  graphId: string;
  kind: string;
  id: string;
  props: Record<string, unknown>;
  validTo?: string;
  incrementVersion?: boolean;
  /** If true, clears deleted_at (un-deletes the node). Used by upsert. */
  clearDeleted?: boolean;
}>;

/**
 * Parameters for deleting a node (soft delete).
 */
export type DeleteNodeParams = Readonly<{
  graphId: string;
  kind: string;
  id: string;
}>;

/**
 * Parameters for inserting an edge.
 */
export type InsertEdgeParams = Readonly<{
  graphId: string;
  id: string;
  kind: string;
  fromKind: string;
  fromId: string;
  toKind: string;
  toId: string;
  props: Record<string, unknown>;
  validFrom?: string;
  validTo?: string;
}>;

/**
 * Parameters for updating an edge.
 */
export type UpdateEdgeParams = Readonly<{
  graphId: string;
  id: string;
  props: Record<string, unknown>;
  validTo?: string;
  clearDeleted?: boolean;
}>;

/**
 * Parameters for deleting an edge (soft delete).
 */
export type DeleteEdgeParams = Readonly<{
  graphId: string;
  id: string;
}>;

/**
 * Parameters for hard deleting a node (permanent removal).
 */
export type HardDeleteNodeParams = Readonly<{
  graphId: string;
  kind: string;
  id: string;
}>;

/**
 * Parameters for hard deleting an edge (permanent removal).
 */
export type HardDeleteEdgeParams = Readonly<{
  graphId: string;
  id: string;
}>;

// ============================================================
// Embedding Parameters
// ============================================================

/**
 * Parameters for inserting or updating an embedding.
 */
export type UpsertEmbeddingParams = Readonly<{
  graphId: string;
  nodeKind: string;
  nodeId: string;
  fieldPath: string;
  embedding: readonly number[];
  dimensions: number;
}>;

/**
 * Parameters for deleting an embedding.
 */
export type DeleteEmbeddingParams = Readonly<{
  graphId: string;
  nodeKind: string;
  nodeId: string;
  fieldPath: string;
}>;

/**
 * Parameters for vector similarity search.
 */
export type VectorSearchParams = Readonly<{
  graphId: string;
  nodeKind: string;
  fieldPath: string;
  queryEmbedding: readonly number[];
  metric: VectorMetric;
  limit: number;
  minScore?: number;
}>;

/**
 * Result from a vector similarity search.
 */
export type VectorSearchResult = Readonly<{
  nodeId: string;
  /**
   * Cosine metric returns similarity score (higher is better).
   * L2 and inner_product return raw distance (lower is better).
   */
  score: number;
}>;

/**
 * Parameters for creating a vector index.
 */
export type CreateVectorIndexParams = Readonly<{
  graphId: string;
  nodeKind: string;
  fieldPath: string;
  dimensions: number;
  metric: VectorMetric;
  indexType: VectorIndexType;
  /** Index-specific parameters */
  indexParams?: Readonly<{
    /** HNSW: max connections per layer */
    m?: number;
    /** HNSW: construction search depth */
    efConstruction?: number;
    /** IVFFlat: number of lists */
    lists?: number;
  }>;
}>;

/**
 * Parameters for dropping a vector index.
 */
export type DropVectorIndexParams = Readonly<{
  graphId: string;
  nodeKind: string;
  fieldPath: string;
}>;

// ============================================================
// Query Types
// ============================================================

/**
 * Transaction options.
 */
export type TransactionOptions = Readonly<{
  /** Transaction isolation level (if supported) */
  isolationLevel?:
    | "read_uncommitted"
    | "read_committed"
    | "repeatable_read"
    | "serializable";
}>;

// ============================================================
// Backend Interface
// ============================================================

/**
 * Transaction backend - a backend scoped to a transaction.
 */
export type TransactionBackend = Omit<GraphBackend, "transaction" | "close">;

/**
 * The GraphBackend interface abstracts database operations.
 *
 * Implementations should provide:
 * - SQLite backend via better-sqlite3 or libsql
 * - PostgreSQL backend via pg or postgres
 */
export type GraphBackend = Readonly<{
  /** The SQL dialect */
  dialect: SqlDialect;
  /** Backend capabilities */
  capabilities: BackendCapabilities;
  /** Table names used by this backend (for query schema auto-derivation) */
  tableNames?: SqlTableNames | undefined;

  // === Node Operations ===
  insertNode: (params: InsertNodeParams) => Promise<NodeRow>;
  insertNodeNoReturn?: (params: InsertNodeParams) => Promise<void>;
  insertNodesBatch?: (params: readonly InsertNodeParams[]) => Promise<void>;
  insertNodesBatchReturning?: (
    params: readonly InsertNodeParams[],
  ) => Promise<readonly NodeRow[]>;
  updateNode: (params: UpdateNodeParams) => Promise<NodeRow>;
  deleteNode: (params: DeleteNodeParams) => Promise<void>;
  hardDeleteNode: (params: HardDeleteNodeParams) => Promise<void>;
  getNode: (
    graphId: string,
    kind: string,
    id: string,
  ) => Promise<NodeRow | undefined>;
  getNodes?: (
    graphId: string,
    kind: string,
    ids: readonly string[],
  ) => Promise<readonly NodeRow[]>;

  // === Edge Operations ===
  insertEdge: (params: InsertEdgeParams) => Promise<EdgeRow>;
  insertEdgeNoReturn?: (params: InsertEdgeParams) => Promise<void>;
  insertEdgesBatch?: (params: readonly InsertEdgeParams[]) => Promise<void>;
  insertEdgesBatchReturning?: (
    params: readonly InsertEdgeParams[],
  ) => Promise<readonly EdgeRow[]>;
  updateEdge: (params: UpdateEdgeParams) => Promise<EdgeRow>;
  deleteEdge: (params: DeleteEdgeParams) => Promise<void>;
  hardDeleteEdge: (params: HardDeleteEdgeParams) => Promise<void>;
  getEdge: (graphId: string, id: string) => Promise<EdgeRow | undefined>;
  getEdges?: (
    graphId: string,
    ids: readonly string[],
  ) => Promise<readonly EdgeRow[]>;

  // === Edge Cardinality Operations ===
  countEdgesFrom: (params: CountEdgesFromParams) => Promise<number>;
  edgeExistsBetween: (params: EdgeExistsBetweenParams) => Promise<boolean>;

  // === Edge Query Operations ===
  findEdgesConnectedTo: (
    params: FindEdgesConnectedToParams,
  ) => Promise<readonly EdgeRow[]>;

  // === Collection Query Operations ===
  findNodesByKind: (
    params: FindNodesByKindParams,
  ) => Promise<readonly NodeRow[]>;
  countNodesByKind: (params: CountNodesByKindParams) => Promise<number>;
  findEdgesByKind: (
    params: FindEdgesByKindParams,
  ) => Promise<readonly EdgeRow[]>;
  countEdgesByKind: (params: CountEdgesByKindParams) => Promise<number>;

  // === Unique Constraint Operations ===
  insertUnique: (params: InsertUniqueParams) => Promise<void>;
  deleteUnique: (params: DeleteUniqueParams) => Promise<void>;
  checkUnique: (params: CheckUniqueParams) => Promise<UniqueRow | undefined>;
  checkUniqueBatch?: (
    params: CheckUniqueBatchParams,
  ) => Promise<readonly UniqueRow[]>;

  // === Schema Operations ===
  getActiveSchema: (graphId: string) => Promise<SchemaVersionRow | undefined>;
  getSchemaVersion: (
    graphId: string,
    version: number,
  ) => Promise<SchemaVersionRow | undefined>;
  insertSchema: (params: InsertSchemaParams) => Promise<SchemaVersionRow>;
  setActiveSchema: (graphId: string, version: number) => Promise<void>;

  // === Embedding Operations (optional - depends on vector capabilities) ===
  upsertEmbedding?: (params: UpsertEmbeddingParams) => Promise<void>;
  deleteEmbedding?: (params: DeleteEmbeddingParams) => Promise<void>;
  getEmbedding?: (
    graphId: string,
    nodeKind: string,
    nodeId: string,
    fieldPath: string,
  ) => Promise<EmbeddingRow | undefined>;
  vectorSearch?: (
    params: VectorSearchParams,
  ) => Promise<readonly VectorSearchResult[]>;
  createVectorIndex?: (params: CreateVectorIndexParams) => Promise<void>;
  dropVectorIndex?: (params: DropVectorIndexParams) => Promise<void>;

  // === Query Execution ===
  execute: <T>(query: SQL) => Promise<readonly T[]>;

  /** Execute pre-compiled SQL text with bound parameters. Available on sync SQLite and pg backends. */
  executeRaw?: <T>(
    sqlText: string,
    params: readonly unknown[],
  ) => Promise<readonly T[]>;

  /** Compile a Drizzle SQL object to { sql, params } without executing. */
  compileSql?: (
    query: SQL,
  ) => Readonly<{ sql: string; params: readonly unknown[] }>;

  // === Transaction ===
  transaction: <T>(
    fn: (tx: TransactionBackend) => Promise<T>,
    options?: TransactionOptions,
  ) => Promise<T>;

  // === Lifecycle ===
  close: () => Promise<void>;
}>;

// ============================================================
// Additional Parameter Types
// ============================================================

/**
 * Parameters for inserting a unique constraint entry.
 */
export type InsertUniqueParams = Readonly<{
  graphId: string;
  nodeKind: string;
  constraintName: string;
  key: string;
  nodeId: string;
  concreteKind: string;
}>;

/**
 * Parameters for deleting a unique constraint entry.
 */
export type DeleteUniqueParams = Readonly<{
  graphId: string;
  nodeKind: string;
  constraintName: string;
  key: string;
}>;

/**
 * Parameters for checking a unique constraint.
 */
export type CheckUniqueParams = Readonly<{
  graphId: string;
  nodeKind: string;
  constraintName: string;
  key: string;
  /** If true, also returns soft-deleted entries. Used by get-or-create operations. */
  includeDeleted?: boolean;
}>;

/**
 * Parameters for batch-checking unique constraints.
 */
export type CheckUniqueBatchParams = Readonly<{
  graphId: string;
  nodeKind: string;
  constraintName: string;
  keys: readonly string[];
  /** If true, also returns soft-deleted entries. Used by get-or-create operations. */
  includeDeleted?: boolean;
}>;

/**
 * Parameters for inserting a schema version.
 */
export type InsertSchemaParams = Readonly<{
  graphId: string;
  version: number;
  schemaHash: string;
  schemaDoc: SerializedSchema;
  isActive: boolean;
}>;

/**
 * Parameters for counting edges from a source node.
 */
export type CountEdgesFromParams = Readonly<{
  graphId: string;
  edgeKind: string;
  fromKind: string;
  fromId: string;
  /** If true, only count edges where valid_to IS NULL */
  activeOnly?: boolean;
}>;

/**
 * Parameters for checking if an edge exists between two nodes.
 */
export type EdgeExistsBetweenParams = Readonly<{
  graphId: string;
  edgeKind: string;
  fromKind: string;
  fromId: string;
  toKind: string;
  toId: string;
}>;

/**
 * Parameters for finding edges connected to a node.
 */
export type FindEdgesConnectedToParams = Readonly<{
  graphId: string;
  nodeKind: string;
  nodeId: string;
}>;

/**
 * Parameters for finding nodes by kind.
 */
export type FindNodesByKindParams = Readonly<{
  graphId: string;
  kind: string;
  limit?: number;
  offset?: number;
  /** If true, exclude deleted nodes. Default true. */
  excludeDeleted?: boolean;
  /** Temporal mode for filtering by validity period. */
  temporalMode?: TemporalMode;
  /** Timestamp for "current" and "asOf" temporal modes. */
  asOf?: string;
}>;

/**
 * Parameters for counting nodes by kind.
 */
export type CountNodesByKindParams = Readonly<{
  graphId: string;
  kind: string;
  /** If true, exclude deleted nodes. Default true. */
  excludeDeleted?: boolean;
  /** Temporal mode for filtering by validity period. */
  temporalMode?: TemporalMode;
  /** Timestamp for "current" and "asOf" temporal modes. */
  asOf?: string;
}>;

/**
 * Parameters for finding edges by kind.
 */
export type FindEdgesByKindParams = Readonly<{
  graphId: string;
  kind: string;
  fromKind?: string;
  fromId?: string;
  toKind?: string;
  toId?: string;
  limit?: number;
  offset?: number;
  /** If true, exclude deleted edges. Default true. */
  excludeDeleted?: boolean;
  /** Temporal mode for filtering by validity period. */
  temporalMode?: TemporalMode;
  /** Timestamp for "current" and "asOf" temporal modes. */
  asOf?: string;
}>;

/**
 * Parameters for counting edges by kind.
 */
export type CountEdgesByKindParams = Readonly<{
  graphId: string;
  kind: string;
  fromKind?: string;
  fromId?: string;
  toKind?: string;
  toId?: string;
  /** If true, exclude deleted edges. Default true. */
  excludeDeleted?: boolean;
  /** Temporal mode for filtering by validity period. */
  temporalMode?: TemporalMode;
  /** Timestamp for "current" and "asOf" temporal modes. */
  asOf?: string;
}>;

// ============================================================
// Default Capabilities
// ============================================================

/**
 * Default capabilities for SQLite.
 */
export const SQLITE_CAPABILITIES: BackendCapabilities = {
  jsonb: false, // SQLite uses TEXT with json functions
  partialIndexes: true, // SQLite supports WHERE in CREATE INDEX
  ginIndexes: false, // SQLite doesn't have GIN
  cte: true, // SQLite supports WITH
  returning: true, // SQLite 3.35+ supports RETURNING
  transactions: true, // SQLite supports transactions
};

/**
 * Default capabilities for PostgreSQL.
 */
export const POSTGRES_CAPABILITIES: BackendCapabilities = {
  jsonb: true, // PostgreSQL has native JSONB
  partialIndexes: true,
  ginIndexes: true,
  cte: true,
  returning: true,
  transactions: true, // PostgreSQL supports transactions
};

/**
 * Capabilities for Cloudflare D1.
 * D1 does NOT support atomic transactions - operations are auto-committed.
 */
export const D1_CAPABILITIES: BackendCapabilities = {
  jsonb: false, // D1 uses TEXT with json functions
  partialIndexes: true,
  ginIndexes: false,
  cte: true,
  returning: true,
  transactions: false, // D1 does NOT support atomic transactions
};
