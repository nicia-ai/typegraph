/**
 * sqlite-vec strategy — real `vec0` KNN for local SQLite.
 *
 * This upgrades `createLocalSqliteBackend` (better-sqlite3 + the sqlite-vec
 * extension) from the legacy brute-force-on-a-shared-table model to genuine
 * approximate-nearest-neighbor search on per-`(nodeKind, fieldPath)` storage.
 *
 * ## Storage choice: a `vec0` virtual table per field
 *
 * Each slot is backed by its own `vec0` virtual table:
 *
 * ```sql
 * CREATE VIRTUAL TABLE tg_vec_<kind>_<field> USING vec0(
 *   node_id TEXT PRIMARY KEY,
 *   graph_id TEXT PARTITION KEY,
 *   +created_at TEXT,
 *   +updated_at TEXT,
 *   embedding float[<N>] distance_metric=<cosine|l2>
 * );
 * ```
 *
 * Verified against the installed `sqlite-vec` `v0.1.9`:
 *
 * - **vec0 over a plain `vec_f32` BLOB column.** The shipped option (a) — a
 *   `vec0` virtual table — is chosen over option (b) — a regular table whose
 *   `vec_f32` BLOB column is brute-forced — because vec0 is the *only* form
 *   that gives local SQLite a real ANN index (today's code only ever
 *   brute-forces). vec0 indexes inline (the virtual table *is* the index), so
 *   there is no separate `CREATE INDEX` step.
 * - **KNN with partition-correct filtering.** `WHERE embedding MATCH vec_f32(q)
 *   AND k = ? AND graph_id = ?` returns the nearest `k`, ordered by `distance`,
 *   scoped to one graph — a near vector in another `graph_id` partition does
 *   not leak. This is strictly better than libSQL's table-global `vector_top_k`
 *   (which over-fetches for multi-graph correctness): vec0's `PARTITION KEY`
 *   makes the per-graph KNN exact.
 * - **One table serves both read paths.** The same `embedding` column answers
 *   the compiler's brute-force `distanceExpression` (`vec_distance_cosine` /
 *   `vec_distance_l2` over the column, `ORDER BY … LIMIT`, no `MATCH`), so the
 *   `.where(field.similarTo(...))` CTE path needs no second structure.
 * - **`k` and `LIMIT` are mutually exclusive** in a vec0 `MATCH` query, so the
 *   ANN path uses `k = <limit>` with no `LIMIT`, and the brute-force path uses
 *   `LIMIT <limit>` with no `MATCH`.
 * - **No `ON CONFLICT` / `INSERT OR REPLACE`** on a vec0 primary key, so upsert
 *   is `DELETE` + `INSERT` (atomic under the caller's outer transaction),
 *   mirroring the FTS5 strategy.
 *
 * Metric support is `cosine` + `l2` (no `inner_product` — sqlite-vec has no
 * `vec_distance_ip`), advertised as data on `capabilities`. The table's
 * `distance_metric` is fixed at creation from the slot's metric, alongside its
 * fixed dimension `N`.
 *
 * The libSQL and pgvector siblings implement the same `VectorStrategy`
 * contract for their engines.
 */
import { type SQL, sql } from "drizzle-orm";

import { quotedTableName } from "../../../backend/drizzle/operations/shared";
import { type StrategyTableContribution } from "../../../backend/table-contribution";
import {
  type DeleteEmbeddingParams,
  type UpsertEmbeddingBatchParams,
  type UpsertEmbeddingParams,
  type VectorCapabilities,
  type VectorMetric,
  type VectorSearchParams,
} from "../../../backend/types";
import {
  assertFiniteEmbedding,
  quoteIdentifier,
  VECTOR_CONTRIBUTION_PREFIX,
  vectorMinScoreCondition,
  vectorPhysicalName,
  vectorScoreExpression,
  type VectorSlot,
  type VectorStrategy,
} from "../vector-strategy";
import { vectorPageClause } from "./pagination";

