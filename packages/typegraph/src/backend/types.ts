/**
 * Backend interface types for TypeGraph storage.
 *
 * The backend abstracts database operations, allowing different
 * SQL implementations (SQLite, PostgreSQL) behind a common interface.
 */
import { type SQL } from "drizzle-orm";

import { type TemporalMode } from "../core/types";
import { type SqlTableNames } from "../query/compiler/schema";
import { type FulltextStrategy } from "../query/dialect/fulltext-strategy";
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
// Fulltext Search Types
// ============================================================

/**
 * Query modes for fulltext search.
 *
 * - "websearch": Google-style syntax (quoted phrases, +required, -excluded).
 *    Postgres: `websearch_to_tsquery`. SQLite: translated to FTS5 MATCH.
 * - "phrase": treats the whole query as a phrase.
 *    Postgres: `phraseto_tsquery`. SQLite: FTS5 `"..."` phrase.
 * - "plain": splits on whitespace and ANDs terms.
 *    Postgres: `plainto_tsquery`. SQLite: default FTS5 AND.
 * - "raw": dialect-native syntax passed through unchanged.
 */
export type FulltextQueryMode = "websearch" | "phrase" | "plain" | "raw";

/**
 * Fulltext search capabilities declared by a backend.
 */
export type FulltextCapabilities = Readonly<{
  /** Whether the backend supports fulltext operations */
  supported: boolean;
  /**
   * Language / tokenizer names understood by this backend.
   * Postgres: installed regconfigs (english, simple, ...).
   * SQLite FTS5: tokenizer names (unicode61, porter, trigram).
   */
  languages: readonly string[];
  /** Whether phrase queries are supported. */
  phraseQueries: boolean;
  /** Whether prefix (`foo*`) queries are supported. */
  prefixQueries: boolean;
  /** Whether highlighting / snippets are supported. */
  highlighting: boolean;
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
  /** Fulltext search capabilities (undefined if not configured) */
  fulltext?: FulltextCapabilities | undefined;
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
  props: Readonly<Record<string, unknown>>;
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
  props: Readonly<Record<string, unknown>>;
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
  props: Readonly<Record<string, unknown>>;
  validFrom?: string;
  validTo?: string;
}>;

/**
 * Parameters for updating an edge.
 */
