/**
 * What claims a node of a given kind owes, before its props are known.
 *
 * This is the DECLARATION-level half of the claim set, and it is deliberately
 * separate from the props-level half: the same list answers "which claim rows
 * does this kind write?" (the entries, once a row's props select the applying
 * constraints and supply their keys) and "does a write of this kind need the
 * per-graph lock?" (the projection in `../constraints.ts`). Two consumers, one
 * classification — a second spelling at either of them is what this module
 * exists to prevent.
 *
 * It imports registry, core types and the axis vocabulary only, so the
 * constraint probes can project it without importing the claim seam.
 */
import { type UniqueConstraint } from "../../core/types";
import { type KindRegistry } from "../../registry/kind-registry";
import { uniquenessClaimTarget } from "./axis";
import { type ConstraintFenceReason } from "./backing";

/**
 * WHEN a claim is issued relative to the row write it gates.
 *
 * `"pre-insert"` means the claim is the ONLY fence for a violation the row
 * write itself would not surface, so it must precede the row — and a failure
 * between the two leaves a live claim with no row, which is why it is also the
 * subject of the non-transactional refusal. `"post-insert"` means the claim
 * follows the row, which is the order those entries ship in today and the order
 * their own primary key already makes sufficient.
 */
export type ClaimPlacement = "pre-insert" | "post-insert";

/** One claim a node of this kind owes, before its props are known. */
export type NodeClaimSite = Readonly<{
  /** The value the claim row's `node_kind` carries — what the PK fences on. */
  axis: string;
  /** The claim row's `constraint_name`. */
  constraintName: string;
  /**
   * Whether this site is ALSO a reason to take the per-graph write lock — i.e.
   * whether its probe reads state the uniques primary key does not already
   * fence. True for a scope spanning more than the node's own kind; false for a
   * single-kind scope, whose own key IS the fence.
   */
  needsLockFence: boolean;
  /**
   * WHEN this site's claim must be issued relative to the row write it gates,
   * for the operation this list was built for. It is DATA, not a caller's
   * choice: the claim seam partitions on it, and the non-transactional refusal
   * asks whether a write owes a `pre-insert` entry.
   */
  placement: ClaimPlacement;
  /**
   * The class a REFUSAL names when this site's claim cannot be undone. A scope
   * spanning more than the node's own kind is `nodeUniquenessScope` — the class
   * the lock path already reports for it; a single-kind scope is
   * `nodeUniquenessClaim`, whose advice is about the reservation row rather
   * than about the scope it does not have.
   */
  refusalReason: ConstraintFenceReason;
  /** The constraint this site came from. */
  constraint: UniqueConstraint;
}>;

/**
 * THE owner of "what claims does a node of this kind owe, and when is each
 * due?".
 *
 * Every field but `constraintName` is derived from ONE computation — the
 * {@link uniquenessClaimTarget} of this kind and scope — so the four readers of
 * this list (the entries, the claim seam's partition, the non-transactional
 * refusal, and the lock projection in `../constraints.ts`) read one
 * classification rather than four predicates that agree until one is edited.
 * The fact all of them turn on is the same one: does this claim's axis span
 * kinds beyond the writer's own?
 *
 * - `needsLockFence` reads it as "the probe reads state the uniques primary key
 *   does not fence", which is what the per-graph lock is taken for;
 * - `placement` reads it as "the claim is the only fence for this axis, so it
 *   must precede the row it gates". On the CREATE path an own-kind claim keeps
 *   its shipped position after the row: the uniques primary key at that axis is
 *   already the complete fence for it, so moving it would buy no fence and cost
 *   a refusal on backends with no transactions. On the UPDATE path every claim
 *   is pre-insert, because the transition seam claims before its gated write
 *   for every scope — see `withNodeClaimTransition`, which explains why that is
 *   the only correct sequence for a transition.
 *
 * A future claim family that breaks the coincidence between those two readings
 * must say WHICH it changes; that is why they are two named fields and not one.
 */
export function nodeClaimSites(
  registry: KindRegistry,
  kind: string,
  uniqueConstraints: readonly UniqueConstraint[],
  operation: "create" | "update",
): readonly NodeClaimSite[] {
  return uniqueConstraints.map((constraint) => {
    const target = uniquenessClaimTarget(kind, constraint.scope, registry);
    return {
      axis: target.axis,
      constraintName: constraint.name,
      needsLockFence: target.crossKind,
      placement:
        operation === "update" || target.crossKind ?
          "pre-insert"
        : "post-insert",
      refusalReason:
        target.crossKind ? "nodeUniquenessScope" : "nodeUniquenessClaim",
      constraint,
    };
  });
}
