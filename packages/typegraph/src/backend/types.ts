/**
 * Backend interface types for TypeGraph storage.
 *
 * The backend abstracts database operations, allowing different
 * SQL implementations (SQLite, PostgreSQL) behind a common interface.
 */
import { type SQL } from "drizzle-orm";

import {
  type IndexEntity,
  type KindEntity,
  type TemporalMode,
} from "../core/types";
import { type SqlTableNames } from "../query/compiler/schema";
import { type FulltextStrategy } from "../query/dialect/fulltext-strategy";
import { type VectorStrategy } from "../query/dialect/vector-strategy";
import { type SerializedSchema } from "../schema/types";
import {
  type AnyPgDatabase,
  type AnySqliteDatabase,
} from "./drizzle/execution";

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
  /** Whether the backend supports atomic transactions (D1 does not) */
  transactions: boolean;
  /** Whether the backend supports SQL window functions such as ROW_NUMBER() */
  windowFunctions: boolean;
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
 *
 * `dimensions`, `metric`, and `indexType` together resolve the slot's
 * typed per-`(nodeKind, fieldPath)` storage (the strategy needs the fixed
 * dimension for the column type, and the metric/index type to address the
 * right ANN structure). The store populates them from the schema's
 * `embedding()` declaration via `getEmbeddingDimensions()` /
 * `getEmbeddingIndex()`; the backend constructs a `VectorSlot` from them
 * and stays graph-agnostic.
 */
export type UpsertEmbeddingParams = Readonly<{
  graphId: string;
  nodeKind: string;
  nodeId: string;
  fieldPath: string;
  embedding: readonly number[];
  dimensions: number;
  metric: VectorMetric;
  indexType: VectorIndexType;
}>;

/**
 * Parameters for deleting an embedding.
 *
 * `dimensions` / `metric` / `indexType` mirror {@link UpsertEmbeddingParams}
 * so the backend can resolve the slot's typed per-`(nodeKind, fieldPath)`
 * storage and idempotently ensure it exists before the DELETE. That
 * matters because a delete can run before any embedding was ever written
 * (e.g. a node hard-deleted having never carried one), and on Postgres a
 * DELETE against a missing relation inside a transaction aborts the whole
 * transaction. The store populates them from the schema's `embedding()`
 * declaration, exactly as for upserts.
 */
export type DeleteEmbeddingParams = Readonly<{
  graphId: string;
  nodeKind: string;
  nodeId: string;
  fieldPath: string;
  dimensions: number;
  metric: VectorMetric;
  indexType: VectorIndexType;
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
  /**
   * Fixed vector dimension `N` for the searched `(nodeKind, fieldPath)`
   * slot. The store populates it from the schema's `embedding()`
   * declaration via `getEmbeddingDimensions()`; the backend uses it to
   * construct the `VectorSlot` whose typed storage the strategy scans.
   */
  dimensions: number;
  /**
   * Index type materialized for this slot. `"none"` means brute-force
   * only; otherwise the strategy may route through its ANN structure.
   * The store populates it from `getEmbeddingIndex()`.
   */
  indexType: VectorIndexType;
  limit: number;
  minScore?: number;
  /**
   * HNSW search frontier for this query (pgvector `hnsw.ef_search`).
   * Sizes the dynamic candidate list the index scan maintains: higher
   * trades latency for recall. The floor for the over-fetch to fill its
   * candidate set is `efSearch >= limit`; ~2–4× is the high-recall
   * target. Applied transaction-locally (`SET LOCAL`) on the Postgres
   * HNSW path only. No-op on backends without an HNSW frontier knob
   * (sqlite-vec) and ignored — with a one-time warning — on Postgres
   * backends without transactions (e.g. `drizzle-orm/neon-http`).
   */
  efSearch?: number;
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
  /**
   * Build the index without taking an `AccessExclusiveLock` on live
   * tables (Postgres `CREATE INDEX CONCURRENTLY`). Mirrors the
   * `concurrent` flag the relational DDL path uses inside
   * `materializeIndexes()`. Cannot be set inside a transaction —
   * callers (`materializeIndexes()`) run at top level. Backends that
   * don't have a CONCURRENTLY equivalent (SQLite) ignore this flag.
   */
  concurrent?: boolean;
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
 *
 * Note: `createFulltextIndex` / `dropFulltextIndex` were removed as
 * dead code in #PR_E. The fulltext table's canonical index (Postgres
 * GIN on `tsv`, SQLite FTS5 virtual table) is created with the table
 * itself by `bootstrapTables` per the active `FulltextStrategy`;
 * per-kind fulltext indexes are an "advanced strategy" surface that
 * doesn't fit the relational-style declaration model and is reserved
 * for future work.
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

