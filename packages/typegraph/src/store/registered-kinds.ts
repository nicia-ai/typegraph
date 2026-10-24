/**
 * "Is this kind registered on the graph" for every read that names kinds in
 * its options.
 *
 * A kind list is compiled into a kind filter, so an unregistered name does
 * not fail on its own: it matches no row, and the read answers with an
 * ordinary, silently incomplete result. Each read that accepts kind names
 * therefore refuses an unregistered one before it compiles anything, through
 * these two functions, so `neighbors`, the heterogeneous edge reads,
 * `subgraph` and the graph algorithms cannot disagree about what counts as
 * registered or how the refusal reads.
 *
 * Own-key lookups on purpose: a kind literally named `toString` must not
 * resolve to an inherited member.
 */
import { type GraphDef } from "../core/define-graph";
import { KindNotFoundError } from "../errors";

/** @throws KindNotFoundError when any of `kinds` is not a registered node kind. */
export function assertRegisteredNodeKinds(
  graph: GraphDef,
  kinds: readonly string[],
): void {
  for (const kind of kinds) {
    if (Object.hasOwn(graph.nodes, kind)) continue;
    throw new KindNotFoundError(kind, "node", { graphId: graph.id });
  }
}

/** @throws KindNotFoundError when any of `kinds` is not a registered edge kind. */
export function assertRegisteredEdgeKinds(
  graph: GraphDef,
  kinds: readonly string[],
): void {
  for (const kind of kinds) {
    if (Object.hasOwn(graph.edges, kind)) continue;
    throw new KindNotFoundError(kind, "edge", { graphId: graph.id });
  }
}
