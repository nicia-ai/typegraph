/**
 * One-time offline migration: legacy shared embeddings table → per-field
 * strategy storage.
 *
 * ## What this is for
 *
 * The cross-backend vector cutover (#157) dropped the single shared
 * `typegraph_node_embeddings` table. Each
 * `VectorStrategy` now OWNS one typed, fixed-dimension structure per
 * `(nodeKind, fieldPath)` — the only layout that can be ANN-indexed on
 * libSQL and sqlite-vec, not just pgvector.
 *
 * Deployments that wrote embeddings under the old shared table before
 * upgrading still hold those rows. This utility drains them into the new
 * per-field storage **once**, during the upgrade, so existing embedded
 * data survives the cutover without re-embedding from source.
 *
 * It is an explicitly-run, offline step — not wired into `materializeIndexes`
 * or any boot path. Run it once after deploying the new version and before
 * (or alongside) the first `materializeIndexes()`, then drop the legacy
 * table at your leisure.
 *
 * ## How it works
 *
 * - Skips cleanly (returns a zero summary) when the legacy table is absent —
 *   a fresh install, or a re-run after the table was dropped.
 * - Reads rows in keyset-paginated batches (never the whole table at once),
 *   decoding the engine-native embedding column to a numeric array at the SQL
 *   level: sqlite-vec stored a `vec_f32` blob (`vec_to_json` decodes it);
 *   pgvector stored a native `vector` (`::text` yields a `[…]` literal).
 * - Re-inserts each row through `backend.upsertEmbedding`, which routes the
 *   active strategy's `buildUpsert` and idempotently provisions the per-field
 *   storage (the same `(nodeKind, fieldPath)` slot a fresh store write uses).
 *   The migration stays graph-agnostic and execution-correct on both the
 *   sync (better-sqlite3) and async (libsql / Postgres) backends — it does
 *   not re-implement the backend's statement-execution glue.
 *
 * Idempotent and resumable: a partial run followed by a full run converges
 * to the same per-field tables, because every write is an upsert keyed by
 * `(graph_id, node_id)` in the strategy's owned storage.
 */
import {
  DEFAULT_EMBEDDING_INDEX_TYPE,
  DEFAULT_EMBEDDING_METRIC,
  type EmbeddingIndexType,
  type EmbeddingMetric,
} from "../core/embedding";
import { EmbeddingDimensionChangedError } from "../errors";
import { sql, type SqlFragment } from "../query/sql-fragment";
import { asCompiledRowsSql } from "../query/sql-intent";
import { requireDefined } from "../utils/presence";
import { isMissingTableError } from "../utils/sql-errors";
import { LEGACY_EMBEDDINGS_TABLE_NAME } from "./drizzle/schema/sqlite";
import { type GraphBackend } from "./types";

/**
 * Default rows read per round-trip. Large enough to amortize round-trip
 * latency, small enough to bound peak memory regardless of table size.
 */
const DEFAULT_BATCH_SIZE = 500;

/**
 * Metric / index type applied to a migrated field when no
 * {@link MigrateLegacyEmbeddingsOptions.resolveSlotConfig} is supplied (or
 * it returns `undefined`). Matches the defaults `embedding()` and
 * `resolveEmbeddingFields` apply, so a migrated field lands in storage shaped
 * identically to one written fresh through the store. Migrated data is only
 * ever brute-forceable until `materializeIndexes()` builds the ANN index, so
 * the index-type default governs only which ANN structure the per-field
 * storage DDL provisions, not the migration's correctness.
 */
const DEFAULT_SLOT_METRIC: EmbeddingMetric = DEFAULT_EMBEDDING_METRIC;
const DEFAULT_SLOT_INDEX_TYPE: EmbeddingIndexType =
  DEFAULT_EMBEDDING_INDEX_TYPE;

/**
 * The resolved storage config for one `(nodeKind, fieldPath)` slot that the
 * legacy table did not record. The legacy shared table stored only the
 * vector and its dimension count — not the metric or index type — so a
 * caller that wants migrated fields to match a specific graph's `embedding()`
 * declarations supplies this resolver.
 */
