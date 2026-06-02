/**
 * pgvector strategy.
 *
 * Postgres' pgvector extension is the one engine where the *same* SQL serves
 * brute-force and ANN: `ORDER BY embedding <=> q LIMIT k` scans sequentially
 * with no index and is rewritten to an HNSW/IVFFlat scan the moment a matching
 * index exists — the planner picks it up automatically. So `buildSearch` never
 * branches on `slot.indexType`; it emits one relevance scan and lets Postgres
 * decide. (Contrast libSQL/sqlite-vec, whose ANN needs distinct syntax.)
 *
 * Storage is per-`(nodeKind, fieldPath)`: a `vector(N)` column carrying the
 * field's fixed dimension `N`, with the operator-class-typed ANN index folded
 * into the same table contribution so materialization builds table + index
 * together. The typed column means the index does not need the legacy
 * `::vector(N)` cast-in-index escape hatch the old shared table relied on.
 *
 * Metric support is the full pgvector set — `cosine`, `l2`, `inner_product` —
 * advertised as data on `capabilities`, mirroring `vector_cosine_ops` /
 * `vector_l2_ops` / `vector_ip_ops` and the `<=>` / `<->` / `<#>` operators.
 *
 * Mirrors the `libsqlVectorStrategy` / `sqliteVecStrategy` structure while
 * letting Postgres' planner pick the ANN index when one exists.
 */
import { type SQL, sql } from "drizzle-orm";

import { formatVector } from "../../../backend/drizzle/columns/vector";
import { quotedTableName } from "../../../backend/drizzle/operations/shared";
import { type StrategyTableContribution } from "../../../backend/table-contribution";
import {
  type DeleteEmbeddingParams,
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

/** Physical-name prefixes for the per-field table and its ANN index. */
const TABLE_PREFIX = "tg_vec";
const INDEX_PREFIX = "tg_vecidx";

/**
 * pgvector defines `hnsw.ef_search` as an integer GUC with a valid range
 * of 1..1000; `SET hnsw.ef_search = 1001` errors at the server. The
 * backend validates a per-search `efSearch` against this ceiling before
 * inlining it into `SET LOCAL`, surfacing a clear message instead of a raw
 * pgvector error.
 */
export const MAX_HNSW_EF_SEARCH = 1000;

/**
 * Validates a per-search `efSearch` override against pgvector's
 * `hnsw.ef_search` valid range. `undefined` (no override) is accepted.
 */
export function assertPgvectorEfSearch(efSearch?: number): void {
  if (efSearch === undefined) return;
  if (!Number.isInteger(efSearch) || efSearch <= 0) {
    throw new Error(`efSearch must be a positive integer, got: ${efSearch}`);
  }
  if (efSearch > MAX_HNSW_EF_SEARCH) {
    throw new RangeError(
      `efSearch must be ≤ ${MAX_HNSW_EF_SEARCH} (pgvector's hnsw.ef_search ` +
        `valid range is 1..${MAX_HNSW_EF_SEARCH}), got: ${efSearch}`,
    );
  }
}

/**
 * pgvector's `vector` type caps at 16,000 dimensions for a stored column
 * (2,000 for an indexed column, but the column-type ceiling is what governs
 * storage; recall degradation beyond 2,000 is a tuning concern, not a hard
 * limit advertised here).
 */
const PGVECTOR_MAX_DIMENSIONS = 16_000;

/** Default HNSW `m` (max connections per layer) — pgvector's own default. */
const DEFAULT_HNSW_M = 16;
/** Default HNSW `ef_construction` (build candidate list) — pgvector's own default. */
const DEFAULT_HNSW_EF_CONSTRUCTION = 64;
/** Default IVFFlat `lists` (inverted lists) — pgvector's own default. */
const DEFAULT_IVFFLAT_LISTS = 100;

const PGVECTOR_CAPABILITIES: VectorCapabilities = {
  supported: true,
  metrics: ["cosine", "l2", "inner_product"],
  indexTypes: ["hnsw", "ivfflat", "none"],
  maxDimensions: PGVECTOR_MAX_DIMENSIONS,
};

/** Whether a slot's declared index type materializes a real pgvector ANN index. */
function usesAnnIndex(slot: VectorSlot): boolean {
  return slot.indexType === "hnsw" || slot.indexType === "ivfflat";
}

/**
 * pgvector operator class for a metric's ANN index — `vector_cosine_ops` /
 * `vector_l2_ops` / `vector_ip_ops`, mirroring the `<=>` / `<->` / `<#>`
 * distance operators this strategy emits.
 */
function operatorClass(metric: VectorMetric): string {
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
    default: {
      const _exhaustive: never = metric;
      throw new Error(`Unsupported vector metric: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Formats an embedding as a `::vector` literal. The value is bound as a
 * parameter (not interpolated) — Postgres parses the `[a,b,c]` text and the
 * cast types it. Finiteness is validated first so a NaN names its index.
 */
function vectorLiteral(embedding: readonly number[], name: string): SQL {
  assertFiniteEmbedding(embedding, name);
  return sql`${formatVector(embedding)}::vector`;
}

function distanceExpression(
  embeddingColumn: SQL,
  queryEmbedding: readonly number[],
  metric: VectorMetric,
): SQL {
  const query = vectorLiteral(queryEmbedding, "queryEmbedding");
  switch (metric) {
    case "cosine": {
      return sql`(${embeddingColumn} <=> ${query})`;
    }
    case "l2": {
      return sql`(${embeddingColumn} <-> ${query})`;
    }
    case "inner_product": {
      return sql`(${embeddingColumn} <#> ${query})`;
    }
    default: {
      const _exhaustive: never = metric;
      throw new Error(`Unsupported vector metric: ${String(_exhaustive)}`);
    }
  }
}

export const pgvectorStrategy: VectorStrategy = {
  name: "pgvector",
  capabilities: PGVECTOR_CAPABILITIES,

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
  "embedding" vector(${slot.dimensions}) NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL,
  PRIMARY KEY ("graph_id", "node_id")
);`,
    ];

    // The HNSW/IVFFlat index is intentionally NOT created here. pgvector
    // similarity SQL is planner-driven (`ORDER BY embedding <=> q LIMIT k`
    // uses the index when present, sequential-scans when not), so the index
    // is a pure materialization concern: `buildCreateIndex` builds it through
    // `materializeIndexes()` with the field's declared `m`/`ef_construction`/
    // `lists`. Building it eagerly here would bake in default tuning (the
    // write-ensure slot has no `indexParams`) and `CREATE INDEX IF NOT EXISTS`
    // would then mask the tuned index materialization would emit.

    return [
      {
        logicalName: `${VECTOR_CONTRIBUTION_PREFIX}:${slot.nodeKind}.${slot.fieldPath}`,
        owner: "pgvector",
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
    const value = vectorLiteral(params.embedding, "embedding");
    return [
      sql`
        INSERT INTO ${table} ("graph_id", "node_id", "embedding", "created_at", "updated_at")
        VALUES (${params.graphId}, ${params.nodeId}, ${value}, ${timestamp}, ${timestamp})
        ON CONFLICT ("graph_id", "node_id")
        DO UPDATE SET "embedding" = EXCLUDED."embedding", "updated_at" = EXCLUDED."updated_at"
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

    // Same SQL for brute-force and ANN: with a matching HNSW/IVFFlat index the
    // Postgres planner rewrites this `ORDER BY distance LIMIT k` into an index
    // scan automatically, so the strategy never branches on `slot.indexType`.
    const conditions: SQL[] = [sql`${table}."graph_id" = ${params.graphId}`];
    if (params.minScore !== undefined) {
      conditions.push(
        vectorMinScoreCondition(distance, params.metric, params.minScore),
      );
    }
    return sql`
      SELECT ${table}."node_id" AS node_id, ${score} AS score
      FROM ${table}
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY ${distance} ASC
      LIMIT ${params.limit}
    `;
  },

  distanceExpression(embeddingColumn, queryEmbedding, metric) {
    return distanceExpression(embeddingColumn, queryEmbedding, metric);
  },

  buildCreateIndex(slot, options): SQL | undefined {
    if (!usesAnnIndex(slot)) return undefined;
    return sql.raw(
      pgvectorIndexDdl(
        this.tableName(slot.graphId, slot.nodeKind, slot.fieldPath),
        slot,
        options?.concurrent === true,
      ),
    );
  },

  buildDropIndex(slot): SQL | undefined {
    if (!usesAnnIndex(slot)) return undefined;
    const indexName = pgvectorIndexName(slot);
    return sql.raw(`DROP INDEX IF EXISTS ${quoteIdentifier(indexName)}`);
  },

  buildDropStorage(slot): readonly string[] {
    const table = quoteIdentifier(
      this.tableName(slot.graphId, slot.nodeKind, slot.fieldPath),
    );
    // CASCADE drops the ANN index along with the table.
    return [`DROP TABLE IF EXISTS ${table} CASCADE`];
  },
};

