/**
 * The shape of the per-step token a recursive walk records on its path.
 *
 * A recursive walk recognizes a revisit by finding a step's token already on
 * its path, and the same tokens become the `path` output. Node rows are keyed
 * by (kind, id), so two nodes of different kinds may share an id. A walk whose
 * frontier can hold more than one kind therefore keys its tokens on both: a
 * bare id would read a different-kind node that shares an earlier node's id as
 * a revisit, and silently drop it together with everything beyond it. A walk
 * that can only ever hold one kind keeps the bare id, so its SQL and its path
 * values are unchanged.
 *
 * The compiler emits tokens of this shape and result materialization strips
 * kind-qualified tokens back to bare ids. Both ask this module, from the same
 * query inputs, so they cannot disagree.
 */
import type { Traversal } from "../ast";
import { type AliasKindScope, getNodeKindsForAlias } from "./predicate-utils";

export type RecursivePathTokenShape = "id" | "kind_qualified";

/**
 * Distinct node kinds a recursive walk's frontier can hold: the kinds of the
 * alias it starts from plus the kinds each step reaches.
 */
export function recursiveWalkNodeKinds(
  scope: AliasKindScope,
  traversal: Traversal,
): readonly string[] {
  return [
    ...new Set([
      ...getNodeKindsForAlias(scope, traversal.joinFromAlias),
      ...traversal.nodeKinds,
    ]),
  ];
}

/**
 * Kind-qualified whenever the walk can visit more than one kind, or expands
 * through identity members (folded peers share an id across kinds).
 */
export function recursivePathTokenShape(
  scope: AliasKindScope,
  traversal: Traversal,
): RecursivePathTokenShape {
  const visitsSeveralKinds =
    traversal.includeIdentityMembers === true ||
    recursiveWalkNodeKinds(scope, traversal).length > 1;
  return visitsSeveralKinds ? "kind_qualified" : "id";
}
