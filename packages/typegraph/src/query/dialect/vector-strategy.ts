/**
 * Vector Strategy — pluggable storage + SQL generation for a backend's
 * vector stack. The sibling of {@link FulltextStrategy}: a strategy owns
 * every statement that touches its embedding storage — the per-field DDL,
 * upsert, delete, similarity search, and (optional) ANN index lifecycle —
 * plus the capability advertisement and the distance/score expressions the
 * query compiler splices into its relevance CTE.
 *
 * ## Why a strategy, and why per-(kind, field) storage
 *
 * The spike behind #157 established that "real" ANN on every engine we
 * support converges on a
 * **typed, fixed-dimension structure per `(nodeKind, fieldPath)`**:
 *
 * - pgvector: a `vector(N)` column + HNSW/IVFFlat;
 * - libSQL native: an `F32_BLOB(N)` column + `libsql_vector_idx` +
 *   `vector_top_k` (a plain `BLOB` or dimensionless `F32_BLOB` is rejected
 *   by the index — the dimension must live in the column type);
 * - sqlite-vec: a `vec0(embedding float[N])` virtual table.
 *
 * The legacy single shared `typegraph_node_embeddings` table (one generic
 * column holding mixed-dimension vectors) can only ever be brute-forced;
 * pgvector was the sole engine that hid this, because its index supplies the
 * dimension via a `::vector(N)` cast expression. So storage is the
 * strategy's to own, slot by slot, rather than a fixed global table.
 *
 * Brute force remains a legitimate, capability-advertised mode (libSQL's
 * `vector_distance_cos` over a column with no index, sqlite-vec's
 * `vec_distance_cosine`): a strategy whose `capabilities.indexTypes` is
 * `["none"]` simply never emits an ANN index and `buildSearch` always scans.
 */
import { type SQL, sql } from "drizzle-orm";

import { type StrategyTableContribution } from "../../backend/table-contribution";
import {
  type DeleteEmbeddingParams,
  type UpsertEmbeddingBatchParams,
  type UpsertEmbeddingParams,
  type VectorCapabilities,
  type VectorIndexType,
  type VectorMetric,
  type VectorSearchParams,
} from "../../backend/types";

/**
 * `logicalName` prefix of a strategy-owned vector slot. Each
 * `(nodeKind, fieldPath)` pair fills one logical vector slot; the full
 * logical name is `${VECTOR_CONTRIBUTION_PREFIX}:${nodeKind}.${fieldPath}`,
 * stable across table-name overrides and strategy swaps so #135's durable
 * materialization marker survives both.
 */
export const VECTOR_CONTRIBUTION_PREFIX = "vector";

/**
 * The resolved identity of one embedding field's storage in a graph —
 * everything a strategy needs to DDL, address, and index it.
 *
 * Graph-scoped: each `(graphId, nodeKind, fieldPath)` gets its own physical
 * table. TypeGraph supports many graphs per physical database, and the same
 * `(kind, field)` can carry different embedding dimensions across graphs — a
 * shared per-`(kind, field)` table would collide on the fixed column type
 * (`vector(N)` / `F32_BLOB(N)`). Graph-scoping also makes libSQL's
 * table-global `vector_top_k` per-graph-exact (no cross-graph recall bleed).
 */
export type VectorSlot = Readonly<{
  /** Graph the embedding belongs to — scopes the physical table. */
  graphId: string;
  /** Node kind owning the embedding field (e.g. `"Document"`). */
  nodeKind: string;
  /** Dot-path of the embedding field within the node props (e.g. `"embedding"`). */
  fieldPath: string;
  /** Fixed vector dimension `N` for this field — carried into the column type. */
  dimensions: number;
  /** Distance metric the field's index is built for. */
  metric: VectorMetric;
  /**
   * Index type to materialize. `"none"` means brute-force only (no ANN
   * index emitted); the strategy still stores and searches the field.
   */
  indexType: VectorIndexType;
  /**
   * Optional ANN index tuning carried into the index DDL (pgvector
   * `m`/`ef_construction`/`lists`). Present on the create-index / re-embed
   * paths (resolved from the field's `embedding()` declaration); omitted on
   * the write/search ensure paths, where the strategy falls back to defaults.
   */
  indexParams?: Readonly<{
    m?: number;
    efConstruction?: number;
    lists?: number;
  }>;
}>;

/**
 * Derives the `VectorCapabilities` a backend advertises from its active
 * strategy, so the two never drift (mirrors `buildFulltextCapabilities`).
 * The strategy is the single source of truth; there are no per-call-site
 * `SQLITE_VECTOR_*` constants.
 */
