/**
 * What backs each constraint fence class.
 *
 * A constrained write is fenced by one of two things: a per-graph lock that
 * serializes the probe with the write it guards, or a CLAIM row whose primary
 * key refuses a second claimant outright. The second is strictly stronger — it
 * holds without a lock, which is what an import needs — and this module records
 * which class has reached it, so "is this fence a lock or a key?" is answered
 * from one table rather than inferred from whichever module a reader lands in.
 *
 * It also owns the runtime half of the same question — {@link claimSupport},
 * the one reader of "can THIS object hold a claim?" — so the declaration and
 * the surface are reconciled in one place rather than at each claim site.
 * `claimSupport` is now a thin binder over the `claims` capability bundle
 * (`backend/capabilities`): the bidirectional declaration/surface cross-check
 * lives once in `resolve.ts`'s `assertClaimsBidirectionalAgreement`, reached
 * through the verdict every caller threads in, and this module owns only the
 * per-write port bind (`claimsMembers`) and this decision's shape.
 */
import {
  type BundleBinding,
  claimsMembers,
} from "../../backend/capabilities/bind";
import type { CLAIMS } from "../../backend/capabilities/bundle-registry";
import { type BundleVerdictOf } from "../../backend/capabilities/resolve";
import { type GraphBackend } from "../../backend/types";

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
type ConstraintFenceBacking = "uniques" | "edgeClaims" | "lockOnly";

/**
 * Which claim relation backs each fence class. The `satisfies` forces totality:
 * a new reason cannot be added without stating what backs it.
 *
 * `nodeUniquenessScope` is `"uniques"` because a shared-scope claim is now
 * written at the scope's axis, so two writers of two kinds in one hierarchy
 * contend for one row. `nodeUniquenessClaim` is the same relation seen from the
 * other side: the claim row is the fence, and the class exists because a write
 * that must issue it BEFORE the row it gates needs a transaction to undo the
 * pair together — which is what its refusal names. `nodeDisjointness` is the
 * same relation again, at a third kind of axis: a claim keyed on the declared
 * PAIR and on the node's id, which is the axis disjointness actually declares
 * and the one the nodes primary key `(graph_id, kind, id)` cannot fence.
 * `edgeCardinality` is the other relation: a claim keyed on
 * `(<cardinality>:<edgeKind>, endpoint identity)`, which is the axis the
 * declaration actually spans and the one the edges primary key `(graph_id, id)`
 * cannot fence. The classes still marked `lockOnly` are fenced by the per-graph
 * write lock alone, which is why they are also the classes a non-transactional
 * backend refuses.
 */
export const CONSTRAINT_FENCE_BACKING = {
  edgeCardinality: "edgeClaims",
  edgeMatchKeyConvergence: "lockOnly",
  nodeDisjointness: "uniques",
  nodeUniquenessClaim: "uniques",
  nodeUniquenessScope: "uniques",
} as const satisfies Record<ConstraintFenceReason, ConstraintFenceBacking>;

/** The decision {@link claimSupport} returns — never a flag a caller re-derives. */
export type ClaimSupport =
  /** Capability declared AND every claim member present: the members, bound off the port. */
  | Readonly<{
      supported: true;
      claims: BundleBinding<(typeof CLAIMS)["core"][number]>;
    }>
  /** Capability absent or false AND no claim member present: the declared gap. */
  | Readonly<{ supported: false }>;

/**
 * THE one reader of "can this object hold a claim?", asked about the object the
 * claim is about to be written to.
 *
 * Takes the bundle's VERDICT — resolved once, against `GraphBackend`, by the
 * caller's `ClaimsVerdictThunk` (ruling B1/B7) — rather than resolving it
 * itself: the declaration/surface cross-check
 * (`resolve.ts`'s `assertClaimsBidirectionalAgreement`) runs exactly once,
 * inside that resolution, and this function never re-derives it. What this
 * function still owns is the PER-WRITE bind: `claimsMembers` (`bind.ts`) binds
 * the verdict's named members off `target` — the object the write actually
 * executes on, which may be a `TransactionBackend` the verdict was never
 * resolved against — and throws the bundle's port-surface code
 * (`CONSTRAINT_CLAIM_SURFACE_MISMATCH`) if `target` disagrees with what the
 * verdict says is present.
 *
 * @throws ConfigurationError (`CONSTRAINT_CLAIM_SURFACE_MISMATCH`) when
 *   `target` is missing a member the verdict says is present.
 */
export function claimSupport(
  target: Readonly<
    Partial<Pick<GraphBackend, (typeof CLAIMS)["core"][number]>>
  >,
  verdict: BundleVerdictOf<typeof CLAIMS>,
): ClaimSupport {
  if (!verdict.supported) return { supported: false };
  return { supported: true, claims: claimsMembers(target, verdict) };
}
