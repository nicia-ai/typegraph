/**
 * What backs each constraint fence class.
 *
 * A constrained write is fenced by one of two things: a per-graph lock that
 * serializes the probe with the write it guards, or a CLAIM row whose primary
 * key refuses a second claimant outright. The second is strictly stronger — it
 * holds without a lock, which is what an import needs — and this module records
 * which class has reached it, so "is this fence a lock or a key?" is answered
 * from one table rather than inferred from whichever module a reader lands in.
 */

/**
 * The runtime extent of the fence classes. {@link ConstraintFenceReason} is
 * DERIVED from it rather than declared beside it: a union type has no runtime
 * extent, so a totality test over a map keyed by the union could only iterate
 * that map's own keys and would be trivially true.
 */
export const CONSTRAINT_FENCE_REASONS = [
  "edgeCardinality",
  "edgeMatchKeyConvergence",
  "nodeDisjointness",
  "nodeUniquenessClaim",
  "nodeUniquenessScope",
] as const;

/**
 * WHICH declared constraint makes a write constrained.
 *
 * The classification names the reason rather than answering yes/no, because
 * the reason is load-bearing twice over: it is what the fence is taken FOR, and
 * — on a backend that cannot hold the fence — it is what the refusal has to
 * tell the caller. "This backend cannot fence constrained writes" is unusable
 * advice; "your `cardinality: 'one'` edge cannot be enforced here" is
 * actionable, and only the classifier knows which it was.
 */
export type ConstraintFenceReason = (typeof CONSTRAINT_FENCE_REASONS)[number];

/** The relation whose key fences a class, or `lockOnly` when nothing does yet. */
type ConstraintFenceBacking = "uniques" | "lockOnly";

/**
 * Which claim relation backs each fence class. The `satisfies` forces totality:
 * a new reason cannot be added without stating what backs it.
 *
 * `nodeUniquenessScope` is `"uniques"` because a shared-scope claim is now
 * written at the scope's axis, so two writers of two kinds in one hierarchy
 * contend for one row. `nodeUniquenessClaim` is the same relation seen from the
 * other side: the claim row is the fence, and the class exists because a write
 * that must issue it BEFORE the row it gates needs a transaction to undo the
 * pair together — which is what its refusal names. The classes still marked
 * `lockOnly` are fenced by the per-graph write lock alone, which is why they
 * are also the classes a non-transactional backend refuses.
 */
export const CONSTRAINT_FENCE_BACKING = {
  edgeCardinality: "lockOnly",
  edgeMatchKeyConvergence: "lockOnly",
  nodeDisjointness: "lockOnly",
  nodeUniquenessClaim: "uniques",
  nodeUniquenessScope: "uniques",
} as const satisfies Record<ConstraintFenceReason, ConstraintFenceBacking>;