// ============================================================
// Index Materialization Status
// ============================================================

/**
 * Per-deployment record for a single declared index.
 *
 * Identified by `indexName` because SQL index names are physical,
 * database-global identifiers — `graphId` is provenance, not identity.
 * `materializedAt` is null until the first successful CREATE INDEX
 * completes; `lastAttemptedAt` is always set, even on failure.
 */
export type IndexMaterializationRow = Readonly<{
  indexName: string;
  graphId: string;
  entity: IndexEntity;
  kind: string;
  signature: string;
  schemaVersion: number;
  materializedAt: string | undefined;
  lastAttemptedAt: string;
  lastError: string | undefined;
}>;

/**
 * Parameters for upserting a materialization attempt.
 *
 * On success: pass `materializedAt` (ISO timestamp) and undefined `error`.
 * On failure: pass undefined `materializedAt` (preserve any existing
 * timestamp from a prior success) and the error message.
 */
export type RecordIndexMaterializationParams = Readonly<{
  indexName: string;
  graphId: string;
  entity: IndexEntity;
  kind: string;
  signature: string;
  schemaVersion: number;
  attemptedAt: string;
  /** ISO timestamp on success; undefined on failure (preserves existing). */
  materializedAt: string | undefined;
  /** Error message on failure; undefined on success (clears existing). */
  error: string | undefined;
}>;

// ============================================================
// Contribution Materializations (#135 — durable strategy-owned
// storage marker, sibling of index materializations)
// ============================================================

/**
 * Durable identity of a strategy-owned table contribution (#129),
 * scoped to a graph. This is the primary key of
 * `typegraph_contribution_materializations`.
 *
 * `logicalName` is the stable slot ("fulltext"); `owner` is the
 * producing strategy ("tsvector" / "fts5"); `tableName` is the resolved
 * physical name (custom per-deployment names must be distinguishable).
 * `graphId` is part of identity here — unlike the index status table
 * where the physical index name is database-global, two graphs can each
 * own a logically-identical fulltext contribution.
 */
export type ContributionMaterializationIdentity = Readonly<{
  graphId: string;
  logicalName: string;
  owner: string;
  tableName: string;
}>;

/**
 * Per-deployment record that a strategy-owned contribution has been
 * durably materialized against this database.
 *
 * `signature` is intentionally NOT part of the identity: a row with the
 * same identity but a different signature means "materialized artifact
 * is stale/drifted" — a loud error on the hot path, never a silent
 * re-materialize. `materializedAt` is undefined until the first
 * successful materialization; `lastAttemptedAt` is always set.
 */
export type ContributionMaterializationRow = Readonly<{
  graphId: string;
  logicalName: string;
  owner: string;
  tableName: string;
  signature: string;
  materializedAt: string | undefined;
  lastAttemptedAt: string;
  lastError: string | undefined;
}>;

/**
 * Parameters for upserting a contribution-materialization attempt.
 * Same success/failure contract as
 * {@link RecordIndexMaterializationParams}: on failure pass undefined
 * `materializedAt` so a prior successful timestamp is preserved via
 * COALESCE, and the error message.
 */
