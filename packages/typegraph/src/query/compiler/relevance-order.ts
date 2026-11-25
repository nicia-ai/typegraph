import type { QueryAst, SortDirection } from "../ast";
import {
  extractFulltextMatchPredicates,
  extractVectorSimilarityPredicates,
} from "./predicates";

/**
 * Which per-match value a relevance sort key reads:
 * - `fulltext_rank`: the full-text engine's native rank (higher is better)
 * - `vector_distance`: the vector distance (lower is better)
 * - `hybrid_score`: the reciprocal-rank-fusion score of both legs
 * - `hybrid_node_id`: the matched node's id, the hybrid tiebreak
 */
export type RelevanceSortSource =
  "fulltext_rank" | "vector_distance" | "hybrid_score" | "hybrid_node_id";

/**
 * One term of the relevance ORDER BY a full-text, vector or hybrid statement
 * appends. `placement` says whether the term precedes the caller's
 * `orderBy()` terms (`leading`) or breaks the ties they leave (`trailing`).
 */
export type RelevanceSortKey = Readonly<{
  source: RelevanceSortSource;
  direction: SortDirection;
  placement: "leading" | "trailing";
}>;

function relevanceSortKey(source: RelevanceSortSource): RelevanceSortKey {
  switch (source) {
    case "fulltext_rank":
    case "hybrid_score": {
      return { source, direction: "desc", placement: "leading" };
    }
    case "vector_distance": {
      return { source, direction: "asc", placement: "leading" };
    }
    case "hybrid_node_id": {
      return { source, direction: "asc", placement: "trailing" };
    }
  }
}

/**
 * The relevance sort keys of the statement `ast` compiles to, in order; empty
 * for a statement without a full-text or vector predicate. The one owner of
 * "this statement is ordered by relevance": the compiler's ORDER BY and the
 * traversal-limit pushdown both read it.
 */
export function describeRelevanceOrder(
  ast: QueryAst,
): readonly RelevanceSortKey[] {
  const vector = extractVectorSimilarityPredicates(ast.predicates).length > 0;
  const fulltext = extractFulltextMatchPredicates(ast.predicates).length > 0;
  return relevanceSortSources(vector, fulltext).map((source) =>
    relevanceSortKey(source),
  );
}

function relevanceSortSources(
  vector: boolean,
  fulltext: boolean,
): readonly RelevanceSortSource[] {
  if (vector && fulltext) return ["hybrid_score", "hybrid_node_id"];
  if (vector) return ["vector_distance"];
  if (fulltext) return ["fulltext_rank"];
  return [];
}

/**
 * The column a relevance-ordered statement compiled for a wrapping statement
 * carries the rank of its own ORDER BY in (`buildStandardSelectionOrderColumn`).
 * It is in the reserved `__tg` namespace, which no caller's output key may use.
 */
export const SELECTION_ORDER_COLUMN = "__tg_selection_order";