function pgvectorIndexName(slot: VectorSlot): string {
  return vectorPhysicalName(
    INDEX_PREFIX,
    slot.graphId,
    slot.nodeKind,
    slot.fieldPath,
  );
}

function pgvectorIndexDdl(
  table: string,
  slot: VectorSlot,
  concurrent: boolean,
): string {
  const indexName = quoteIdentifier(pgvectorIndexName(slot));
  const quotedTable = quoteIdentifier(table);
  const opClass = operatorClass(slot.metric);
  // Honor the field's declared tuning; fall back to pgvector defaults.
  const m = slot.indexParams?.m ?? DEFAULT_HNSW_M;
  const efConstruction =
    slot.indexParams?.efConstruction ?? DEFAULT_HNSW_EF_CONSTRUCTION;
  const lists = slot.indexParams?.lists ?? DEFAULT_IVFFLAT_LISTS;
  // CONCURRENTLY builds without taking a write-blocking lock on the live table
  // (materializeIndexes passes concurrent on Postgres). Run outside a tx.
  const create = `CREATE INDEX${concurrent ? " CONCURRENTLY" : ""} IF NOT EXISTS`;

  switch (slot.indexType) {
    case "hnsw": {
      return `${create} ${indexName} ON ${quotedTable} USING hnsw ("embedding" ${opClass}) WITH (m = ${m}, ef_construction = ${efConstruction});`;
    }
    case "ivfflat": {
      return `${create} ${indexName} ON ${quotedTable} USING ivfflat ("embedding" ${opClass}) WITH (lists = ${lists});`;
    }
    case "none": {
      throw new Error(
        "pgvectorIndexDdl called for a brute-force-only slot (indexType 'none').",
      );
    }
    default: {
      const _exhaustive: never = slot.indexType;
      throw new Error(`Unsupported vector index type: ${String(_exhaustive)}`);
    }
  }
}