export type RecordContributionMaterializationParams = Readonly<{
  graphId: string;
  logicalName: string;
  owner: string;
  tableName: string;
  signature: string;
  attemptedAt: string;
  /** ISO timestamp on success; undefined on failure (preserves existing). */
  materializedAt: string | undefined;
  /** Error message on failure; undefined on success (clears existing). */
  error: string | undefined;
}>;

// ============================================================
// Kind Removals (data-cleanup status)
// ============================================================

/**
 * One row of the per-deployment `typegraph_kind_removals` table:
 * a graph-extension kind that has been removed from the schema and whose
 * data may or may not have been cleaned up yet.
 */
export type KindRemovalRow = Readonly<{
  graphId: string;
  kindName: string;
  entity: KindEntity;
  schemaVersion: number;
  /** ISO timestamp when the data-cleanup pass succeeded; undefined while pending. */
  removedAt: string | undefined;
  lastAttemptedAt: string;
  lastError: string | undefined;
}>;

/**
 * Upsert payload for a kind-removal status row. On removal-commit:
 * pass `removedAt: undefined` (the pending state). On successful
 * data-cleanup: pass `removedAt` set and `error: undefined`. On
 * cleanup failure: pass `removedAt: undefined` (preserves any prior
 * timestamp from a partial success on a different replica) and the
 * error message.
 */
