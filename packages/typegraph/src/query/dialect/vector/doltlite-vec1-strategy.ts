import { ConfigurationError } from "../../../errors";
import { sql, type SqlFragment } from "../../sql-fragment";
import {
  assertFiniteEmbedding,
  quoteIdentifier,
  VECTOR_CONTRIBUTION_PREFIX,
  vectorMinScoreCondition,
  vectorPhysicalName,
  vectorScoreExpression,
  type VectorStrategy,
} from "../vector-strategy";
import { vectorPageClause } from "./pagination";

function float32Blob(values: readonly number[]): Uint8Array {
  assertFiniteEmbedding(values, "embedding");
  const floats = new Float32Array(values);
  assertFiniteEmbedding([...floats], "float32 embedding");
  return new Uint8Array(floats.buffer);
}

function tableName(graphId: string, kind: string, field: string): string {
  return vectorPhysicalName("tg_vec1", graphId, kind, field);
}

export const doltliteVec1Strategy: VectorStrategy = {
  name: "doltlite-vec1-exact",
  capabilities: {
    supported: true,
    metrics: ["cosine", "l2"],
    indexTypes: ["none"],
    maxDimensions: 8000,
    filteredApproximateSearch: {
      mode: "filter-pushdown",
      guaranteesFullPage: true,
    },
    searchFrontierTuning: {
      tunable: false,
      reason: "Exact vec1 distance scans have no ANN frontier",
    },
  },
  tableName,
  searchIsExact: true,
  ownedTables(slot) {
    if (slot.indexType !== "none")
      throw new ConfigurationError(
        "DoltLite vec1 supports exact vector scans; declare index type none",
      );
    const name = tableName(slot.graphId, slot.nodeKind, slot.fieldPath);
    return [
      {
        scope: "graph",
        owner: "doltlite-vec1-exact",
        logicalName: `${VECTOR_CONTRIBUTION_PREFIX}:${slot.nodeKind}.${slot.fieldPath}`,
        tableName: name,
        runtimeEnsure: true,
        createDdl: [
          `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(name)} (
        node_id TEXT PRIMARY KEY NOT NULL,
        graph_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        embedding BLOB NOT NULL CHECK (length(embedding) = ${slot.dimensions * 4})
      )`,
        ],
      },
    ];
  },
  buildUpsert(slot, params, timestamp) {
    const table = sql.identifier(
      tableName(slot.graphId, slot.nodeKind, slot.fieldPath),
    );
    return [
      sql`
        INSERT INTO ${table} (node_id,graph_id,created_at,updated_at,embedding)
              VALUES (${params.nodeId},${params.graphId},${timestamp},${timestamp},${float32Blob(params.embedding)})
              ON CONFLICT(node_id) DO UPDATE SET embedding = excluded.embedding, updated_at = excluded.updated_at
      `,
    ];
  },
  buildDelete(slot, params) {
    return [
      sql`
        DELETE FROM ${sql.identifier(tableName(slot.graphId, slot.nodeKind, slot.fieldPath))}
              WHERE graph_id = ${params.graphId} AND node_id = ${params.nodeId}
      `,
    ];
  },
  buildDeleteBatch(slot, params) {
    if (params.nodeIds.length === 0) return [];
    return [
      sql`
        DELETE FROM ${sql.identifier(tableName(slot.graphId, slot.nodeKind, slot.fieldPath))}
              WHERE graph_id = ${params.graphId} AND node_id IN (${sql.join(
                params.nodeIds.map((id) => sql`${id}`),
                sql`, `,
              )})
      `,
    ];
  },
  distanceExpression(column, query, metric) {
    const value = float32Blob(query);
    if (metric === "cosine") return sql`vec1_cos_distance(${column},${value})`;
    // vec1 returns SQUARED L2; the portable contract is Euclidean distance.
    if (metric === "l2") return sql`sqrt(vec1_l2_distance(${column},${value}))`;
    throw new ConfigurationError(
      "DoltLite vec1 does not support inner_product",
    );
  },
  buildSearch(slot, params, candidates) {
    const table = sql.identifier(
      tableName(slot.graphId, slot.nodeKind, slot.fieldPath),
    );
    const distance = doltliteVec1Strategy.distanceExpression(
      sql`${table}.embedding`,
      params.queryEmbedding,
      params.metric,
    );
    const conditions: SqlFragment[] = [
      sql`${table}.graph_id = ${params.graphId}`,
    ];
    if (candidates !== undefined)
      conditions.push(sql`${table}.node_id IN (${candidates})`);
    if (params.minScore !== undefined)
      conditions.push(
        vectorMinScoreCondition(distance, params.metric, params.minScore),
      );
    return sql`
      SELECT ${table}.node_id AS node_id, ${vectorScoreExpression(distance, params.metric)} AS score
            FROM ${table} WHERE ${sql.join(conditions, sql` AND `)}
            ORDER BY ${distance} ASC, ${table}.node_id ASC ${vectorPageClause(params.limit, params.offset)}
    `;
  },
  buildDropStorage(slot) {
    return [
      `DROP TABLE IF EXISTS ${quoteIdentifier(tableName(slot.graphId, slot.nodeKind, slot.fieldPath))}`,
    ];
  },
};
