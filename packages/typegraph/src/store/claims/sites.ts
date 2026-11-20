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
import {
  DISJOINT_CONSTRAINT_NAME,
  disjointnessClaimAxis,
  uniquenessClaimTarget,
} from "./axis";
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

/**
 * WHICH declared refusal a foreign owner of this claim produces, and the
 * payload that refusal needs.
 *
 * Two constraint families share one claim relation, so the row alone cannot say
 * what refusing it means. Carrying the answer on the site — decided where the
 * site is decided — is what lets the claim seam re-raise the family's own error
 * without re-deriving which family it was from the axis string.
 */
export type ClaimRefusal =
  | Readonly<{ kind: "uniqueness"; constraint: UniqueConstraint }>
  | Readonly<{ kind: "disjointness"; ownKind: string; otherKind: string }>;

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
  /** Which typed error a foreign owner of this claim produces. */
  refusal: ClaimRefusal;
}>;

/**
 * The disjointness sites a write BRINGING A NODE INTO EXISTENCE under this kind
 * owes: one per declared partner.
 *
 * `"create"` and `"resurrect"` only, matching the two places a node comes into
 * existence under a kind — never `"update"`, because an in-place update cannot
 * change a node's kind and so re-derives no cross-kind verdict and owes no
 * claim for one. A resurrect owes exactly what a create owes here: reviving a
 * tombstone re-introduces the same live id under the same kind that a fresh
 * insert would, and {@link file://./node-claims.ts deleteUniquenessEntries}
 * released this node's own disjointness reservations at soft-delete time (it
 * reads the `"create"` extent precisely because it is the wider of the two), so
 * a resurrect starts from the same "holds nothing yet" state a create does and
 * must re-claim from scratch rather than diff.
 *
 * Pairwise rather than per component, because the registry's disjoint pairs are
 * literal unordered pairs: a node disjoint from two partners owes two claims,
 * on two axes, and the two partners are not thereby disjoint from each other.
 *
 * Every one of them is `pre-insert` and `needsLockFence`: the nodes primary key
 * is `(graph_id, kind, id)`, so a disjoint namesake's row does not collide with
 * this node's own insert — the claim is the ONLY fence for the axis, and a
 * fence issued after the write it fences is not a fence. `needsLockFence` is
 * read only by the lock projection (`nodeWriteNeedsConstraintFence`, consulted
 * with `"create"` or `"update"` alone — never `"resurrect"`), so it stays inert
 * for a resurrect: the per-graph lock's trigger set is unchanged by this site
 * applying to a third operation, and the claim's own primary key — the same
 * `INSERT … ON CONFLICT … RETURNING` `insertUnique` already uses for an
 * own-kind uniqueness claim, which needs no lock either — is what fences a
 * resurrect racing a disjoint partner's create.
 */
function disjointnessSites(
  registry: KindRegistry,
  kind: string,
): readonly NodeClaimSite[] {
  return registry.getDisjointKinds(kind).map((otherKind) => ({
    axis: disjointnessClaimAxis(kind, otherKind, registry),
    constraintName: DISJOINT_CONSTRAINT_NAME,
    needsLockFence: true,
    placement: "pre-insert" as const,
    refusalReason: "nodeDisjointness" as const,
    refusal: { kind: "disjointness" as const, ownKind: kind, otherKind },
  }));
}

/**
 * The three shapes a node write can take, for claim purposes.
 *
 * `"create"` is a fresh id under a kind that has never held it live.
 * `"update"` is an in-place change to a row that stays live throughout — it
 * cannot change the node's kind, so it never owes a disjointness claim.
 * `"resurrect"` is a tombstoned row coming back to life under its own kind —
 * the SAME cross-kind event a create is, reached through the transition seam
 * instead of the insert seam, which is why its uniqueness claims are placed
 * like an update's (claim-first, {@link file://./node-claims.ts
 * withNodeClaimTransition} is the only correct sequence for a transition) while
 * its disjointness claims are owed like a create's.
 *
 * Two consumers read this vocabulary and each other's classification would be
 * the wrong one to reuse: {@link nodeClaimEntries} (what a ROW owes, given its
 * operation) reaches `"resurrect"`; `nodeWriteNeedsConstraintFence` (the lock
 * projection, `../constraints.ts`) and its callers reach only `"create"` and
 * `"update"`, by design — see {@link disjointnessSites}'s note on why that
 * keeps the per-graph lock's trigger set unchanged.
 */
export type NodeClaimOperation = "create" | "update" | "resurrect";

/**
 * THE owner of "what claims does a node of this kind owe, and when is each
 * due?".
 *
 * Two families, one list. Disjointness sites come first, so a kind qualifying
 * on both counts reports the class the lock path already reports for it, and so
 * the two families cannot be maintained by two different sets of write paths: a
 * path that remembers uniqueness cannot forget disjointness when both arrive
 * through the same list.
 *
 * Every uniqueness field but `constraintName` is derived from ONE computation —
 * the {@link uniquenessClaimTarget} of this kind and scope — so the four readers
 * of this list (the entries, the claim seam's partition, the non-transactional
 * refusal, and the lock projection in `../constraints.ts`) read one
 * classification rather than four predicates that agree until one is edited.
 * The fact all of them turn on is the same one: does this claim's axis span
 * kinds beyond the writer's own? Disjointness always does; a uniqueness scope
 * does exactly when it covers more than the node's own kind.
 *
 * - `needsLockFence` reads it as "the probe reads state the uniques primary key
 *   does not fence", which is what the per-graph lock is taken for;
 * - `placement` reads it as "the claim is the only fence for this axis, so it
 *   must precede the row it gates". On the CREATE path an own-kind claim keeps
 *   its shipped position after the row: the uniques primary key at that axis is
 *   already the complete fence for it, so moving it would buy no fence and cost
 *   a refusal on backends with no transactions. On the UPDATE and RESURRECT
 *   paths every claim is pre-insert, because the transition seam claims before
 *   its gated write for every scope — see `withNodeClaimTransition`, which
 *   explains why that is the only correct sequence for a transition.
 *
 * A future claim family that breaks the coincidence between those two readings
 * must say WHICH it changes; that is why they are two named fields and not one.
 */
export function nodeClaimSites(
  registry: KindRegistry,
  kind: string,
  uniqueConstraints: readonly UniqueConstraint[],
  operation: NodeClaimOperation,
): readonly NodeClaimSite[] {
  const uniqueness = uniqueConstraints.map((constraint) => {
    const target = uniquenessClaimTarget(kind, constraint.scope, registry);
    return {
      axis: target.axis,
      constraintName: constraint.name,
      needsLockFence: target.crossKind,
      placement:
        operation !== "create" || target.crossKind ?
          "pre-insert"
        : ("post-insert" as const),
      refusalReason:
        target.crossKind ?
          ("nodeUniquenessScope" as const)
        : ("nodeUniquenessClaim" as const),
      refusal: { kind: "uniqueness" as const, constraint },
    } satisfies NodeClaimSite;
  });

  return operation === "update" ? uniqueness : (
      [...disjointnessSites(registry, kind), ...uniqueness]
    );
}
