/**
 * The governing DECISION a merge attaches to the identity transitions it
 * causes.
 *
 * When a merge folds or splits an identity class, the transition log records
 * WHY. Without this, a fold triggered by a merged node create is filed as an
 * anonymous `fold` and a reviewer replaying the class can see that it happened
 * but not which plan, review, branch or policy arm produced it.
 *
 * Everything here is evidence ALREADY IN HAND at the apply site — the plan
 * artifact's own digest, the anchors it was built from, the policy the
 * classifier actually exercised. Nothing is read, recomputed, or invented; a
 * field the caller cannot evidence stays absent rather than being guessed.
 */
import type { MergePlanAnchors } from "./plan-schema";
import type { IdentityDecisionProvenance } from "./typegraph-internal";
import type { IdentityReconciliation } from "./types";

/**
 * Root-first branch ancestry: the base (or fork-point) graph, then each branch
 * in the anchors' own wire order.
 *
 * Ancestry here is the PLAN's `MergePlanAnchors` — what this merge combined —
 * not a per-graph lineage the store would have to reconstruct. That is the only
 * ancestry the apply site can evidence without reading anything.
 */
export function branchAncestryOf(
  rootGraphId: string,
  branchIds: readonly string[],
): readonly string[] {
  return [rootGraphId, ...branchIds];
}

/** The same ancestry, read off a plan artifact's anchors. */
export function branchAncestryFromAnchors(
  anchors: MergePlanAnchors,
): readonly string[] {
  const root =
    anchors.kind === "snapshot" ?
      anchors.base.graphId
    : anchors.forkPoint.graphId;
  return branchAncestryOf(
    root,
    anchors.branches.map((branch) => branch.branchId),
  );
}

/**
 * The policy arm that actually DECIDED something, or `undefined` when the merge
 * arbitrated nothing by policy.
 *
 * Read off the reconciliations the classifier produced rather than off the
 * stated options, so an ordinary apply never writes a policy string it did not
 * exercise — a stated `onAssertionConflict` that no conflict ever reached is
 * not a decision the transition log should claim was made.
 */
export function identityDecisionPolicy(
  reconciliations: readonly IdentityReconciliation[],
): string | undefined {
  const arms = new Set<string>();
  for (const reconciliation of reconciliations) {
    if (reconciliation.policy !== undefined) {
      arms.add(`assertion:${reconciliation.policy}`);
    }
  }
  if (arms.size === 0) return undefined;
  return [...arms].toSorted().join(",");
}

/** The evidence an apply site has for the decision it is about to record. */
export type MergeIdentityDecisionInput = Readonly<{
  branchAncestry: readonly string[];
  reconciliations: readonly IdentityReconciliation[];
  mergePlanDigest?: string | undefined;
  reviewDigest?: string | undefined;
  sourceId?: string | undefined;
}>;

/**
 * Builds the decision, omitting every field the caller could not evidence.
 * `branchId` is present only in the single-branch case, where "which branch"
 * has an unambiguous answer.
 */
export function mergeIdentityDecision(
  input: MergeIdentityDecisionInput,
): IdentityDecisionProvenance {
  const policy = identityDecisionPolicy(input.reconciliations);
  // [root, branch] — exactly one branch merged, so naming it is unambiguous.
  const soleBranch =
    input.branchAncestry.length === 2 ? input.branchAncestry[1] : undefined;
  return {
    ...(policy === undefined ? {} : { policy }),
    ...(soleBranch === undefined ? {} : { branchId: soleBranch }),
    ...(input.branchAncestry.length === 0 ?
      {}
    : { branchAncestry: input.branchAncestry }),
    ...(input.mergePlanDigest === undefined ?
      {}
    : { mergePlanDigest: input.mergePlanDigest }),
    ...(input.reviewDigest === undefined ?
      {}
    : { reviewDigest: input.reviewDigest }),
    ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
  };
}