/** Physical-name prefix for the per-field `vec0` virtual table. */
const TABLE_PREFIX = "tg_vec";

/**
 * sqlite-vec stores each dimension as a 32-bit float; `float[N]` accepts
 * large `N`, but we advertise the same conservative ceiling the legacy
 * SQLite path used so capability discovery is stable across the swap.
 */
const SQLITE_VEC_MAX_DIMENSIONS = 8000;

const SQLITE_VEC_CAPABILITIES: VectorCapabilities = {
  supported: true,
  metrics: ["cosine", "l2"],
  // vec0 always indexes inline, so the portable ANN intent ("hnsw", the
  // `embedding()` default) is honored by real KNN; "none" stays brute-force.
  // Both map to the same vec0 table — only `buildSearch` differs.
  indexTypes: ["hnsw", "none"],
  maxDimensions: SQLITE_VEC_MAX_DIMENSIONS,
  // vec0's KNN accepts primary-key `IN (SELECT …)` pushdown (verified on
  // sqlite-vec v0.1.9), so the candidate filter constrains the KNN itself and
  // a filtered search returns `k` live rows — no over-fetch, no scan bound, no
  // under-fill. The only bundled engine that can promise a full page.
  filteredApproximateSearch: {
    mode: "filter-pushdown",
    guaranteesFullPage: true,
  },
};

/** Whether a slot's declared index type maps to vec0's `MATCH … k =` KNN. */
function usesAnnIndex(slot: VectorSlot): boolean {
  return slot.indexType === "hnsw";
}

