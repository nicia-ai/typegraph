/**
 * Single-statement hybrid search: composes a vector source (the active
 * `VectorStrategy`'s search SQL) and a fulltext source (the shared
 * `buildFulltextSearch` SQL) into one statement that ranks each source,
 * fuses via weighted Reciprocal Rank Fusion, joins live node rows for
 * hydration, and pages the fused ranking — replacing the facade's two
 * search round trips plus id-hydration fetch with one round trip.
 *
 * Fusion math matches the store's JS implementation exactly:
 * `score = Σ_src weight_src / (fusionK + rank_src)`, ranked descending,
 * ties broken by node id. Ranks are per-source `ROW_NUMBER()` over the
 * source's own ordering (score, direction per metric convention), so the
 * statement requires window functions — backends whose capability profile
 * disables them fall back to the multi-statement path.
 *
 * The two-branch `UNION ALL` + `GROUP BY` fusion shape is deliberate: it
 * needs no FULL OUTER JOIN (absent from older SQLite builds) and keeps the
 * statement identical across dialects.
 */
import { type SQL, sql } from "drizzle-orm";

import { type HybridSearchRow, type NodeRow } from "../../types";
import { coerceNumericScore } from "../row-mappers";
import { quotedColumn, type Tables } from "./shared";

export type HybridStatementInput = Readonly<{
  /** Vector source SQL: `(node_id, score)` ordered best-first, bounded. */
  vectorSql: SQL;
  /**
   * Whether higher vector scores rank first (cosine similarity) or lower
   * (l2 / inner_product raw distance) — must match the source ordering.
   */
  vectorScoreDescending: boolean;
  /** Fulltext source SQL: `(node_id, score, snippet)`, score-descending. */
  fulltextSql: SQL;
  nodes: Tables["nodes"];
  graphId: string;
  nodeKind: string;
  fusionK: number;
  vectorWeight: number;
  fulltextWeight: number;
  limit: number;
  offset: number;
}>;

/**
 * The raw column shape the statement returns: fusion fields plus the full
 * node row (aliased to the mapper's expected column names). `node_id`
 * (fusion side) and `id` (node side) intentionally coexist.
 */
export function buildHybridSearchStatement(input: HybridStatementInput): SQL {
  const { nodes } = input;
  const vectorOrder =
    input.vectorScoreDescending ?
      sql.raw("score DESC, node_id ASC")
    : sql.raw("score ASC, node_id ASC");

  const columnPairs: readonly (readonly [{ name: string }, string])[] = [
    [nodes.graphId, "graph_id"],
    [nodes.kind, "kind"],
    [nodes.id, "id"],
    [nodes.props, "props"],
    [nodes.version, "version"],
    [nodes.validFrom, "valid_from"],
    [nodes.validTo, "valid_to"],
    [nodes.createdAt, "created_at"],
    [nodes.updatedAt, "updated_at"],
    [nodes.deletedAt, "deleted_at"],
  ];
  const nodeColumns = sql.raw(
    columnPairs
      .map(
        ([column, alias]) =>
          `tg_hybrid_node."${column.name.replaceAll('"', '""')}" AS ${alias}`,
      )
      .join(", "),
  );

  // `* 1.0` forces float division: with integer binds, Postgres would
  // otherwise evaluate `weight / (k + rank)` in integer arithmetic and
  // collapse every contribution to zero.
  return sql`
    WITH tg_hybrid_vec AS (
      SELECT node_id, score,
             ROW_NUMBER() OVER (ORDER BY ${vectorOrder}) AS ord
      FROM (${input.vectorSql}) AS tg_hybrid_vec_src
    ),
    tg_hybrid_fts AS (
      SELECT node_id, score, snippet,
             ROW_NUMBER() OVER (ORDER BY score DESC, node_id ASC) AS ord
      FROM (${input.fulltextSql}) AS tg_hybrid_fts_src
    ),
    tg_hybrid_pairs AS (
      SELECT node_id, ord AS vector_rank, score AS vector_score,
             NULL AS fulltext_rank, NULL AS fulltext_score, NULL AS snippet
      FROM tg_hybrid_vec
      UNION ALL
      SELECT node_id, NULL, NULL, ord, score, snippet
      FROM tg_hybrid_fts
    ),
    tg_hybrid_fused AS (
      SELECT node_id,
        SUM(
          COALESCE((${input.vectorWeight} * 1.0) / (${input.fusionK} + vector_rank), 0)
          + COALESCE((${input.fulltextWeight} * 1.0) / (${input.fusionK} + fulltext_rank), 0)
        ) AS fused_score,
        MAX(vector_rank) AS vector_rank,
        MAX(vector_score) AS vector_score,
        MAX(fulltext_rank) AS fulltext_rank,
        MAX(fulltext_score) AS fulltext_score,
        MAX(snippet) AS snippet
      FROM tg_hybrid_pairs
      GROUP BY node_id
    )
    SELECT
      tg_hybrid_fused.node_id AS node_id,
      tg_hybrid_fused.fused_score AS fused_score,
      tg_hybrid_fused.vector_rank AS vector_rank,
      tg_hybrid_fused.vector_score AS vector_score,
      tg_hybrid_fused.fulltext_rank AS fulltext_rank,
      tg_hybrid_fused.fulltext_score AS fulltext_score,
      tg_hybrid_fused.snippet AS snippet,
      ${nodeColumns}
    FROM tg_hybrid_fused
    JOIN ${nodes} AS tg_hybrid_node
      ON ${qualified(nodes, "graphId")} = ${input.graphId}
     AND ${qualified(nodes, "kind")} = ${input.nodeKind}
     AND ${qualified(nodes, "id")} = tg_hybrid_fused.node_id
     AND ${qualified(nodes, "deletedAt")} IS NULL
    ORDER BY fused_score DESC, node_id ASC
    LIMIT ${input.limit} OFFSET ${input.offset}
  `;
}

function qualified(
  nodes: Tables["nodes"],
  member: "graphId" | "kind" | "id" | "deletedAt",
): SQL {
  return sql`tg_hybrid_node.${quotedColumn(nodes[member])}`;
}

function present(value: unknown): boolean {
  return value !== null && value !== undefined;
}

/**
 * Maps one raw statement row into a {@link HybridSearchRow}. Rank columns
 * come from `ROW_NUMBER()` (bigint — node-postgres hands int8 back as a
 * string) and scores from engine-native rank math (Postgres `numeric`
 * can arrive as a string), so both coerce defensively.
 */
export function mapHybridSearchRow(
  row: Record<string, unknown>,
  toNodeRow: (raw: Record<string, unknown>) => NodeRow,
): HybridSearchRow {
  return {
    node: toNodeRow(row),
    fusedScore: coerceNumericScore(row.fused_score as number | string),
    ...(present(row.vector_rank) ?
      { vectorRank: Number(row.vector_rank) }
    : {}),
    ...(present(row.vector_score) ?
      { vectorScore: coerceNumericScore(row.vector_score as number | string) }
    : {}),
    ...(present(row.fulltext_rank) ?
      { fulltextRank: Number(row.fulltext_rank) }
    : {}),
    ...(present(row.fulltext_score) ?
      {
        fulltextScore: coerceNumericScore(
          row.fulltext_score as number | string,
        ),
      }
    : {}),
    ...(present(row.snippet) ? { snippet: String(row.snippet) } : {}),
  };
}