export type LegacyEmbeddingSlotConfig = Readonly<{
  metric: EmbeddingMetric;
  indexType: EmbeddingIndexType;
}>;

/**
 * Options for {@link migrateLegacyEmbeddings}.
 */
export type MigrateLegacyEmbeddingsOptions = Readonly<{
  /**
   * The backend to migrate, wired with the destination `VectorStrategy`
   * (i.e. the post-cutover backend). Its `vectorStrategy` owns the per-field
   * storage rows are written into and its `upsertEmbedding` performs the
   * writes.
   */
  backend: GraphBackend;

  /**
   * Restrict the migration to a single graph. When omitted, every graph's
   * rows in the legacy table are migrated (the table is graph-scoped by its
   * `graph_id` column).
   */
  graphId?: string;

  /**
   * Resolves the metric / index type for a `(nodeKind, fieldPath)` slot the
   * legacy table didn't persist. Return `undefined` to fall back to the
   * cosine / hnsw defaults. Supply this (typically reading the graph's
   * `embedding()` declarations) when migrated fields must match a specific
   * metric — e.g. an `l2` field, which scores incorrectly under the cosine
   * default.
   */
  resolveSlotConfig?: (
    nodeKind: string,
    fieldPath: string,
  ) => LegacyEmbeddingSlotConfig | undefined;

  /** Rows read per round-trip. Defaults to {@link DEFAULT_BATCH_SIZE}. */
  batchSize?: number;

  /**
   * Physical name of the legacy table to drain. Defaults to
   * {@link LEGACY_EMBEDDINGS_TABLE_NAME}. Override only for a non-default
   * deployment that renamed the embeddings table.
   */
  legacyTableName?: string;
}>;

/**
 * Summary of a {@link migrateLegacyEmbeddings} run.
 */
export type MigrateLegacyEmbeddingsResult = Readonly<{
  /** Total embedding rows re-inserted into per-field storage. */
  migrated: number;
  /**
   * Per-`(nodeKind, fieldPath)` counts, keyed `"<nodeKind>.<fieldPath>"`
   * (the strategy's logical-slot key form). Empty when the legacy table was
   * absent or held no rows for the requested scope.
   */
  perField: Readonly<Record<string, number>>;
  /**
   * Rows skipped because their vector length didn't match the per-field
   * table's fixed dimension. The legacy shared column allowed mixed
   * dimensions for one `(nodeKind, fieldPath)` (e.g. an unmigrated model
   * change); the first migrated row fixes the typed table's dimension and
   * any differently-sized rows for that slot are skipped rather than aborting
   * the whole migration. Keyed `"<nodeKind>.<fieldPath>"`. Non-empty here
   * means those fields need a deliberate re-embed at a single dimension.
   */
  skippedDimensionMismatch: Readonly<Record<string, number>>;
  /**
   * Rows skipped because their legacy embedding could not be decoded into a
   * finite-number array — a corrupt value (e.g. a pgvector `vector` column
   * permits `NaN`/`Infinity`, which is not valid JSON). Keyed
   * `"<nodeKind>.<fieldPath>"`. Skipping + reporting keeps one bad row from
   * aborting the whole migration; non-empty here means those rows need manual
   * repair.
   */
  skippedDecodeError: Readonly<Record<string, number>>;
  /**
   * Whether the legacy table existed. `false` means the run was a clean
   * no-op (fresh install, or already-dropped table on a re-run).
   */
  legacyTablePresent: boolean;
}>;

/**
 * A single legacy embedding row, with the engine-native vector already
 * decoded to a JSON array string by the dialect-specific SELECT. The
 * legacy `dimensions` column is intentionally not read: the decoded array's
 * length is the authoritative fixed dimension for the destination slot, and
 * relying on it sidesteps the per-driver string/number coercion the legacy
 * integer column would otherwise need.
 */