export type RecordKindRemovalParams = Readonly<{
  graphId: string;
  kindName: string;
  entity: KindEntity;
  schemaVersion: number;
  attemptedAt: string;
  /** ISO timestamp on success; undefined while pending or on failure. */
  removedAt: string | undefined;
  /** Error message on failure; undefined on success or while pending. */
  error: string | undefined;
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

/**
 * A caller-owned, already-open Drizzle transaction handle that a
 * TypeGraph store can adopt so both layers commit/rollback together.
 *
 * The literal client the caller's transaction runs on — a `PgDatabase`
 * transaction (node-postgres / `neon-serverless` Pool) or a
 * `BaseSQLiteDatabase` connection. Async drivers obtain it from
 * `db.transaction(async (tx) => …)`; synchronous `better-sqlite3` (whose
 * driver rejects an `async` transaction callback) passes the connection
 * itself under an explicit `BEGIN`/`COMMIT`/`ROLLBACK`. Passing it to
 * {@link GraphBackend.adoptTransaction} threads that *literal* client
 * through TypeGraph's SQL, so graph writes and the caller's own
 * relational writes share one Postgres/SQLite transaction (#134).
 */
export type AdoptedTransaction = AnyPgDatabase | AnySqliteDatabase;

// ============================================================
// Backend Interface
// ============================================================

/**
 * Transaction backend — a backend scoped to a transaction.
 *
 * `commitSchemaVersion` and `setActiveVersion` are intentionally omitted:
 * the atomicity / CAS guarantees of those primitives depend on
 * dialect-specific write-locking (BEGIN IMMEDIATE on SQLite,
 * `pg_advisory_xact_lock` on Postgres) acquired by the top-level
 * backend wrappers, not the transaction itself. Calling them from a
 * user-supplied `backend.transaction(...)` callback would bypass that
 * locking and silently weaken the orphan-row crash window the primitive
 * exists to eliminate. Schema commits go through the top-level backend
 * methods only.
 */
export type TransactionBackend = Omit<
  GraphBackend,
  | "transaction"
  | "adoptTransaction"
  | "close"
  | "refreshStatistics"
  | "commitSchemaVersion"
  | "setActiveVersion"
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
  /**
   * Optional vector strategy this backend is wired with. The query
   * compiler reads it (via `compileQuery` options) to emit per-`(kind,
   * field)` relevance scans for `field.similarTo(...)` predicates, and
   * the index-materialization / removal paths read its deterministic
   * `tableName(...)` to address the right physical per-field storage.
   * `undefined` when the backend has no vector support (e.g. a generic
   * SQLite backend without sqlite-vec).
   */
  vectorStrategy?: VectorStrategy | undefined;

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
  /**
   * Atomically inserts a new schema version and activates it as a single
   * transactional unit, with optimistic compare-and-swap on the currently
   * active version.
   *
   * - If `expected.kind === "active"` and the actual active version
   *   differs, throws `StaleVersionError` (caller should refetch and
   *   retry).
   * - If a row already exists at `params.version` with the same
   *   `schemaHash`, returns it idempotently — reactivating it if it was
   *   left inactive by an earlier crashed commit.
   * - If a row already exists at `params.version` with a different
   *   `schemaHash`, throws `SchemaContentConflictError`.
   *
   * Requires `capabilities.transactions === true`. On non-transactional
   * backends (e.g. Cloudflare D1, drizzle-orm/neon-http) this method
   * throws `ConfigurationError` rather than running with degraded
   * atomicity that would silently re-introduce the orphan-row crash
   * window the primitive exists to eliminate.
   */
  commitSchemaVersion: (
    params: CommitSchemaVersionParams,
  ) => Promise<SchemaVersionRow>;
  /**
   * Atomically flips the active schema pointer to an existing version,
   * with optimistic compare-and-swap on the currently active version.
   * Used by `rollbackSchema` and any other "promote/demote existing
   * version" workflow. Throws `StaleVersionError` on CAS mismatch and
   * `MigrationError` if the target version row does not exist.
   *
   * Same transactional requirements as `commitSchemaVersion`.
   */
  setActiveVersion: (params: SetActiveVersionParams) => Promise<void>;

  // === Embedding Operations (optional - depends on vector capabilities) ===
  upsertEmbedding?: (params: UpsertEmbeddingParams) => Promise<void>;
  deleteEmbedding?: (params: DeleteEmbeddingParams) => Promise<void>;
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

  // === Index Materialization (used by store.materializeIndexes) ===
  /**
   * Idempotently ensure ONLY the `typegraph_index_materializations`
   * table exists — separate from `bootstrapTables` so that
   * `materializeIndexes` doesn't pull in the full base-table DDL set
   * just to access the status table.
   *
   * Why focused: `bootstrapTables` issues 20+ `CREATE TABLE / CREATE
   * INDEX IF NOT EXISTS` statements covering every base table. Two
   * concurrent calls (e.g. two replicas of the same `schema_doc` both
   * starting up and calling `materializeIndexes`) race on
   * Postgres SHARE locks and DEADLOCK. Restricting the ensure-step to
   * the single status table eliminates the cross-table race entirely
   * — concurrent `CREATE TABLE IF NOT EXISTS` for one specific table
   * is well-behaved on Postgres.
   */
  ensureIndexMaterializationsTable?: () => Promise<void>;

  /**
   * Look up a recorded materialization for a declared index by its
   * physical SQL index name. Returns `undefined` if no row exists.
   */
  getIndexMaterialization?: (
    indexName: string,
  ) => Promise<IndexMaterializationRow | undefined>;
  /**
   * Bulk variant of `getIndexMaterialization`: load every recorded
   * materialization whose `indexName` (status key) is in `statusKeys`,
   * in a single round-trip. Returned rows are unordered — callers index
   * by `indexName`. Optional; consumers fall back to per-key
   * `getIndexMaterialization` when unset.
   */
  getIndexMaterializations?: (
    statusKeys: readonly string[],
  ) => Promise<readonly IndexMaterializationRow[]>;
  /**
   * Upsert a materialization attempt — success or failure. Failure rows
   * preserve any prior `materializedAt` so the historical successful
   * timestamp survives across error windows.
   */
  recordIndexMaterialization?: (
    params: RecordIndexMaterializationParams,
  ) => Promise<void>;

  // === Contribution Materialization (#135 — durable strategy-owned
  // storage marker, sibling of the index status table) ===

  /**
   * Idempotently ensure ONLY the
   * `typegraph_contribution_materializations` table exists. Same
   * focused-bootstrap rationale as `ensureIndexMaterializationsTable`:
   * a single `CREATE TABLE IF NOT EXISTS` is concurrency-safe under
   * replica startup, where the full `bootstrapTables` set risks a
   * Postgres SHARE-lock deadlock.
   */
  ensureContributionMaterializationsTable?: () => Promise<void>;

  /**
   * Look up the durable materialization marker for one strategy-owned
   * contribution identity. Returns `undefined` when no row exists
   * ("never initialized").
   */
  getContributionMaterialization?: (
    identity: ContributionMaterializationIdentity,
  ) => Promise<ContributionMaterializationRow | undefined>;

  /**
   * Upsert a contribution-materialization attempt — success or failure.
   * Failure rows preserve any prior `materializedAt` via COALESCE so a
   * later failed re-attempt doesn't erase the historical success.
   */
  recordContributionMaterialization?: (
    params: RecordContributionMaterializationParams,
  ) => Promise<void>;

  /**
   * Resolve (once per backend instance, cached) and assert the durable
   * materialization markers for every `runtimeEnsure` contribution this
   * backend's strategy declares, for `graphId`. Throws
   * `StoreNotInitializedError` when a marker is missing, stale
   * (signature drift), or recorded a failed last attempt.
   *
   * This is the single read-side gate the fulltext hot-path wrappers
   * and `store.transaction()` consult. It performs ZERO DDL and ZERO
   * marker writes — initialization is the exclusive job of the async
   * boot path (`createStoreWithSchema` → `ensureRuntimeContributions`).
   */
  assertRuntimeContributionsInitialized?: (graphId: string) => Promise<void>;

  // === Kind Removal Status ===

  /**
   * Bootstraps the per-deployment `typegraph_kind_removals` table so
   * `store.removeKinds()` and `store.materializeRemovals()` can persist
   * removal status. Mirrors the focused-bootstrap rationale documented
   * on `ensureIndexMaterializationsTable` — the full `bootstrapTables`
   * touches every base table and risks Postgres SHARE-lock deadlock
   * under concurrent replica startup.
   */
  ensureKindRemovalsTable?: () => Promise<void>;

  /**
   * List graph-extension kind removals whose data-cleanup pass has not yet
   * succeeded for this `graphId`. Returns rows with
   * `removedAt: undefined`. Order is unspecified; callers materialize
   * one-at-a-time and don't depend on it.
   */
  getPendingKindRemovals?: (
    graphId: string,
  ) => Promise<readonly KindRemovalRow[]>;

  /**
   * List ALL kind-removal rows for a `graphId` — pending and completed.
   * Used by `materializeRemovals()` reconciliation to detect rows that
   * are missing entirely (the `removeKinds()` crash window) versus
   * already completed. Without this distinction the reconciler would
   * have to upsert every expected historical removal on every call,
   * churning `last_attempted_at` on rows that long since succeeded.
   * Order is unspecified.
   */
  getAllKindRemovals?: (graphId: string) => Promise<readonly KindRemovalRow[]>;

  /**
   * Upsert a kind-removal status row. `removedAt: undefined` records
   * the pending state at schema-commit time; `removedAt: <iso>`
   * marks the data cleanup successful. The COALESCE rule on `removedAt`
   * mirrors `recordIndexMaterialization` so a later failure doesn't
   * clobber the historical successful timestamp from another replica.
   */
  recordKindRemoval?: (params: RecordKindRemovalParams) => Promise<void>;

  // === Reconciliation Watermark ===

  /**
   * Bootstraps the per-deployment `typegraph_reconciliation_markers`
   * table so `materializeRemovals()` can persist reconciliation
   * progress. Same focused-bootstrap rationale as the other status
   * tables — full `bootstrapTables` risks Postgres SHARE-lock
   * deadlock under concurrent replica startup.
   */
  ensureReconciliationMarkersTable?: () => Promise<void>;

  // === Table Contributions (#129) ===

  /**
   * Materializes every contribution flagged `runtimeEnsure` — the
   * strategy-owned runtime tables (fulltext today) that drizzle-kit-
   * managed setups don't create. Called once after a successful schema
   * load. Deliberately scoped: base/drizzle-visible tables are
   * `runtimeEnsure: false`, so this does not regress startup into
   * broad DDL/probing across every table.
   *
   * The canonical durable-marker writer (#135): for each runtime
   * contribution it short-circuits when the marker already records a
   * matching signature, otherwise runs the idempotent `createDdl` and
   * records the marker (success or failure) keyed by `graphId`.
   */
  ensureRuntimeContributions?: (graphId: string) => Promise<void>;

  /**
   * Bootstraps the fulltext storage table the active `FulltextStrategy`
   * owns. Same focused-bootstrap rationale as the other `ensure*Table`
   * methods: idempotent and concurrency-safe under replica startup.
   *
   * Superseded by `ensureRuntimeContributions()` (#129); retained as
   * a thin back-compat wrapper for backends/callers predating #129. Not
   * machine-`@deprecated` because the manager still calls it as the
   * pre-#129 fallback. #135 removed the remaining hot-path callers and
   * routed this through the durable-marker writer.
   */
  ensureFulltextTable?: (graphId: string) => Promise<void>;

  /**
   * Read the high-water mark schema version for which
   * `materializeRemovals` reconciliation has already verified history
   * for `graphId`. Returns `undefined` when no marker has been
   * recorded yet. Used to skip already-checked transitions in the
   * recovery walk.
   */
  getReconciliationMarker?: (graphId: string) => Promise<number | undefined>;

  /**
   * Persist the reconciliation high-water mark for `graphId`. Called
   * after `materializeRemovals` completes a clean walk; subsequent
   * calls walk only versions newer than this marker. Idempotent
   * upsert by `graphId`.
   */
  setReconciliationMarker?: (graphId: string, version: number) => Promise<void>;

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

  /**
   * Execute a DDL statement that returns no rows (CREATE INDEX,
   * CREATE TABLE, ALTER TABLE, etc.). Separate from `executeRaw`
   * because some drivers (better-sqlite3) require `.run()` for DDL
   * and `.all()` for queries — the ambiguity can't be resolved by
   * inspecting the SQL string portably.
   *
   * Postgres path can use this for `CREATE INDEX CONCURRENTLY`, which
   * cannot run inside a transaction. Implementations must execute the
   * statement outside `transaction(...)`.
   */
  executeDdl?: (ddl: string) => Promise<void>;

  // === Transaction ===
  /**
   * `fn` receives the tx-scoped backend and the raw Drizzle handle
   * **bound to that same transaction** (`AdoptedTransaction`). The
   * store surfaces the second argument as `TransactionContext.sql` so
   * callers can write their own relational tables inside the
   * graph-owned transaction. Implementations MUST pass the *exact*
   * handle the tx-scoped backend writes through (the Postgres/libsql
   * tx handle; for better-sqlite3 / do-sqlite the bound connection),
   * never a fresh one.
   */
  transaction: <T>(
    fn: (tx: TransactionBackend, sql: AdoptedTransaction) => Promise<T>,
    options?: TransactionOptions,
  ) => Promise<T>;

  /**
   * Adopt a caller-owned, already-open transaction (#134).
   *
   * Returns a transaction-scoped backend bound to the *exact*
   * `externalTx` client, reusing this backend's already-resolved
   * schema/strategy config — no `createStoreWithSchema` / `evolve` /
   * `migrateSchema`, and **no DDL inside the caller's business
   * transaction**. The caller owns `BEGIN`/`COMMIT`/`ROLLBACK`; this
   * method neither opens nor closes a transaction. Async drivers
   * (node-postgres, `neon-serverless` Pool, libsql) wrap with
   * `db.transaction(async …)`; synchronous `better-sqlite3` must instead
   * issue explicit `BEGIN`/`COMMIT`/`ROLLBACK` (its driver rejects an
   * `async` transaction callback).
   *
   * Optional and presence-detected like the other capability-scoped
   * members: only the Drizzle Postgres/SQLite backends provide it.
   * Implementations MUST throw (not silently degrade) when
   * `capabilities.transactions` is `false` — a non-atomic fallback is
   * safe for graph-only writes but dangerous for cross-store flows,
   * where the caller's relational write *would* still commit.
   *
   * Fulltext stays safe by construction: the returned backend's
   * fulltext methods assert the durable materialization marker (a
   * cached SELECT, never DDL) at point of use and throw
   * `StoreNotInitializedError` on a missing/stale/failed marker rather
   * than migrating mid-transaction. Prefer booting the parent store via
   * `createStoreWithSchema` so that assertion is a warm-cache no-op.
   */
  adoptTransaction?: (externalTx: AdoptedTransaction) => TransactionBackend;

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
 * — pass the operation-level backend so the no-tx path doesn't loop
 * back through the same toplevel method.
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
 *
 * Used internally by backend implementations. Public callers go through
 * `commitSchemaVersion`, which handles the insert + activate atomically
 * with CAS guarantees.
 */
export type InsertSchemaParams = Readonly<{
  graphId: string;
  version: number;
  schemaHash: string;
  schemaDoc: SerializedSchema;
  isActive: boolean;
}>;

/**
 * The caller's claim about the currently-active schema version, used as
 * the optimistic compare-and-swap guard for `commitSchemaVersion`.
 *
 * - `{ kind: "initial" }` — caller is committing the first-ever version
 *   for this graph and asserts no active version exists yet.
 * - `{ kind: "active", version: N }` — caller observed version N as
 *   active and is committing version N+1 against that baseline. The
 *   commit fails with `StaleVersionError` if some other writer has
 *   advanced or rolled back the pointer in the meantime.
 *
 * Tagged-union form (rather than a magic `version: 0` sentinel) because
 * the two cases have materially different semantics: the initial path
 * skips the "deactivate prior" UPDATE, and the no-active-row state is
 * a *valid* expected state, not an out-of-band signal.
 */
export type CommitSchemaVersionExpected =
  | Readonly<{ kind: "initial" }>
  | Readonly<{ kind: "active"; version: number }>;

/**
 * Parameters for `commitSchemaVersion`.
 */
export type CommitSchemaVersionParams = Readonly<{
  graphId: string;
  /** CAS guard — see `CommitSchemaVersionExpected`. */
  expected: CommitSchemaVersionExpected;
  /** The new version to insert and activate. */
  version: number;
  schemaHash: string;
  schemaDoc: SerializedSchema;
}>;

/**
 * Parameters for `setActiveVersion`.
 *
 * Flips the active pointer from `expected` to `version` for an existing
 * row. CAS prevents overwriting a concurrent rollback or commit.
 */
export type SetActiveVersionParams = Readonly<{
  graphId: string;
  /** CAS guard. Same semantics as `commitSchemaVersion.expected`. */
  expected: CommitSchemaVersionExpected;
  /** The version to mark active. Must already exist. */
  version: number;
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
  /**
   * Stable ordering for keyset pagination. Default: "created_at" (existing
   * behavior). Use "id" for iteration that is stable under shared `created_at`
   * timestamps — the offset path orders by the NON-unique `created_at`, so a
   * full enumeration must page by the unique `id` to avoid skipping a row at a
   * page boundary. Mirrors {@link FindNodesByKindParams.orderBy}.
   */
  orderBy?: "id" | "created_at";
  /**
   * Keyset cursor. Returns rows strictly greater (by `orderBy`) than this value.
   * When `orderBy: "id"`, compared lexicographically. Mutually exclusive with
   * `offset` — callers pick one. Mirrors {@link FindNodesByKindParams.after}.
   */
  after?: string;
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
  transactions: true, // SQLite supports transactions
  windowFunctions: true, // SQLite has supported window functions since 3.25.0
};

/**
 * Default capabilities for PostgreSQL.
 */
export const POSTGRES_CAPABILITIES: BackendCapabilities = {
  transactions: true, // PostgreSQL supports transactions
  windowFunctions: true, // PostgreSQL supports ROW_NUMBER() and related windows
};
