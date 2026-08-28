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
import { type StrategyTableContribution } from "../../backend/table-contribution";
import {
  type DeleteEmbeddingParams,
  type UpsertEmbeddingBatchParams,
  type UpsertEmbeddingParams,
  type VectorCapabilities,
  type VectorIndexType,
  type VectorMetric,
  type VectorSearchFrontierTuning,
  type VectorSearchParams,
} from "../../backend/types";
import {
  ConfigurationError,
  UnsupportedBackendCapabilityError,
} from "../../errors";
import { requireDefined } from "../../utils/presence";
import { sql, type SqlFragment } from "../sql-fragment";

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
export type VectorStrategy = Readonly<{
  /** Human-readable identifier used in error messages and telemetry. */
  name: string;

  /**
   * The metrics, index types, and dimension ceiling this strategy honors —
   * advertised verbatim as `backend.capabilities.vector`. Asymmetry across
   * engines is legitimate and explicit here (pgvector has `inner_product`;
   * libSQL/sqlite-vec do not), never a silent runtime failure.
   */
  capabilities: VectorCapabilities;

  /**
   * Deterministic physical table (or virtual-table) name backing a field in
   * a graph. The compiler references this to scan the right per-field storage,
   * and the backend uses it to route upserts/deletes. Must be a stable,
   * collision-safe SQL identifier derived from `(graphId, nodeKind, fieldPath)`.
   */
  tableName: (
    this: void,
    graphId: string,
    nodeKind: string,
    fieldPath: string,
  ) => string;

  /**
   * The per-field storage this strategy owns for `slot`, as Drizzle-free
   * `StrategyTableContribution`s (resolved `tableName`, deterministic
   * idempotent `createDdl` for the table **and** its ANN index when the
   * slot's `indexType` warrants one, `runtimeEnsure`). Rides the #129/#135
   * table-contribution + durable-materialization machinery exactly as the
   * FTS5 / tsvector virtual tables do — these are materialized per graph by
   * `materializeIndexes()`, not by global `bootstrapTables`.
   */
  ownedTables: (
    this: void,
    slot: VectorSlot,
  ) => readonly StrategyTableContribution[];

  /**
   * Emits the statement(s) that upsert a single embedding into the slot's
   * storage. Multiple statements are allowed for engines that cannot upsert
   * a vector in one statement (e.g. a `vec0` virtual table → DELETE+INSERT).
   */
  buildUpsert: (
    this: void,
    slot: VectorSlot,
    params: UpsertEmbeddingParams,
    timestamp: string,
  ) => readonly SqlFragment[];

  /**
   * Emits one atomic upsert sourced from a node `RETURNING` CTE.
   *
   * The source alias is backend-owned SQL (normally `inserted_node`), never
   * caller input. The strategy must take graph/node identity from the source
   * row rather than from the embedding parameters, so a node insert and its
   * sidecar cannot disagree about identity. Strategies whose storage needs
   * more than one statement omit this capability and use {@link buildUpsert}
   * on the ordinary sidecar path.
   */
  buildUpsertFromInsertedNode?: (
    this: void,
    slot: VectorSlot,
    sourceAlias: string,
    embedding: readonly number[],
    timestamp: string,
  ) => SqlFragment;

  /**
   * Emits the statement(s) that upsert MANY embeddings into the slot's
   * storage in multi-row form. Optional — the backend falls back to one
   * {@link buildUpsert} per row when unset. The backend guarantees the
   * rows carry distinct `nodeId`s and fit the connection's bound-parameter
   * budget (it chunks before calling).
   */
  buildUpsertBatch?: (
    this: void,
    slot: VectorSlot,
    params: UpsertEmbeddingBatchParams,
    timestamp: string,
  ) => readonly SqlFragment[];

  /** Emits the statement(s) that delete a single embedding from the slot. */
  buildDelete: (
    this: void,
    slot: VectorSlot,
    params: DeleteEmbeddingParams,
  ) => readonly SqlFragment[];
  /** Emits one set-based delete for many node ids in a vector slot. */
  buildDeleteBatch: (
    this: void,
    slot: VectorSlot,
    params: Omit<DeleteEmbeddingParams, "nodeId"> &
      Readonly<{ nodeIds: readonly string[] }>,
  ) => readonly SqlFragment[];

  /**
   * Raw DDL statement(s) that drop the slot's entire physical storage
   * (table + ANN index, and any engine-managed shadow tables). Used by the
   * destructive `store.reembedVectorField()` path to recreate a field's
   * storage at a new dimension. Returned as raw strings (like
   * `ownedTables(...).createDdl`) for `backend.executeDdl`; must be idempotent
   * (`IF EXISTS`).
   */
  buildDropStorage: (this: void, slot: VectorSlot) => readonly string[];

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
  buildSearch: (
    this: void,
    slot: VectorSlot,
    params: VectorSearchParams,
    candidates?: SqlFragment,
  ) => SqlFragment;

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
  distanceExpression: (
    this: void,
    embeddingColumn: SqlFragment,
    queryEmbedding: readonly number[],
    metric: VectorMetric,
  ) => SqlFragment;

  /**
   * Emits the ANN index creation statement for a slot, or `undefined` when
   * indexing is inline (vec0) or unsupported (brute-force-only strategies).
   * Invoked through `backend.createVectorIndex` during `materializeIndexes`.
   */
  buildCreateIndex?: (
    this: void,
    slot: VectorSlot,
    options?: Readonly<{ concurrent?: boolean }>,
  ) => SqlFragment | undefined;

  /** Emits the ANN index drop statement, or `undefined` when not applicable. */
  buildDropIndex?: (this: void, slot: VectorSlot) => SqlFragment | undefined;
}>;

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
  distanceExpression: SqlFragment,
  metric: VectorMetric,
): SqlFragment {
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
  distanceExpression: SqlFragment,
  metric: VectorMetric,
  minScore: number,
): SqlFragment {
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
 * The frontier declaration of a backend's active vector strategy, or the
 * "there is no vector engine here" declaration when vector support is
 * disabled. Total, so a call site never has to invent a default: a backend
 * with no strategy has nothing to apply an override to and refuses on the
 * same arm as an engine that lacks the knob.
 */
export function vectorSearchFrontierTuning(
  strategy: VectorStrategy | undefined,
): VectorSearchFrontierTuning {
  return (
    strategy?.capabilities.searchFrontierTuning ?? {
      tunable: false,
      reason: "vector support is disabled on this backend",
    }
  );
}

/** What one backend needs to decide whether it can apply an `efSearch`. */
export type EfSearchApplicability = Readonly<{
  /** The caller's override; `undefined` (no override) is always accepted. */
  efSearch: number | undefined;
  /** Index type of the slot being searched. */
  indexType: VectorIndexType;
  /** The active strategy's declaration. See {@link VectorSearchFrontierTuning}. */
  tuning: VectorSearchFrontierTuning;
  /** Whether the backend can open the frame a scoped override needs. */
  interactiveTransactions: boolean;
  /**
   * Dialect name used in the refusal message (`"PostgreSQL"` / `"SQLite"`) —
   * the only dialect-specific token in the decision, so both backends read
   * the same predicate rather than re-spelling the arms.
   */
  dialect: string;
  /** Engine identity recorded in the refusal details (`strategy.name`). */
  engine: string;
}>;

/**
 * The single owner of "may this backend apply a per-search `efSearch`?" —
 * returning the engine parameter to set with it, or `undefined` when no
 * override was requested.
 *
 * An accepted option is applied or refused, never ignored: every arm below is
 * a state in which the option cannot reach the engine, and each throws naming
 * that state instead of dropping the value. Both backends call this before
 * building the search, so the SQLite and PostgreSQL behaviors are two readings
 * of one predicate — the sqlite-vec silent no-op existed precisely because the
 * decision lived only on the PostgreSQL side. Returning the parameter (rather
 * than only asserting) is what keeps it one owner: the caller that applies the
 * override never re-derives whether it may.
 *
 * Refusals:
 *
 * - engine has no per-search frontier knob at all (`tunable: false`) —
 *   `UnsupportedBackendCapabilityError` on `vector.searchFrontierTuning`,
 *   carrying the strategy's own `reason`.
 * - slot is not the tunable index type — `ConfigurationError` (the caller can
 *   fix this by declaring the index, so it is configuration, not capability).
 * - the override needs a transaction to be scoped to and the backend has none
 *   — `UnsupportedBackendCapabilityError` on `execution.interactiveTransactions`.
 *
 * Range validation (pgvector's 1..1000) stays with the engine that has the
 * range; this predicate answers only whether the knob exists here at all.
 */
export function resolveEfSearchOverride(
  applicability: EfSearchApplicability,
): string | undefined {
  const {
    efSearch,
    indexType,
    tuning,
    interactiveTransactions,
    dialect,
    engine,
  } = applicability;
  if (efSearch === undefined) return undefined;
  if (!tuning.tunable) {
    throw new UnsupportedBackendCapabilityError(
      `${dialect} efSearch override`,
      "vector.searchFrontierTuning",
      { efSearch, engine, reason: tuning.reason },
      `Omit efSearch: ${engine} has no per-search ANN frontier parameter (${tuning.reason}). Tune recall with the search limit, or use an exact search.`,
    );
  }
  if (indexType !== tuning.indexType) {
    // "an HNSW vector index" — the article suits the one tunable index type
    // any bundled engine declares.
    throw new ConfigurationError(
      `${dialect} efSearch requires an ${tuning.indexType.toUpperCase()} vector index.`,
      { efSearch, indexType },
      {
        suggestion: `Configure the embedding with index: { type: "${tuning.indexType}" }, or omit efSearch.`,
      },
    );
  }
  if (tuning.requiresTransactionScope && !interactiveTransactions) {
    throw new UnsupportedBackendCapabilityError(
      `${dialect} efSearch override`,
      "execution.interactiveTransactions",
      { efSearch, engine, parameter: tuning.parameter },
      `Use a transactional ${dialect} driver: ${tuning.parameter} is scoped to the search's own transaction, and a session-wide setting would leak into concurrent searches.`,
    );
  }
  return tuning.parameter;
}

/** What one call site needs to decide whether ANN retrieval can be honored. */
export type ApproximateRetrievalRequest = Readonly<{
  /** Whether the caller STATED `approximate: true`. */
  approximate: boolean | undefined;
  /**
   * The metric the caller explicitly overrode to, or `undefined` when they
   * passed none (in which case the slot's declared metric is used and no
   * mismatch is possible).
   */
  requestedMetric: VectorMetric | undefined;
  /** The metric the slot's storage and ANN structure were built for. */
  declaredMetric: VectorMetric;
  /** The slot's index type; `"none"` means there is no ANN structure at all. */
  indexType: VectorIndexType;
  /** Kind and field named in the refusal, so a union says WHICH slot refused. */
  nodeKind: string;
  fieldPath: string;
}>;

/**
 * The single owner of "can this slot serve APPROXIMATE retrieval under the
 * metric the caller asked for?".
 *
 * Every engine materializes metric-specific ANN structures — vec0 bakes
 * `distance_metric` into the virtual table, libSQL's DiskANN index is built
 * with `metric=…`, pgvector's index carries a per-metric operator class — so
 * an ANN structure can only retrieve under the metric it was built for.
 * Retrieving by the declared metric and re-scoring under an overridden one
 * returns the declared metric's neighbors wearing the override's scores: the
 * wrong rows, silently.
 *
 * Stating `approximate: true` alongside a mismatched `metric` therefore states
 * two things that cannot both hold. The option is refused naming both metrics
 * rather than downgraded to an exact scan behind the caller's back — the same
 * accepted-or-refused rule {@link resolveEfSearchOverride} applies to
 * `efSearch`.
 *
 * NOT refused, deliberately:
 *
 * - `indexType: "none"`. There is no ANN structure to be bound to a metric, so
 *   `approximate` has nothing to opt into and compiles to the strategy's exact
 *   scan under whichever metric was asked for. That degradation is stated on
 *   the public `SimilarToOptions.approximate` option.
 * - A mismatched metric with NO `approximate`. An exact scan computes any
 *   metric over the stored vectors correctly, and nothing was stated that the
 *   engine cannot honor. (`store.search.vector` refuses that override too, on
 *   its own broader rule — see `assertVectorQueryCompatible` in
 *   `store/search.ts`. The query builder's exact path is deliberately the
 *   wider surface; only the *silent* half is closed here.)
 */
export function assertApproximateMetricSupported(
  request: ApproximateRetrievalRequest,
): void {
  const {
    approximate,
    requestedMetric,
    declaredMetric,
    indexType,
    nodeKind,
    fieldPath,
  } = request;
  if (approximate !== true) return;
  if (indexType === "none") return;
  if (requestedMetric === undefined || requestedMetric === declaredMetric) {
    return;
  }
  throw new ConfigurationError(
    `Approximate retrieval for "${nodeKind}.${fieldPath}" cannot use metric "${requestedMetric}": its ${indexType.toUpperCase()} index is built for "${declaredMetric}", and an ANN structure only retrieves under the metric it was built for.`,
    {
      nodeKind,
      fieldPath,
      requestedMetric,
      declaredMetric,
      indexType,
    },
    {
      suggestion: `Omit metric (or pass "${declaredMetric}") to keep approximate retrieval, or drop approximate to scan exactly under "${requestedMetric}".`,
    },
  );
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
    const ch = requireDefined(input.codePointAt(index));
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