type LegacyEmbeddingRow = Readonly<{
  graph_id: string;
  node_kind: string;
  node_id: string;
  field_path: string;
  /** JSON array text, e.g. `"[0.1,0.2,0.3]"` — decoded per dialect. */
  embedding_json: string;
}>;

/**
 * Re-inserts every embedding from the legacy shared
 * `typegraph_node_embeddings` table into the active
 * `backend.vectorStrategy`'s per-`(nodeKind, fieldPath)` storage.
 *
 * One-time, explicitly-run upgrade step for the shared-table → per-field
 * cutover (#157). Idempotent, batched, and a clean no-op when the legacy
 * table is absent. See the module doc comment for the full contract.
 *
 * @throws Error when the backend exposes no `vectorStrategy` /
 *         `upsertEmbedding` (nothing to migrate *into*) — a configuration
 *         error the caller must fix by wiring the destination strategy
 *         before migrating.
 */
export async function migrateLegacyEmbeddings(
  options: MigrateLegacyEmbeddingsOptions,
): Promise<MigrateLegacyEmbeddingsResult> {
  const {
    backend,
    graphId,
    resolveSlotConfig,
    batchSize = DEFAULT_BATCH_SIZE,
    legacyTableName = LEGACY_EMBEDDINGS_TABLE_NAME,
  } = options;

  if (
    backend.vectorStrategy === undefined ||
    backend.upsertEmbedding === undefined
  ) {
    throw new Error(
      "migrateLegacyEmbeddings requires a backend wired with a vectorStrategy " +
        "(the destination per-field storage). Pass the post-cutover backend.",
    );
  }
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new RangeError(
      `batchSize must be a positive integer, got: ${batchSize}`,
    );
  }
  const upsertEmbedding = backend.upsertEmbedding;
  const ensureVectorSlotContribution = backend.ensureVectorSlotContribution;

  const perField: Record<string, number> = {};
  const skippedDimensionMismatch: Record<string, number> = {};
  const skippedDecodeError: Record<string, number> = {};
  // (kind, field) slots whose per-field table + durable marker this run has
  // already provisioned, mapped to the dimension the table was fixed at.
  // `upsertEmbedding` asserts the marker (#135) and no longer self-creates
  // the table, so this offline migration (privileged) provisions each slot
  // once — at the first row's dimension, which fixes the typed table just as
  // the original lazy write did. Differently-sized later rows for the same
  // slot are detected against this map and skipped BEFORE the upsert: the
  // marker assert would otherwise read the differently-dimensioned slot as
  // stale and abort the whole migration, and the ensure is deliberately not
  // re-run per row (that would trip the marker drift-guard).
  const ensuredSlots = new Map<string, number>();
  let migrated = 0;

  let cursor: LegacyRowCursor | undefined;
  for (;;) {
    let batch: readonly LegacyEmbeddingRow[];
    try {
      batch = await readLegacyBatch(backend, {
        legacyTableName,
        graphId,
        batchSize,
        after: cursor,
      });
    } catch (error) {
      // A missing legacy table is the expected "nothing to migrate" path on
      // the first read — surface it as a clean no-op, not a failure.
      if (cursor === undefined && isMissingTableError(error)) {
        return {
          migrated: 0,
          perField: {},
          skippedDimensionMismatch: {},
          skippedDecodeError: {},
          legacyTablePresent: false,
        };
      }
      throw error;
    }

    if (batch.length === 0) break;

    for (const row of batch) {
      const slotKey = `${row.node_kind}.${row.field_path}`;

      let embedding: readonly number[];
      try {
        embedding = decodeEmbeddingJson(row);
      } catch {
        // A corrupt legacy value (e.g. a pgvector `vector` column permits
        // NaN/Infinity, which is not valid JSON) is skipped + reported rather
        // than aborting the whole migration on one bad row.
        skippedDecodeError[slotKey] = (skippedDecodeError[slotKey] ?? 0) + 1;
        continue;
      }
      const config = resolveSlotConfig?.(row.node_kind, row.field_path);
      // The decoded length is the authoritative fixed dimension — the
      // strategy provisions its column type (e.g. `F32_BLOB(N)`) from it.
      const slot = {
        graphId: row.graph_id,
        nodeKind: row.node_kind,
        fieldPath: row.field_path,
        dimensions: embedding.length,
        metric: config?.metric ?? DEFAULT_SLOT_METRIC,
        indexType: config?.indexType ?? DEFAULT_SLOT_INDEX_TYPE,
      };

      // Provision the per-field table + durable marker before the first
      // write into this slot. Once per (graph, kind, field): the first row's
      // dimension fixes the table. Keyed by graph id too — the legacy table
      // is graph-scoped, so the same `kind.field` can recur across graphs.
      const ensuredKey = JSON.stringify([
        row.graph_id,
        row.node_kind,
        row.field_path,
      ]);
      if (
        ensureVectorSlotContribution !== undefined &&
        !ensuredSlots.has(ensuredKey)
      ) {
        await ensureVectorSlotContribution(slot);
        ensuredSlots.set(ensuredKey, slot.dimensions);
      }

      // The legacy shared column allowed mixed dimensions for one
      // (nodeKind, fieldPath); the per-field table is fixed at the first
      // migrated row's dimension. Skip a differently-sized row up front —
      // its slot would fail the marker assert as stale (different
      // signature), aborting the migration instead of skipping the row.
      const provisionedDimensions = ensuredSlots.get(ensuredKey);
      if (
        provisionedDimensions !== undefined &&
        provisionedDimensions !== embedding.length
      ) {
        skippedDimensionMismatch[slotKey] =
          (skippedDimensionMismatch[slotKey] ?? 0) + 1;
        continue;
      }

      try {
        await upsertEmbedding({ ...slot, nodeId: row.node_id, embedding });
      } catch (error) {
        // The legacy shared column allowed mixed dimensions for one
        // (nodeKind, fieldPath); the per-field table is fixed at the first
        // migrated row's dimension, so a differently-sized row is skipped and
        // reported rather than aborting the whole migration.
        if (error instanceof EmbeddingDimensionChangedError) {
          skippedDimensionMismatch[slotKey] =
            (skippedDimensionMismatch[slotKey] ?? 0) + 1;
          continue;
        }
        throw error;
      }

      migrated += 1;
      perField[slotKey] = (perField[slotKey] ?? 0) + 1;
    }

    if (batch.length < batchSize) break;
    const last = requireDefined(batch.at(-1));
    cursor = {
      graphId: last.graph_id,
      nodeKind: last.node_kind,
      nodeId: last.node_id,
      fieldPath: last.field_path,
    };
  }

  return {
    migrated,
    perField,
    skippedDimensionMismatch,
    skippedDecodeError,
    legacyTablePresent: true,
  };
}