export function buildVectorCapabilities(
  strategy: VectorStrategy,
): VectorCapabilities {
  return strategy.capabilities;
}

/**
 * A pluggable vector implementation. Each strategy is self-contained:
 * given a {@link VectorSlot}, it emits every statement the backend and
 * compiler need — per-field storage DDL, writes, similarity search, ANN
 * index lifecycle — and advertises exactly the metrics and index types it
 * can honor. Adding the Nth backend is one of these objects; no core edits.
 */
export interface VectorStrategy {
  /** Human-readable identifier used in error messages and telemetry. */
  readonly name: string;

  /**
   * The metrics, index types, and dimension ceiling this strategy honors —
   * advertised verbatim as `backend.capabilities.vector`. Asymmetry across
   * engines is legitimate and explicit here (pgvector has `inner_product`;
   * libSQL/sqlite-vec do not), never a silent runtime failure.
   */
  readonly capabilities: VectorCapabilities;

  /**
   * Deterministic physical table (or virtual-table) name backing a field in
   * a graph. The compiler references this to scan the right per-field storage,
   * and the backend uses it to route upserts/deletes. Must be a stable,
   * collision-safe SQL identifier derived from `(graphId, nodeKind, fieldPath)`.
   */
  tableName(graphId: string, nodeKind: string, fieldPath: string): string;

  /**
   * The per-field storage this strategy owns for `slot`, as Drizzle-free
   * `StrategyTableContribution`s (resolved `tableName`, deterministic
   * idempotent `createDdl` for the table **and** its ANN index when the
   * slot's `indexType` warrants one, `runtimeEnsure`). Rides the #129/#135
   * table-contribution + durable-materialization machinery exactly as the
   * FTS5 / tsvector virtual tables do — these are materialized per graph by
   * `materializeIndexes()`, not by global `bootstrapTables`.
   */
  ownedTables(slot: VectorSlot): readonly StrategyTableContribution[];

  /**
   * Emits the statement(s) that upsert a single embedding into the slot's
   * storage. Multiple statements are allowed for engines that cannot upsert
   * a vector in one statement (e.g. a `vec0` virtual table → DELETE+INSERT).
   */
  buildUpsert(
    slot: VectorSlot,
    params: UpsertEmbeddingParams,
    timestamp: string,
  ): readonly SQL[];

  /**
   * Emits the statement(s) that upsert MANY embeddings into the slot's
   * storage in multi-row form. Optional — the backend falls back to one
   * {@link buildUpsert} per row when unset. The backend guarantees the
   * rows carry distinct `nodeId`s and fit the connection's bound-parameter
   * budget (it chunks before calling).
   */
  buildUpsertBatch?(
    slot: VectorSlot,
    params: UpsertEmbeddingBatchParams,
    timestamp: string,
  ): readonly SQL[];

  /** Emits the statement(s) that delete a single embedding from the slot. */
  buildDelete(slot: VectorSlot, params: DeleteEmbeddingParams): readonly SQL[];

  /**
   * Raw DDL statement(s) that drop the slot's entire physical storage
   * (table + ANN index, and any engine-managed shadow tables). Used by the
   * destructive `store.reembedVectorField()` path to recreate a field's
   * storage at a new dimension. Returned as raw strings (like
   * `ownedTables(...).createDdl`) for `backend.executeDdl`; must be idempotent
   * (`IF EXISTS`).
   */
  buildDropStorage(slot: VectorSlot): readonly string[];

  /**
   * Emits the similarity-search query for the `backend.vectorSearch` path,
   * returning rows shaped `{ node_id, score }` ordered best-first. The
   * strategy picks brute-force vs ANN based on whether `slot.indexType`
   * materialized an index — the caller never branches. `score` follows the
   * shared convention (cosine → similarity `1 - distance`; l2 /
   * inner_product → raw distance), so `coerceVectorScore` / fusion stay
   * dialect-neutral.
   *
   * `candidates`, when provided, is a subquery yielding the node ids
   * eligible to appear in results (the backend passes its live-node-ids
   * subquery so top-k is computed over live rows in SQL — see
   * `liveNodeIdsSubquery`). Strategies whose ANN form cannot take the
   * filter directly must over-fetch and post-filter, documenting the
   * recall bound. A custom strategy that ignores the argument keeps the
   * pre-pushdown behavior: tombstoned ids are dropped after top-k during
   * hydration, so results can shrink below `limit` under index drift.
   */
  buildSearch(
    slot: VectorSlot,
    params: VectorSearchParams,
    candidates?: SQL,
  ): SQL;

