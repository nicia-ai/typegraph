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
 * statement identical across dialects. The fused CTE is MATERIALIZED — a
 * fence, not a hint: Postgres inlines single-use CTEs, and the inlined
 * fusion subtree re-executed once per candidate node row under a
 * nested-loop join (2000x in the regression that motivated this).
 */
import { type SQL, sql } from "drizzle-orm";

import { type SqlDialect } from "../../../query/dialect/types";
import { coerceNumericScore } from "../../row-mappers";
import { type HybridSearchRow, type NodeRow } from "../../types";
import { codePointOrderKey, quotedColumn, type Tables } from "./shared";

/**
 * The `node_id` tiebreak this statement uses three times: once in each
 * per-source `ROW_NUMBER()` rank, and once in the final fused ordering. Those
 * ranks *produce* the fused scores, so the tiebreak decides the page twice
 * over. Code-point ordered on both engines (see {@link codePointOrderKey}) so
 * it matches the multi-statement fallback's JS fusion row for row.
 */
function nodeIdOrderKey(dialect: SqlDialect): SQL {
  return codePointOrderKey(sql.raw("node_id"), dialect);
}

export type HybridStatementInput = Readonly<{
  /**
   * The candidates set (liveness/currency filter, or the store-compiled
   * predicate query): `(node_id)` rows. Emitted ONCE as the
   * `tg_hybrid_cand` CTE; both source legs must reference it via
   * {@link hybridCandidatesRef} instead of embedding their own copy —
   * previously each leg re-executed the candidates subquery (with two
   * separate `nowIso()` stamps for the currency window, no less).
   */
  candidatesSql: SQL;
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
  /** Selects the collation-independent `node_id` tiebreak. */
  dialect: SqlDialect;
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
/**
 * The reference the vector/fulltext source legs embed in place of the
 * candidates subquery (their strategies emit `node_id IN (<this>)`).
 * Valid only inside {@link buildHybridSearchStatement}, which defines
 * the `tg_hybrid_cand` CTE first in its WITH list — CTEs are visible to
 * later members on both dialects, and a CTE referenced from both legs
 * is evaluated once.
 */
export function hybridCandidatesRef(): SQL {
  return sql`SELECT node_id FROM tg_hybrid_cand`;
}

export function buildHybridSearchStatement(input: HybridStatementInput): SQL {
  const { nodes } = input;
  const nodeIdOrder = nodeIdOrderKey(input.dialect);
  const vectorOrder =
    input.vectorScoreDescending ?
      sql`score DESC, ${nodeIdOrder} ASC`
    : sql`score ASC, ${nodeIdOrder} ASC`;

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
    WITH tg_hybrid_cand AS (
      SELECT node_id FROM (${input.candidatesSql}) AS tg_hybrid_cand_src
    ),
    tg_hybrid_vec AS (
      SELECT node_id, score,
             ROW_NUMBER() OVER (ORDER BY ${vectorOrder}) AS ord
      FROM (${input.vectorSql}) AS tg_hybrid_vec_src
    ),
    tg_hybrid_fts AS (
      SELECT node_id, score, snippet,
             ROW_NUMBER() OVER (ORDER BY score DESC, ${nodeIdOrder} ASC) AS ord
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
    tg_hybrid_fused AS MATERIALIZED (
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
    ORDER BY fused_score DESC, ${nodeIdOrder} ASC
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
    fusedScore: coerceNumericScore(row["fused_score"] as number | string),
    ...(present(row["vector_rank"]) ?
      { vectorRank: Number(row["vector_rank"]) }
    : {}),
    ...(present(row["vector_score"]) ?
      { vectorScore: coerceNumericScore(row["vector_score"] as number | string) }
    : {}),
    ...(present(row["fulltext_rank"]) ?
      { fulltextRank: Number(row["fulltext_rank"]) }
    : {}),
    ...(present(row["fulltext_score"]) ?
      {
        fulltextScore: coerceNumericScore(
          row["fulltext_score"] as number | string,
        ),
      }
    : {}),
    ...(present(row["snippet"]) ? { snippet: String(row["snippet"]) } : {}),
  };
}