/**
 * Composite keyset cursor over the legacy table's primary key
 * `(graph_id, node_kind, node_id, field_path)`. Stable under concurrent
 * writes and immune to OFFSET drift, so a batched walk reads every row once.
 */
type LegacyRowCursor = Readonly<{
  graphId: string;
  nodeKind: string;
  nodeId: string;
  fieldPath: string;
}>;

type ReadLegacyBatchParams = Readonly<{
  legacyTableName: string;
  graphId: string | undefined;
  batchSize: number;
  after: LegacyRowCursor | undefined;
}>;

/**
 * Reads one keyset-paginated batch of legacy rows, ordered by the primary
 * key, with the engine-native embedding column decoded to a JSON array
 * string by the dialect.
 */
async function readLegacyBatch(
  backend: GraphBackend,
  params: ReadLegacyBatchParams,
): Promise<readonly LegacyEmbeddingRow[]> {
  const table = sql.identifier(params.legacyTableName);
  const embeddingJson = legacyEmbeddingDecodeExpression(backend);

  const conditions: SqlFragment[] = [];
  if (params.graphId !== undefined) {
    conditions.push(sql`"graph_id" = ${params.graphId}`);
  }
  if (params.after !== undefined) {
    conditions.push(keysetAfterCondition(params.after));
  }

  const whereClause =
    conditions.length === 0 ?
      sql``
    : sql` WHERE ${sql.join(conditions, sql` AND `)}`;

  const query = sql`
    SELECT
      "graph_id" AS graph_id,
      "node_kind" AS node_kind,
      "node_id" AS node_id,
      "field_path" AS field_path,
      ${embeddingJson} AS embedding_json
    FROM ${table}${whereClause}
    ORDER BY "graph_id" ASC, "node_kind" ASC, "node_id" ASC, "field_path" ASC
    LIMIT ${params.batchSize}
  `;

  return backend.execute<LegacyEmbeddingRow>(asCompiledRowsSql(query));
}