  /**
   * True when {@link buildSearch} returns EXACT rankings — a brute-force
   * engine form, not an approximate index (sqlite-vec's vec0 KNN scans
   * every row in C). The query compiler then routes the NON-approximate
   * `.similarTo()` branch through `buildSearch` too: same results as the
   * SQL distance scan, at engine speed (measured 489ms -> 113ms at 50k
   * on the SQLite lane). Leave false/absent when the engine form is or
   * can be approximate (pgvector planner rewrites, libSQL DiskANN):
   * exactness of the default path is a semantic guarantee.
   */
  searchIsExact?: boolean;

  /**
   * The distance expression over the slot's embedding column, used by the
   * **query compiler** to splice vector relevance into its CTE. This is the
   * one genuinely engine-specific fragment (`vec_distance_cosine` vs
   * `<=>` vs `vector_distance_cos`); the surrounding score / minScore /
   * ORDER BY math is shared (see {@link vectorScoreExpression} etc.).
   *
   * `embeddingColumn` is the already-qualified column SQL; `queryEmbedding`
   * is formatted by the strategy into its engine's literal form.
   */
  distanceExpression(
    embeddingColumn: SQL,
    queryEmbedding: readonly number[],
    metric: VectorMetric,
  ): SQL;

  /**
   * Emits the ANN index creation statement for a slot, or `undefined` when
   * indexing is inline (vec0) or unsupported (brute-force-only strategies).
   * Invoked through `backend.createVectorIndex` during `materializeIndexes`.
   */
  buildCreateIndex?(
    slot: VectorSlot,
    options?: Readonly<{ concurrent?: boolean }>,
  ): SQL | undefined;

  /** Emits the ANN index drop statement, or `undefined` when not applicable. */
  buildDropIndex?(slot: VectorSlot): SQL | undefined;
}

// ============================================================
// Shared, dialect-neutral expression math
// ============================================================
//
// These transforms are identical across pgvector / sqlite-vec / libSQL —
// only `distanceExpression` differs — so they live once here and are reused
// by both `buildSearch` implementations and the compiler CTE builder.

/**
 * Converts a distance expression into a score expression (higher = better).
 * Cosine distance is mapped to similarity (`1 - d`); l2 and inner_product
 * are returned as-is (lower distance already ranks better, ordered ASC).
 */
export function vectorScoreExpression(
  distanceExpression: SQL,
  metric: VectorMetric,
): SQL {
  switch (metric) {
    case "cosine": {
      return sql`(1 - (${distanceExpression}))`;
    }
    case "l2":
    case "inner_product": {
      return distanceExpression;
    }
    default: {
      const _exhaustive: never = metric;
      throw new Error(`Unsupported vector metric: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Builds the `minScore` WHERE condition against a distance expression,
 * translating the score threshold back into the metric's distance space.
 */
export function vectorMinScoreCondition(
  distanceExpression: SQL,
  metric: VectorMetric,
  minScore: number,
): SQL {
  // Validate against the RESOLVED metric — both the compiler's relevance CTE
  // and the backend search path funnel here, so an out-of-range floor (e.g. a
  // cosine minScore of 5 → `distance <= 1 - 5`, which matches nothing) is
  // rejected loudly instead of silently returning zero rows.
  assertVectorMinScore(minScore, metric);
  switch (metric) {
    case "cosine": {
      return sql`${distanceExpression} <= ${1 - minScore}`;
    }
    case "l2": {
      return sql`${distanceExpression} <= ${minScore}`;
    }
    case "inner_product": {
      return sql`${distanceExpression} <= ${-minScore}`;
    }
    default: {
      const _exhaustive: never = metric;
      throw new Error(`Unsupported vector metric: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Validates that every value in an embedding is a finite number. Shared by
 * strategies so a NaN/Infinity is reported with the offending index before
 * it reaches engine-specific literal formatting (which would mask it).
 */
export function assertFiniteEmbedding(
  embedding: readonly number[],
  name: string,
): void {
  for (const [index, value] of embedding.entries()) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError(
        `${name}[${index}] must be a finite number, got: ${value}`,
      );
    }
  }
}

/**
 * Validates a vector-search `limit` is a positive integer. Enforced by the
 * backend's `vectorSearch` (defense in depth — the store boundary also
 * checks) so a direct backend call with `limit: 0` fails loudly instead of
 * silently scanning nothing.
 */
export function assertVectorSearchLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError(
      `vectorSearch limit must be a positive integer, got: ${limit}`,
    );
  }
}