/** vec0 `distance_metric` token accepted in the virtual-table definition. */
function sqliteVecMetricToken(metric: VectorMetric): string {
  switch (metric) {
    case "cosine": {
      return "cosine";
    }
    case "l2": {
      return "l2";
    }
    case "inner_product": {
      throw new Error(
        "sqlite-vec does not support inner_product. Use 'cosine' or 'l2'.",
      );
    }
    default: {
      const _exhaustive: never = metric;
      throw new Error(`Unsupported vector metric: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Formats an embedding as the bound JSON argument to `vec_f32(...)`. The
 * value rides as a parameter (not interpolated) — `vec_f32` parses the JSON
 * array into the packed float blob. Finiteness is validated first so a
 * NaN/Infinity names its index before JSON.stringify masks it as `null`.
 */
function vecF32Literal(embedding: readonly number[], name: string): SQL {
  assertFiniteEmbedding(embedding, name);
  return sql`vec_f32(${JSON.stringify(embedding)})`;
}

function distanceExpression(
  embeddingColumn: SQL,
  queryEmbedding: readonly number[],
  metric: VectorMetric,
): SQL {
  const query = vecF32Literal(queryEmbedding, "queryEmbedding");
  switch (metric) {
    case "cosine": {
      return sql`vec_distance_cosine(${embeddingColumn}, ${query})`;
    }
    case "l2": {
      return sql`vec_distance_l2(${embeddingColumn}, ${query})`;
    }
    case "inner_product": {
      throw new Error(
        "sqlite-vec does not support inner_product. Use 'cosine' or 'l2'.",
      );
    }
    default: {
      const _exhaustive: never = metric;
      throw new Error(`Unsupported vector metric: ${String(_exhaustive)}`);
    }
  }
}

export const sqliteVecStrategy: VectorStrategy = {
  name: "sqlite-vec",
  capabilities: SQLITE_VEC_CAPABILITIES,

  tableName(graphId, nodeKind, fieldPath) {
    return vectorPhysicalName(TABLE_PREFIX, graphId, nodeKind, fieldPath);
  },

  ownedTables(slot): readonly StrategyTableContribution[] {
    const table = this.tableName(slot.graphId, slot.nodeKind, slot.fieldPath);
    const name = quoteIdentifier(table);
    const metric = sqliteVecMetricToken(slot.metric);

    // vec0 virtual tables cannot be modeled as a Drizzle table, so this is a
    // raw-ddl contribution — emitted verbatim and invisible to drizzle-kit.
    // `graph_id` is a PARTITION KEY so per-graph KNN is exact; `created_at` /
    // `updated_at` are auxiliary (`+`) columns (stored, not filtered on). The
    // virtual table *is* the index — no separate CREATE INDEX is emitted.
    return [
      {
        logicalName: `${VECTOR_CONTRIBUTION_PREFIX}:${slot.nodeKind}.${slot.fieldPath}`,
        owner: "sqlite-vec",
        tableName: table,
        createDdl: [
          `CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING vec0(
  node_id TEXT PRIMARY KEY,
  graph_id TEXT PARTITION KEY,
  +created_at TEXT,
  +updated_at TEXT,
  embedding float[${slot.dimensions}] distance_metric=${metric}
);`,
        ],
        runtimeEnsure: true,
      },
    ];
  },

  buildUpsert(slot, params: UpsertEmbeddingParams, timestamp): readonly SQL[] {
    const table = quotedTableName(
      this.tableName(slot.graphId, slot.nodeKind, slot.fieldPath),
    );
    const value = vecF32Literal(params.embedding, "embedding");
    // vec0 rejects ON CONFLICT / INSERT OR REPLACE on its primary key —
    // emulate upsert with DELETE + INSERT, atomic under the caller's
    // outer transaction (mirrors the FTS5 fulltext strategy).
    return [
      sql`
        DELETE FROM ${table}
        WHERE "node_id" = ${params.nodeId} AND "graph_id" = ${params.graphId}
      `,
      sql`
        INSERT INTO ${table} ("node_id", "graph_id", "created_at", "updated_at", "embedding")
        VALUES (${params.nodeId}, ${params.graphId}, ${timestamp}, ${timestamp}, ${value})
      `,
    ];
  },

  buildUpsertBatch(
    slot,
    params: UpsertEmbeddingBatchParams,
    timestamp,
  ): readonly SQL[] {
    const table = quotedTableName(
      this.tableName(slot.graphId, slot.nodeKind, slot.fieldPath),
    );
    // Same DELETE + INSERT upsert emulation as buildUpsert, in multi-row
    // form: one IN-list delete, one multi-row insert.
    const nodeIds = sql.join(
      params.rows.map((row) => sql`${row.nodeId}`),
      sql`, `,
    );
    const valueRows = sql.join(
      params.rows.map(
        (row) =>
          sql`(${row.nodeId}, ${params.graphId}, ${timestamp}, ${timestamp}, ${vecF32Literal(row.embedding, "embedding")})`,
      ),
      sql`, `,
    );
    return [
      sql`
        DELETE FROM ${table}
        WHERE "graph_id" = ${params.graphId} AND "node_id" IN (${nodeIds})
      `,
      sql`
        INSERT INTO ${table} ("node_id", "graph_id", "created_at", "updated_at", "embedding")
        VALUES ${valueRows}
      `,
    ];
  },

  buildDelete(slot, params: DeleteEmbeddingParams): readonly SQL[] {
    const table = quotedTableName(
      this.tableName(slot.graphId, slot.nodeKind, slot.fieldPath),
    );
    return [
      sql`
        DELETE FROM ${table}
        WHERE "node_id" = ${params.nodeId} AND "graph_id" = ${params.graphId}
      `,
    ];
  },

  // vec0's KNN is brute force in C — exact by construction (the
  // "index" is a partitioned scan, not a graph) — and the non-indexed
  // fallback below is a plain SQL scan. The compiler may therefore
  // route the NON-approximate `.similarTo()` branch through this form.
  searchIsExact: true,

  buildSearch(slot, params: VectorSearchParams, candidates?: SQL): SQL {
    const table = quotedTableName(
      this.tableName(slot.graphId, slot.nodeKind, slot.fieldPath),
    );
    const embeddingColumn = sql`${table}."embedding"`;
    const distance = distanceExpression(
      embeddingColumn,
      params.queryEmbedding,
      params.metric,
    );
    const score = vectorScoreExpression(distance, params.metric);

    if (usesAnnIndex(slot)) {
      // vec0 KNN. `k` and `LIMIT` are mutually exclusive in a MATCH query, so
      // bound `k = limit` and omit LIMIT. `graph_id` filters by the partition
      // key (exact, no recall loss). Order by vec0's own `distance` column —
      // the recomputed `distance` expression is reused only for score/minScore
      // so the math matches the brute-force path and the shared helpers.
      const query = vecF32Literal(params.queryEmbedding, "queryEmbedding");
      // `k` covers the requested page: vec0 has no OFFSET inside a MATCH
      // query, so fetch `limit + offset` neighbors and page in a wrapper.
      const knnK = params.limit + (params.offset ?? 0);
      const conditions: SQL[] = [
        sql`${table}."embedding" MATCH ${query}`,
        sql`k = ${knnK}`,
        sql`${table}."graph_id" = ${params.graphId}`,
      ];
      if (params.minScore !== undefined) {
        conditions.push(
          vectorMinScoreCondition(distance, params.metric, params.minScore),
        );
      }
      // vec0 KNN accepts primary-key `IN (SELECT ...)` pushdown (verified on
      // sqlite-vec v0.1.9): the filter constrains the KNN candidate set
      // itself, so `k` live results come back — exact, no over-fetch.
      if (candidates !== undefined) {
        conditions.push(sql`${table}."node_id" IN (${candidates})`);
      }
      const knnBody = sql`
        SELECT ${table}."node_id" AS node_id, ${score} AS score
        FROM ${table}
        WHERE ${sql.join(conditions, sql` AND `)}
        ORDER BY distance ASC
      `;
      if (params.offset === undefined || params.offset === 0) {
        return knnBody;
      }
      // MATERIALIZED fences the page wrapper: SQLite would otherwise
      // flatten the subquery and push the outer LIMIT into the vec0 MATCH
      // query, which rejects `k = ?` and LIMIT together.
      return sql`
        WITH knn_page AS MATERIALIZED (${knnBody})
        SELECT node_id, score FROM knn_page
        LIMIT ${params.limit} OFFSET ${params.offset}
      `;
    }

    // Brute-force scan: no MATCH, so LIMIT is allowed (and required).
    const conditions: SQL[] = [sql`${table}."graph_id" = ${params.graphId}`];
    if (candidates !== undefined) {
      conditions.push(sql`${table}."node_id" IN (${candidates})`);
    }
    if (params.minScore !== undefined) {
      conditions.push(
        vectorMinScoreCondition(distance, params.metric, params.minScore),
      );
    }
    const pageClause = vectorPageClause(params.limit, params.offset);
    return sql`
      SELECT ${table}."node_id" AS node_id, ${score} AS score
      FROM ${table}
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY ${distance} ASC
      ${pageClause}
    `;
  },

  distanceExpression(embeddingColumn, queryEmbedding, metric) {
    return distanceExpression(embeddingColumn, queryEmbedding, metric);
  },

  // vec0 indexes inline (the virtual table is the index), so there is no
  // standalone ANN index to create or drop — both return undefined.
  buildCreateIndex(): SQL | undefined {
    return undefined;
  },

  buildDropIndex(): SQL | undefined {
    return undefined;
  },

  buildDropStorage(slot): readonly string[] {
    const table = quoteIdentifier(
      this.tableName(slot.graphId, slot.nodeKind, slot.fieldPath),
    );
    // Dropping the vec0 virtual table removes its backing shadow tables too.
    return [`DROP TABLE IF EXISTS ${table}`];
  },
};
