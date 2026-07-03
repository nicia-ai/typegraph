/**
 * libSQL native vector strategy.
 *
 * libSQL ships vector search in core — no extension to load — so this
 * strategy is wired unconditionally by `createLibsqlBackend`. It backs each
 * `(nodeKind, fieldPath)` with its own `F32_BLOB(N)` table (the spike proved
 * the dimension MUST live in the column type for `libsql_vector_idx` to
 * build), brute-forces with `vector_distance_cos` / `vector_distance_l2`, and
 * accelerates with DiskANN (`libsql_vector_idx` + `vector_top_k`) when the
 * slot declares an approximate index.
 *
 * Metric support is `cosine` + `l2` (no `inner_product`), matching sqlite-vec
 * and advertised as data on `capabilities`. The generic `"hnsw"` index intent
 * (the portable "give me an ANN index" signal that `embedding()` defaults to)
 * is realized here as libSQL's DiskANN index; `"ivfflat"` is not supported and
 * a slot declaring it is materialized brute-force-only.
 *
 * The `pgvectorStrategy` and `sqliteVecStrategy` siblings follow the same
 * `VectorStrategy` contract for their engines.
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

/** Physical-name prefixes for the per-field table and its DiskANN index. */
const TABLE_PREFIX = "tg_vec";
const INDEX_PREFIX = "tg_vecidx";

/**
 * libSQL `F32_BLOB` caps at 65,536 dimensions (per Turso docs / spike §2).
 */
const LIBSQL_MAX_DIMENSIONS = 65_536;

const LIBSQL_CAPABILITIES: VectorCapabilities = {
  supported: true,
  metrics: ["cosine", "l2"],
  // "hnsw" = portable ANN intent, realized as DiskANN. "none" = brute-force.
  indexTypes: ["hnsw", "none"],
  maxDimensions: LIBSQL_MAX_DIMENSIONS,
};

/** Whether a slot's declared index type maps to a real libSQL ANN index. */
function usesAnnIndex(slot: VectorSlot): boolean {
  return slot.indexType === "hnsw";
}