/**
 * The strict `>` comparison over the composite primary key, expressed as
 * the standard lexicographic OR-chain so it works on every dialect (SQLite
 * supports row-value comparison, but Postgres + SQLite both accept this
 * portable form).
 */
function keysetAfterCondition(after: LegacyRowCursor): SqlFragment {
  return sql`
    (
        "graph_id" > ${after.graphId}
        OR ("graph_id" = ${after.graphId} AND "node_kind" > ${after.nodeKind})
        OR ("graph_id" = ${after.graphId} AND "node_kind" = ${after.nodeKind} AND "node_id" > ${after.nodeId})
        OR (
          "graph_id" = ${after.graphId}
          AND "node_kind" = ${after.nodeKind}
          AND "node_id" = ${after.nodeId}
          AND "field_path" > ${after.fieldPath}
        )
      )
  `;
}

/**
 * The SQL expression that decodes the legacy engine-native embedding column
 * into a JSON array string `embedding_json`. The single dialect branch in
 * this whole module: the legacy storage formats are genuinely engine-
 * specific, and there is no longer a strategy abstraction over the *legacy*
 * table to delegate to.
 */
function legacyEmbeddingDecodeExpression(backend: GraphBackend): SqlFragment {
  switch (backend.dialect) {
    case "sqlite": {
      // Legacy SQLite embeddings were written via `vec_f32('[…]')`
      // (sqlite-vec binary). `vec_to_json` is its inverse, yielding the
      // JSON array text. Requires sqlite-vec on the connection — which the
      // legacy write path also required, so any deployment with legacy rows
      // has it loaded.
      return sql`vec_to_json("embedding")`;
    }
    case "postgres": {
      // pgvector's native `vector` casts to its `[…]` text literal, which is
      // valid JSON for `JSON.parse`.
      return sql`"embedding"::text`;
    }
    default: {
      const _exhaustive: never = backend.dialect;
      throw new Error(
        `migrateLegacyEmbeddings does not support dialect: ${String(_exhaustive)}`,
      );
    }
  }
}

/**
 * Parses a decoded `embedding_json` array, asserting it is a non-empty array
 * of finite numbers. A bad decode (wrong type, NaN) names the offending row
 * loudly instead of writing a corrupt vector into per-field storage.
 */
function decodeEmbeddingJson(row: LegacyEmbeddingRow): readonly number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.embedding_json) as unknown;
  } catch (error) {
    throw new Error(
      `Failed to decode legacy embedding for ${row.node_kind}.${row.field_path} ` +
        `(graph ${row.graph_id}, node ${row.node_id}): not valid JSON.`,
      { cause: error },
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      `Legacy embedding for ${row.node_kind}.${row.field_path} ` +
        `(graph ${row.graph_id}, node ${row.node_id}) decoded to a non-array ` +
        `or empty value.`,
    );
  }
  for (const [index, value] of parsed.entries()) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError(
        `Legacy embedding for ${row.node_kind}.${row.field_path} ` +
          `(graph ${row.graph_id}, node ${row.node_id}) has a non-finite ` +
          `value at index ${index}: ${String(value)}.`,
      );
    }
  }
  return parsed as readonly number[];
}
