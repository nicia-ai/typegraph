import type {
  AggregateOrderSpec,
  OrderSpec,
  QueryAst,
  RelevanceSortSource,
  SortDirection,
} from "../ast";
import { isAggregatedStatement } from "./aggregated-statement";
import {
  extractFulltextMatchPredicates,
  extractVectorSimilarityPredicates,
} from "./predicates";
import { missingRowIdentityOrder } from "./row-identity-order";

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

/** One term of the order a full-text, vector or hybrid statement selects in. */
export type SelectionOrderKey =
  | Readonly<{ kind: "relevance"; key: RelevanceSortKey }>
  | Readonly<{ kind: "field"; spec: OrderSpec }>
  | Readonly<{ kind: "output"; spec: AggregateOrderSpec }>;

/**
 * The order a full-text, vector or hybrid statement selects its rows in, term
 * by term, forward (before `reverseSelectionOrder`); empty for a statement
 * without a relevance order. The leading relevance keys (rank DESC, distance
 * ASC, or the fused RRF score DESC), then the caller's `orderBy()` terms as
 * tiebreakers, then the trailing relevance keys (the hybrid node-id tiebreak),
 * then, when the rows are matches rather than groups, the row-identity terms
 * the caller's order does not name (`missingRowIdentityOrder`), which make the
 * order total.
 *
 * The one owner of that order: the statement's ORDER BY, its selection-order
 * column and cursor pagination's keyset all read it, so a cursor positions a
 * row exactly where `execute()` returns it.
 */
export function describeSelectionOrder(
  ast: QueryAst,
): readonly SelectionOrderKey[] {
  const keys = describeRelevanceOrder(ast);
  if (keys.length === 0) return [];
  const orderBy = ast.orderBy ?? [];
  const relevance = (placement: RelevanceSortKey["placement"]) =>
    keys
      .filter((key) => key.placement === placement)
      .map((key) => ({ kind: "relevance", key }) as const);
  const rowIdentity =
    isAggregatedStatement(ast) ?
      []
    : missingRowIdentityOrder(orderBy, {
        startAlias: ast.start.alias,
        startKinds: ast.start.kinds,
        traversals: ast.traversals,
      });
  return [
    ...relevance("leading"),
    ...orderBy.map((spec) => ({ kind: "field", spec }) as const),
    ...(ast.aggregateOrderBy ?? []).map(
      (spec) => ({ kind: "output", spec }) as const,
    ),
    ...relevance("trailing"),
    ...rowIdentity.map((spec) => ({ kind: "field", spec }) as const),
  ];
}

/**
 * The column a relevance-ordered statement compiled for a wrapping statement
 * carries the rank of its own ORDER BY in (`buildStandardSelectionOrderColumn`).
 * It is in the reserved `__tg` namespace, which no caller's output key may use.
 */
export const SELECTION_ORDER_COLUMN = "__tg_selection_order";

/**
 * The column a relevance-ordered statement compiled in the `cursor-keyed`
 * shape carries the value of its `index`-th relevance sort key in, rendered by
 * `DialectAdapter.relevanceCursorKey`, for a keyset cursor to carry.
 */
export function relevanceCursorKeyColumn(index: number): string {
  return `__tg_relevance_key_${index}`;
}

/**
 * The field ordering terms the ORDER BY of the statement `ast` compiles to
 * reads: a relevance-ordered statement's selection-order field terms
 * ({@link describeSelectionOrder}, row identity included), any other
 * statement's `orderBy`. The column-pruning pass reads it, so every column an
 * ordering term reads is carried out of its CTE.
 */
export function orderedFieldSpecs(ast: QueryAst): readonly OrderSpec[] {
  const selectionOrder = describeSelectionOrder(ast);
  if (selectionOrder.length === 0) return ast.orderBy ?? [];
  return selectionOrder.flatMap((key) =>
    key.kind === "field" ? [key.spec] : [],
  );
}