/**
 * Validates a `minScore` floor against its (resolved) metric: it must be finite,
 * and for cosine it must lie in [-1, 1] (a cosine score is the `1 - distance`
 * similarity). Shared by the store facade, the compiler's relevance CTE
 * ({@link vectorMinScoreCondition}), and the backend search path so every entry
 * point rejects the same out-of-range floor instead of silently returning none.
 */
export function assertVectorMinScore(
  minScore: number,
  metric: VectorMetric,
  label = "minScore",
): void {
  if (!Number.isFinite(minScore)) {
    throw new RangeError(`${label} must be a finite number, got: ${minScore}`);
  }
  if (metric === "cosine" && Math.abs(minScore) > 1) {
    throw new RangeError(
      `${label} for the cosine metric must be between -1 and 1, got: ${minScore}`,
    );
  }
}

// ============================================================
// Shared physical naming
// ============================================================

/**
 * pgvector inherits Postgres' 63-byte identifier ceiling; SQLite/libSQL are
 * far more generous, so the smallest common cap keeps one naming scheme
 * across every strategy.
 */
const MAX_VECTOR_IDENTIFIER_LENGTH = 63;

function sanitizeIdentifierPart(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9_]/g, "_");
}

/**
 * Deterministic 8-char hash for collision-safe truncation of over-long
 * identifiers. Self-contained so the strategy layer has no backend-runtime
 * dependency.
 */
export function shortHash(input: string): string {
  let h1 = 0xde_ad_be_ef;
  let h2 = 0x41_c6_ce_57;
  for (let index = 0; index < input.length; index++) {
    const ch = input.codePointAt(index)!;
    h1 = Math.imul(h1 ^ ch, 0x9e_37_79_b1);
    h2 = Math.imul(h2 ^ ch, 0x5f_35_64_95);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 0x85_eb_ca_6b) ^
    Math.imul(h2 ^ (h2 >>> 13), 0xc2_b2_ae_35);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 0x85_eb_ca_6b) ^
    Math.imul(h1 ^ (h1 >>> 13), 0xc2_b2_ae_35);
  const hi = (h2 >>> 0).toString(16).padStart(8, "0");
  const lo = (h1 >>> 0).toString(16).padStart(8, "0");
  return `${hi}${lo}`.slice(0, 8);
}

/**
 * Deterministic per-`(graphId, nodeKind, fieldPath)` physical name. Shared by
 * every strategy's `tableName`, by index naming, and by the compiler's
 * per-field table resolution so all three agree on which physical object backs
 * a field in a graph. Truncated with a hash suffix past the 63-char ceiling;
 * the hash covers all three parts, so truncation stays collision-safe even
 * when long graph ids dominate the prefix.
 *
 * @example `vectorPhysicalName("tg_vec", "g1", "Document", "embedding")`
 *          → `"tg_vec_g1_document_embedding_<hash8>"`
 */
export function vectorPhysicalName(
  prefix: string,
  graphId: string,
  nodeKind: string,
  fieldPath: string,
): string {
  const readable = `${prefix}_${sanitizeIdentifierPart(graphId)}_${sanitizeIdentifierPart(nodeKind)}_${sanitizeIdentifierPart(fieldPath)}`;
  // Always suffix a hash of the EXACT (graphId, nodeKind, fieldPath) tuple.
  // Sanitization is lossy (case-folding, every non-`[a-z0-9_]` char → `_`) and
  // the `_` join is ambiguous, so distinct fields can share a readable part —
  // e.g. ("a_b","c") vs ("a","b_c"), or "Doc-A" vs "Doc_A" vs "doc". The hash
  // keeps their physical tables distinct so writes/searches never cross fields.
  const hash = shortHash(JSON.stringify([graphId, nodeKind, fieldPath]));
  const full = `${readable}_${hash}`;
  if (full.length <= MAX_VECTOR_IDENTIFIER_LENGTH) return full;
  // Over the ceiling: truncate the readable part, always keep the hash.
  return `${readable.slice(0, MAX_VECTOR_IDENTIFIER_LENGTH - 1 - hash.length)}_${hash}`;
}

/**
 * Double-quote a SQL identifier, escaping embedded quotes. Dialect-neutral
 * (both SQLite and Postgres use `"..."`), so the three vector strategies share
 * one implementation for quoting their per-field table / index names.
 */
export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