export type UpdateEdgeParams = Readonly<{
  graphId: string;
  id: string;
  props: Readonly<Record<string, unknown>>;
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
// Fulltext Parameters
// ============================================================

/**
 * Parameters for inserting or updating a fulltext entry.
 *
 * One row per node. Callers concatenate the searchable fields into
 * `content` so a single MATCH query can find terms spread across fields.
 */
export type UpsertFulltextParams = Readonly<{
  graphId: string;
  nodeKind: string;
  nodeId: string;
  content: string;
  language: string;
}>;

/**
 * Parameters for deleting a single fulltext entry.
 */
export type DeleteFulltextParams = Readonly<{
  graphId: string;
  nodeKind: string;
  nodeId: string;
}>;

/**
 * A single row in a fulltext batch upsert.
 */
export type FulltextBatchRow = Readonly<{
  nodeId: string;
  content: string;
  language: string;
}>;

/**
 * Parameters for a batched fulltext upsert.
 *
 * Homogeneous: one graph, one node kind, many nodes. Duplicate `nodeId`
 * values within a single batch are deduplicated last-write-wins by the
 * builders before SQL generation — Postgres `ON CONFLICT` errors on
 * repeated conflict keys in one statement, and SQLite `DELETE + INSERT`
 * would create duplicate virtual-table rows otherwise.
 */
export type UpsertFulltextBatchParams = Readonly<{
  graphId: string;
  nodeKind: string;
  rows: readonly FulltextBatchRow[];
}>;

/**
 * Parameters for a batched fulltext delete.
 */
export type DeleteFulltextBatchParams = Readonly<{
  graphId: string;
  nodeKind: string;
  nodeIds: readonly string[];
}>;

/**
 * Parameters for fulltext search.
 */
export type FulltextSearchParams = Readonly<{
  graphId: string;
  nodeKind: string;
  /** The user-supplied query string. */
  query: string;
  /** How to parse `query`. Default: "websearch". */
  mode?: FulltextQueryMode;
  /**
   * Language override. Default: per-row language (as stored at insert time).
   * Postgres: passed as the regconfig to `to_tsquery` / `websearch_to_tsquery`.
   * SQLite: informational only (FTS5 tokenizer is fixed at table-create time).
   */
  language?: string;
  /** Max rows to return. */
  limit: number;
  /** Minimum rank to include (backend-dependent units). */
  minScore?: number;
  /** Whether to return a highlighted snippet per match. */
  includeSnippets?: boolean;
}>;

/**
 * Result from a fulltext search.
 *
 * Score semantics differ by backend; prefer `rank` (1-based) when fusing
 * with another source via RRF.
 */
export type FulltextSearchResult = Readonly<{
  nodeId: string;
  /**
   * Backend-native relevance score.
   * Postgres: `ts_rank_cd` (higher is better).
   * SQLite FTS5: negated `bm25()` (higher is better; FTS5 returns lower-is-better).
   */
  score: number;
  /** 1-based rank within the result set, suitable for RRF. */
  rank: number;
  /** Highlighted snippet of the content (if `includeSnippets` was set). */
  snippet?: string;
}>;

/**
 * Parameters for creating a fulltext index.
 *
 * The canonical index (Postgres GIN on `tsv`, SQLite FTS5 virtual table)
 * is created when the fulltext table itself is created. This is reserved
 * for advanced per-kind specializations.
 */
type CreateFulltextIndexParams = Readonly<{
  graphId: string;
  nodeKind: string;
  language: string;
}>;

/**
 * Parameters for dropping a fulltext index created via createFulltextIndex.
 */
type DropFulltextIndexParams = Readonly<{
  graphId: string;
  nodeKind: string;
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
export type TransactionBackend = Omit<
  GraphBackend,
  "transaction" | "close" | "refreshStatistics"
>;

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
  /**
   * Optional fulltext strategy override. When present, both the compiler
   * (for `$fulltext.matches()` in query builder) and backend-direct
   * search paths use this instead of the dialect's default strategy —
   * allowing a Postgres backend to ship pg_trgm, ParadeDB, pgroonga etc.
   * When absent, the dialect's default strategy is used.
   */
  fulltextStrategy?: FulltextStrategy | undefined;

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

  // === Fulltext Operations (optional - depends on fulltext capabilities) ===
  upsertFulltext?: (params: UpsertFulltextParams) => Promise<void>;
  deleteFulltext?: (params: DeleteFulltextParams) => Promise<void>;
  /**
   * Batched variant of `upsertFulltext`. Optional — callers fall back to
   * per-row `upsertFulltext` when unset.
   */
  upsertFulltextBatch?: (params: UpsertFulltextBatchParams) => Promise<void>;
  /**
   * Batched variant of `deleteFulltext`. Optional — callers fall back to
   * per-row `deleteFulltext` when unset.
   */
  deleteFulltextBatch?: (params: DeleteFulltextBatchParams) => Promise<void>;
  fulltextSearch?: (
    params: FulltextSearchParams,
  ) => Promise<readonly FulltextSearchResult[]>;
  createFulltextIndex?: (params: CreateFulltextIndexParams) => Promise<void>;
  dropFulltextIndex?: (params: DropFulltextIndexParams) => Promise<void>;

  // === Graph Lifecycle ===
  /**
   * Hard-deletes all data for a graph (nodes, edges, uniques, embeddings, schema versions).
   * Intended for import-replacement workflows. No hooks, no per-row logic.
   */
  clearGraph: (graphId: string) => Promise<void>;

  /**
   * Creates the base TypeGraph tables if they don't already exist.
   *
   * Called automatically by `createStoreWithSchema()` when a fresh database
   * is detected. Users who manage DDL themselves via `createStore()` never
   * hit this path.
   */
  bootstrapTables?: () => Promise<void>;

  /**
   * Refreshes the backend's query-planner statistics.
   *
   * Call this once after a large initial import or bulk backfill. Without
   * up-to-date statistics, the planner can pick suboptimal execution plans
   * — on PostgreSQL this is the difference between a 0.5ms and a 5ms
   * forward traversal; on SQLite it's the difference between 0.9ms and
   * 23ms fulltext search. Autovacuum / background statistics collection
   * will catch up eventually, but calling this explicitly after a bulk
   * load gives you correct latencies immediately.
   *
   * Implementations:
   * - SQLite runs `ANALYZE`, which populates `sqlite_stat1`
   * - PostgreSQL runs `ANALYZE` on the TypeGraph-managed tables
   *
   * Safe to call at any time; costs a few tens of milliseconds on the
   * sizes this library is designed for.
   */
  refreshStatistics: () => Promise<void>;

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
// Managed Backend Helper
// ============================================================

/**
 * Wraps a GraphBackend with idempotent close that also runs a teardown
 * callback (e.g. closing the underlying database connection).
 */
export function wrapWithManagedClose(
  backend: GraphBackend,
  teardown: () => void | Promise<void>,
): GraphBackend {
  let isClosed = false;
  return {
    ...backend,
    async close(): Promise<void> {
      if (isClosed) return;
      isClosed = true;
      await backend.close();
      await teardown();
    },
  };
}

/**
 * Runs `fn` inside a transaction when the backend supports one, falling
 * through to a direct invocation otherwise. Lets call sites benefit from
 * atomicity on backends that have transactions while staying functional
 * on backends that don't (Cloudflare D1, `drizzle-orm/neon-http` over
 * HTTP). The single-statement race window is already implicit on any
 * backend that reports `transactions: false`; callers that cannot
 * tolerate it must branch on the capability themselves.
 *
 * Pass `fallback` only when the toplevel backend method would recurse
 * — for example, when implementing `backend.setActiveSchema` itself,
 * pass the operation-level backend so the no-tx path doesn't loop.
 */
export async function runOptionallyInTransaction<T>(
  backend: GraphBackend,
  fn: (target: GraphBackend | TransactionBackend) => Promise<T>,
  fallback?: GraphBackend | TransactionBackend,
): Promise<T> {
  if (!backend.capabilities.transactions) {
    return fn(fallback ?? backend);
  }
  return backend.transaction((tx) => fn(tx));
}

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
  /** Max rows to return. */
  limit?: number;
  /** Offset. Present for backward compat; rebuild uses `after` instead. */
  offset?: number;
  /** If true, exclude deleted nodes. Default true. */
  excludeDeleted?: boolean;
  /** Temporal mode for filtering by validity period. */
  temporalMode?: TemporalMode;
  /** Timestamp for "current" and "asOf" temporal modes. */
  asOf?: string;
  /**
   * Stable ordering for keyset pagination. Default: "created_at" (existing
   * behavior). Rebuild should use "id" for iteration that is stable under
   * concurrent writes and shared timestamps.
   */
  orderBy?: "id" | "created_at";
  /**
   * Keyset cursor. Returns rows strictly greater (by `orderBy`) than this
   * value. When `orderBy: "id"`, compared lexicographically. Mutually
   * exclusive with `offset` — callers pick one.
   */
  after?: string;
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
