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
 * `outputName` is the hidden result column the statement projects the key
 * under when the AST asks for it (`QueryAst.relevanceSortColumns`), so a
 * relation wrapping the statement can reproduce its order.
 */
export type RelevanceSortKey = Readonly<{
  source: RelevanceSortSource;
  direction: SortDirection;
  placement: "leading" | "trailing";
  outputName: string;
  valueType: "number" | "string";
}>;

const RELEVANCE_SORT_COLUMN_PREFIX = "__tg_relevance_";

function relevanceSortKey(
  source: RelevanceSortSource,
  index: number,
): RelevanceSortKey {
  const outputName = `${RELEVANCE_SORT_COLUMN_PREFIX}${index}`;
  switch (source) {
    case "fulltext_rank":
    case "hybrid_score": {
      return {
        source,
        direction: "desc",
        placement: "leading",
        outputName,
        valueType: "number",
      };
    }
    case "vector_distance": {
      return {
        source,
        direction: "asc",
        placement: "leading",
        outputName,
        valueType: "number",
      };
    }
    case "hybrid_node_id": {
      return {
        source,
        direction: "asc",
        placement: "trailing",
        outputName,
        valueType: "string",
      };
    }
  }
}

/**
 * The relevance sort keys of the statement `ast` compiles to, in order; empty
 * for a statement without a full-text or vector predicate. The one owner of
 * "this statement is ordered by relevance": the compiler's ORDER BY, the
 * hidden relevance columns, the traversal-limit pushdown and the relation
 * adapters that wrap a search statement all read it.
 */
export function describeRelevanceOrder(
  ast: QueryAst,
): readonly RelevanceSortKey[] {
  const vector = extractVectorSimilarityPredicates(ast.predicates).length > 0;
  const fulltext = extractFulltextMatchPredicates(ast.predicates).length > 0;
  return relevanceSortSources(vector, fulltext).map((source, index) =>
    relevanceSortKey(source, index),
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
