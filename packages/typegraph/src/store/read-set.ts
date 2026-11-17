import {
  type EdgeKinds,
  type GraphDef,
  type NodeKinds,
} from "../core/define-graph";
import { type ReadSetEdgeDirection, type ReadSetScopeChange } from "../errors";
import { type GraphNodeReferenceInput } from "./types";

export type { ReadSetEdgeDirection } from "../errors";

/** An edge row a read-set scope names, as `{ kind, id }` or an edge read from the store. */
export type ReadSetEdgeReference<G extends GraphDef> = Readonly<{
  kind: EdgeKinds<G>;
  id: string;
}>;

/**
 * One declared read for `tx.assertUnchangedSince()`. Each scope names the
 * smallest region of the graph a read depended on, and catches every change
 * inside that region:
 *
 * - `{ node }` — one node row was read; any change to that node.
 * - `{ edge }` — one edge row was read; any change to that edge.
 * - `{ edgesAt, direction, kind? }` — a neighbourhood was read; an edge added,
 *   changed or removed at that node in that direction, of `kind` when given
 *   or of any kind otherwise. `"out"` covers edges whose `from` endpoint is
 *   the node, `"in"` those whose `to` endpoint is, `"both"` either.
 * - `{ nodeKind }` / `{ edgeKind }` — a listing or query over one exact kind
 *   was read; a row of that kind added, changed or removed. Subclasses are
 *   not implied: declare each kind the read covered.
 * - `{ graph: true }` — anything else; any change to any node or edge.
 *
 * A node scope does not imply the edges at that node. Coarser scopes refuse
 * more often; none misses a change inside it.
 */
export type ReadSetScope<G extends GraphDef> =
  | Readonly<{ node: GraphNodeReferenceInput<G> }>
  | Readonly<{ edge: ReadSetEdgeReference<G> }>
  | Readonly<{
      edgesAt: GraphNodeReferenceInput<G>;
      direction: ReadSetEdgeDirection;
      kind?: EdgeKinds<G>;
    }>
  | Readonly<{ nodeKind: NodeKinds<G> }>
  | Readonly<{ edgeKind: EdgeKinds<G> }>
  | Readonly<{ graph: true }>;

/**
 * What a lineage source answers for a declared read set: every scope that
 * changed after the anchor with the keys that changed in it (empty when the
 * read set is unchanged), or `unbounded` when the source cannot prove the span.
 */
export type ReadSetDelta =
  | Readonly<{ kind: "changes"; changes: readonly ReadSetScopeChange[] }>
  | Readonly<{ kind: "unbounded" }>;
