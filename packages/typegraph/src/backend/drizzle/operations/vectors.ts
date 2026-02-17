import { type SQL, sql } from "drizzle-orm";

import type {
  DeleteEmbeddingParams,
  UpsertEmbeddingParams,
  VectorMetric,
  VectorSearchParams,
} from "../../types";
import type { PostgresTables } from "../schema/postgres";
import type { Tables } from "./shared";

/**
 * Validates that all values in an array are finite numbers.
 * Throws if any value is NaN, Infinity, or not a number.
 */
function assertFiniteNumberArray(array: readonly number[], name: string): void {
  for (const [index, value] of array.entries()) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError(
        `${name}[${index}] must be a finite number, got: ${value}`,
      );
    }
  }
}

/**
 * Formats an embedding array as a pgvector literal string.
 * Validates all values are finite numbers first.
 */
function formatEmbeddingLiteral(embedding: readonly number[]): string {
  assertFiniteNumberArray(embedding, "embedding");
  return `[${embedding.join(",")}]`;
}

/**
 * Builds an UPSERT query for an embedding (PostgreSQL).
 * Uses ON CONFLICT to update existing embeddings.
 */
export function buildUpsertEmbeddingPostgres(
  tables: PostgresTables,
  params: UpsertEmbeddingParams,
  timestamp: string,
): SQL {
  const { embeddings } = tables;
  const embeddingLiteral = formatEmbeddingLiteral(params.embedding);

  const columns = sql.raw(
    `"${embeddings.graphId.name}", "${embeddings.nodeKind.name}", "${embeddings.nodeId.name}", "${embeddings.fieldPath.name}", "${embeddings.embedding.name}", "${embeddings.dimensions.name}", "${embeddings.createdAt.name}", "${embeddings.updatedAt.name}"`,
  );

  const conflictColumns = sql.raw(
    `"${embeddings.graphId.name}", "${embeddings.nodeKind.name}", "${embeddings.nodeId.name}", "${embeddings.fieldPath.name}"`,
  );

  const column = (target: { name: string }) => sql.raw(`"${target.name}"`);

  return sql`
    INSERT INTO ${embeddings} (${columns})
    VALUES (
      ${params.graphId}, ${params.nodeKind}, ${params.nodeId}, ${params.fieldPath},
      ${embeddingLiteral}::vector, ${params.dimensions}, ${timestamp}, ${timestamp}
    )
    ON CONFLICT (${conflictColumns})
    DO UPDATE SET
      ${column(embeddings.embedding)} = ${embeddingLiteral}::vector,
      ${column(embeddings.dimensions)} = ${params.dimensions},
      ${column(embeddings.updatedAt)} = ${timestamp}
  `;
}

/**
 * Builds a DELETE query for an embedding.
 */
export function buildDeleteEmbedding(
  tables: Tables,
  params: DeleteEmbeddingParams,
): SQL {
  const { embeddings } = tables;

  return sql`
    DELETE FROM ${embeddings}
    WHERE ${embeddings.graphId} = ${params.graphId}
      AND ${embeddings.nodeKind} = ${params.nodeKind}
      AND ${embeddings.nodeId} = ${params.nodeId}
      AND ${embeddings.fieldPath} = ${params.fieldPath}
  `;
}

/**
 * Builds a SELECT query to get an embedding.
 */
export function buildGetEmbedding(
  tables: Tables,
  graphId: string,
  nodeKind: string,
  nodeId: string,
  fieldPath: string,
): SQL {
  const { embeddings } = tables;

  return sql`
    SELECT * FROM ${embeddings}
    WHERE ${embeddings.graphId} = ${graphId}
      AND ${embeddings.nodeKind} = ${nodeKind}
      AND ${embeddings.nodeId} = ${nodeId}
      AND ${embeddings.fieldPath} = ${fieldPath}
  `;
}

/**
 * Builds the distance expression for a given metric.
 * Uses parameterized embedding literal to prevent SQL injection.
 */
function buildDistanceExpression(
  embeddingColumn: SQL,
  queryLiteral: string,
  metric: VectorMetric,
): SQL {
  const vectorParameter = sql`${queryLiteral}::vector`;

  switch (metric) {
    case "cosine": {
      return sql`(${embeddingColumn} <=> ${vectorParameter})`;
    }
    case "l2": {
      return sql`(${embeddingColumn} <-> ${vectorParameter})`;
    }
    case "inner_product": {
      return sql`(${embeddingColumn} <#> ${vectorParameter})`;
    }
    default: {
      const _exhaustive: never = metric;
      throw new Error(`Unsupported vector metric: ${String(_exhaustive)}`);
    }
  }
}

function buildVectorSearchScoreExpression(
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

function buildVectorSearchMinScoreCondition(
  distanceExpression: SQL,
  metric: VectorMetric,
  minScore: number,
): SQL {
  switch (metric) {
    case "cosine": {
      const threshold = 1 - minScore;
      return sql`${distanceExpression} <= ${threshold}`;
    }
    case "l2": {
      return sql`${distanceExpression} <= ${minScore}`;
    }
    case "inner_product": {
      const negativeThreshold = -minScore;
      return sql`${distanceExpression} <= ${negativeThreshold}`;
    }
    default: {
      const _exhaustive: never = metric;
      throw new Error(`Unsupported vector metric: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Builds a vector similarity search query (PostgreSQL).
 * Returns node IDs ordered by similarity (closest first).
 */
export function buildVectorSearchPostgres(
  tables: PostgresTables,
  params: VectorSearchParams,
): SQL {
  const { embeddings } = tables;
  const queryLiteral = formatEmbeddingLiteral(params.queryEmbedding);

  if (params.minScore !== undefined && !Number.isFinite(params.minScore)) {
    throw new TypeError(
      `minScore must be a finite number, got: ${params.minScore}`,
    );
  }

  if (!Number.isInteger(params.limit) || params.limit <= 0) {
    throw new Error(`limit must be a positive integer, got: ${params.limit}`);
  }

  const embeddingColumn = sql`${embeddings.embedding}`;
  const distanceExpression = buildDistanceExpression(
    embeddingColumn,
    queryLiteral,
    params.metric,
  );

  const conditions = [
    sql`${embeddings.graphId} = ${params.graphId}`,
    sql`${embeddings.nodeKind} = ${params.nodeKind}`,
    sql`${embeddings.fieldPath} = ${params.fieldPath}`,
  ];

  if (params.minScore !== undefined) {
    conditions.push(
      buildVectorSearchMinScoreCondition(
        distanceExpression,
        params.metric,
        params.minScore,
      ),
    );
  }

  const whereClause = sql.join(conditions, sql` AND `);
  const scoreExpression = buildVectorSearchScoreExpression(
    distanceExpression,
    params.metric,
  );

  return sql`
    SELECT
      ${embeddings.nodeId} as node_id,
      ${scoreExpression} as score
    FROM ${embeddings}
    WHERE ${whereClause}
    ORDER BY ${distanceExpression} ASC
    LIMIT ${params.limit}
  `;
}