/** libSQL metric token accepted by `libsql_vector_idx(col, 'metric=…')`. */
function libsqlMetricToken(metric: VectorMetric): string {
  switch (metric) {
    case "cosine": {
      return "cosine";
    }
    case "l2": {
      return "l2";
    }
    case "inner_product": {
      throw new Error(
        "libSQL vector search does not support inner_product. Use 'cosine' or 'l2'.",
      );
    }
    default: {
      const _exhaustive: never = metric;
      throw new Error(`Unsupported vector metric: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Formats an embedding as the text argument to `vector32(...)`. The value is
 * bound as a parameter (not interpolated) — `vector32` parses it into the
 * F32 blob. Finiteness is validated first so a NaN names its index.
 */
function vector32Literal(embedding: readonly number[], name: string): SQL {
  assertFiniteEmbedding(embedding, name);
  return sql`vector32(${`[${embedding.join(",")}]`})`;
}

function distanceExpression(
  embeddingColumn: SQL,
  queryEmbedding: readonly number[],
  metric: VectorMetric,
): SQL {
  const query = vector32Literal(queryEmbedding, "queryEmbedding");
  switch (metric) {
    case "cosine": {
      return sql`vector_distance_cos(${embeddingColumn}, ${query})`;
    }
    case "l2": {
      return sql`vector_distance_l2(${embeddingColumn}, ${query})`;
    }
    case "inner_product": {
      throw new Error(
        "libSQL vector search does not support inner_product. Use 'cosine' or 'l2'.",
      );
    }
    default: {
      const _exhaustive: never = metric;
      throw new Error(`Unsupported vector metric: ${String(_exhaustive)}`);
    }
  }
}

export const libsqlVectorStrategy: VectorStrategy = {
  name: "libsql-native",
  capabilities: LIBSQL_CAPABILITIES,

  tableName(graphId, nodeKind, fieldPath) {
    return vectorPhysicalName(TABLE_PREFIX, graphId, nodeKind, fieldPath);
  },

  ownedTables(slot): readonly StrategyTableContribution[] {
    const table = this.tableName(slot.graphId, slot.nodeKind, slot.fieldPath);
    const name = quoteIdentifier(table);

    // No standalone graph_id index: the PRIMARY KEY (graph_id, node_id) already
    // covers `WHERE graph_id = ?` via its leading column, so a separate index
    // would be pure write amplification.
    const createDdl = [
      `CREATE TABLE IF NOT EXISTS ${name} (
  "graph_id" TEXT NOT NULL,
  "node_id" TEXT NOT NULL,
  "embedding" F32_BLOB(${slot.dimensions}) NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  PRIMARY KEY ("graph_id", "node_id")
);`,
    ];

    if (usesAnnIndex(slot)) {
      // The DiskANN index DDL is deterministic raw SQL; fold it into the
      // contribution so materialization creates table + index together.
      createDdl.push(libsqlVectorIndexDdl(table, slot));
    }

    return [
      {
        logicalName: `${VECTOR_CONTRIBUTION_PREFIX}:${slot.nodeKind}.${slot.fieldPath}`,
        owner: "libsql-native",
        tableName: table,
        createDdl,
        runtimeEnsure: true,
      },
    ];
  },

  buildUpsert(slot, params: UpsertEmbeddingParams, timestamp): readonly SQL[] {
    const table = quotedTableName(
      this.tableName(slot.graphId, slot.nodeKind, slot.fieldPath),
    );
    const value = vector32Literal(params.embedding, "embedding");
    return [
      sql`
        INSERT INTO ${table} ("graph_id", "node_id", "embedding", "created_at", "updated_at")
        VALUES (${params.graphId}, ${params.nodeId}, ${value}, ${timestamp}, ${timestamp})
        ON CONFLICT ("graph_id", "node_id")
        DO UPDATE SET "embedding" = ${value}, "updated_at" = ${timestamp}
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
    const valueRows = sql.join(
      params.rows.map(
        (row) =>
          sql`(${params.graphId}, ${row.nodeId}, ${vector32Literal(row.embedding, "embedding")}, ${timestamp}, ${timestamp})`,
      ),
      sql`, `,
    );
    // `excluded."embedding"` reuses the row's already-converted F32_BLOB
    // value, so the multi-row form needs no per-row conversion in the
    // update arm (unlike buildUpsert's single bound value).
    return [
      sql`
        INSERT INTO ${table} ("graph_id", "node_id", "embedding", "created_at", "updated_at")
        VALUES ${valueRows}
        ON CONFLICT ("graph_id", "node_id")
        DO UPDATE SET "embedding" = excluded."embedding", "updated_at" = excluded."updated_at"
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
        WHERE "graph_id" = ${params.graphId} AND "node_id" = ${params.nodeId}
      `,
    ];
  },

  buildSearch(slot, params: VectorSearchParams): SQL {
    const table = this.tableName(slot.graphId, slot.nodeKind, slot.fieldPath);
    const quoted = quotedTableName(table);
    const embeddingColumn = sql`${quoted}."embedding"`;
    const distance = distanceExpression(
      embeddingColumn,
      params.queryEmbedding,
      params.metric,
    );
    const score = vectorScoreExpression(distance, params.metric);

    if (usesAnnIndex(slot)) {
      // DiskANN: vector_top_k returns rowids from the per-field table; join
      // back, then scope by graph and compute the real distance/score.
      // `vector_top_k` is table-global, so single-graph deployments are exact;
      // multi-graph recall is bounded by the over-fetched k (documented).
      const indexName = libsqlIndexName(slot);
      const query = vector32Literal(params.queryEmbedding, "queryEmbedding");
      const conditions: SQL[] = [sql`${quoted}."graph_id" = ${params.graphId}`];
      if (params.minScore !== undefined) {
        conditions.push(
          vectorMinScoreCondition(distance, params.metric, params.minScore),
        );
      }
      return sql`
        SELECT ${quoted}."node_id" AS node_id, ${score} AS score
        FROM vector_top_k(${indexName}, ${query}, ${params.limit})
        JOIN ${quoted} ON ${quoted}.rowid = id
        WHERE ${sql.join(conditions, sql` AND `)}
        ORDER BY ${distance} ASC
        LIMIT ${params.limit}
      `;
    }

    // Brute-force scan.
    const conditions: SQL[] = [sql`${quoted}."graph_id" = ${params.graphId}`];
    if (params.minScore !== undefined) {
      conditions.push(
        vectorMinScoreCondition(distance, params.metric, params.minScore),
      );
    }
    return sql`
      SELECT ${quoted}."node_id" AS node_id, ${score} AS score
      FROM ${quoted}
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY ${distance} ASC
      LIMIT ${params.limit}
    `;
  },

  distanceExpression(embeddingColumn, queryEmbedding, metric) {
    return distanceExpression(embeddingColumn, queryEmbedding, metric);
  },

  buildCreateIndex(slot): SQL | undefined {
    if (!usesAnnIndex(slot)) return undefined;
    return sql.raw(
      libsqlVectorIndexDdl(
        this.tableName(slot.graphId, slot.nodeKind, slot.fieldPath),
        slot,
      ),
    );
  },

  buildDropIndex(slot): SQL | undefined {
    if (!usesAnnIndex(slot)) return undefined;
    const indexName = libsqlIndexName(slot);
    return sql.raw(`DROP INDEX IF EXISTS ${quoteIdentifier(indexName)}`);
  },

  buildDropStorage(slot): readonly string[] {
    const table = quoteIdentifier(
      this.tableName(slot.graphId, slot.nodeKind, slot.fieldPath),
    );
    const statements: string[] = [];
    // Drop the DiskANN index first so libSQL reclaims its shadow tables,
    // then the table itself.
    if (usesAnnIndex(slot)) {
      statements.push(
        `DROP INDEX IF EXISTS ${quoteIdentifier(libsqlIndexName(slot))}`,
      );
    }
    statements.push(`DROP TABLE IF EXISTS ${table}`);
    return statements;
  },
};

function libsqlIndexName(slot: VectorSlot): string {
  return vectorPhysicalName(
    INDEX_PREFIX,
    slot.graphId,
    slot.nodeKind,
    slot.fieldPath,
  );
}

function libsqlVectorIndexDdl(table: string, slot: VectorSlot): string {
  const indexName = quoteIdentifier(libsqlIndexName(slot));
  const metric = libsqlMetricToken(slot.metric);
  return `CREATE INDEX IF NOT EXISTS ${indexName} ON ${quoteIdentifier(table)}(libsql_vector_idx("embedding", 'metric=${metric}'));`;
}
