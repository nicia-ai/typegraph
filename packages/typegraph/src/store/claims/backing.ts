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
 */
import {
  type GraphBackend,
  type TransactionBackend,
} from "../../backend/types";
import { ConfigurationError } from "../../errors";
import { requireDefined } from "../../utils/presence";

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

/**
 * The claim members, narrowed to present. A caller holding this has been told
 * by ONE reader that this object both declares claim support and carries every
 * member that support consists of.
 */
type RequiredClaimMembers = Readonly<{
  claimEdgeCardinality: NonNullable<GraphBackend["claimEdgeCardinality"]>;
  claimEdgeCardinalityBatch: NonNullable<
    GraphBackend["claimEdgeCardinalityBatch"]
  >;
  purgeEdgeClaims: NonNullable<GraphBackend["purgeEdgeClaims"]>;
  hardDeleteUniquesByConcreteKind: NonNullable<
    GraphBackend["hardDeleteUniquesByConcreteKind"]
  >;
}>;

/** The decision {@link claimSupport} returns — never a flag a caller re-derives. */
export type ClaimSupport =
  /** Capability declared AND every claim member present: the members, narrowed. */
  | Readonly<{ supported: true; claims: RequiredClaimMembers }>
  /** Capability absent or false AND no claim member present: the declared gap. */
  | Readonly<{ supported: false }>;

/** The members `constraintClaims: true` promises, in one list. */
const CLAIM_MEMBER_NAMES = [
  "claimEdgeCardinality",
  "claimEdgeCardinalityBatch",
  "purgeEdgeClaims",
  "hardDeleteUniquesByConcreteKind",
] as const satisfies readonly (keyof RequiredClaimMembers)[];

/**
 * THE one reader of "can this object hold a claim?", asked about the object the
 * claim is about to be written to.
 *
 * It reads BOTH the declaration and the surface, and returns the decision — the
 * narrowed members — rather than a boolean a caller then re-derives the members
 * from. Reading only `capabilities` would let a projection that forwards the
 * capability verbatim while dropping a method produce a verdict about a
 * different object than the write goes to; reading only member presence would
 * be the `undefined`-means-something inference the capability exists to
 * replace.
 *
 * @throws ConfigurationError (`CONSTRAINT_CLAIM_SURFACE_MISMATCH`) when the two
 *   disagree in either direction — a backend or projection declaring
 *   `constraintClaims: true` while missing a member, or one shipping the
 *   members without declaring the capability. Both are defects in the object,
 *   and a silent fallback would unfence exactly the writes the capability
 *   exists to fence.
 */
export function claimSupport(
  target: GraphBackend | TransactionBackend,
): ClaimSupport {
  const declared = target.capabilities.constraintClaims === true;
  const present = CLAIM_MEMBER_NAMES.filter(
    (name) => target[name] !== undefined,
  );
  if (declared && present.length === CLAIM_MEMBER_NAMES.length) {
    return {
      supported: true,
      claims: {
        claimEdgeCardinality: requireDefined(target.claimEdgeCardinality),
        claimEdgeCardinalityBatch: requireDefined(
          target.claimEdgeCardinalityBatch,
        ),
        purgeEdgeClaims: requireDefined(target.purgeEdgeClaims),
        hardDeleteUniquesByConcreteKind: requireDefined(
          target.hardDeleteUniquesByConcreteKind,
        ),
      },
    };
  }
  if (!declared && present.length === 0) return { supported: false };

  const missing = CLAIM_MEMBER_NAMES.filter(
    (name) => target[name] === undefined,
  );
  throw new ConfigurationError(
    declared ?
      `This backend declares \`constraintClaims: true\` but does not implement ${missing.join(", ")}. ` +
        "A declared constraint would then be written without the fence the " +
        "declaration promises."
    : `This backend implements ${present.join(", ")} but does not declare \`constraintClaims: true\`. ` +
        "Claim support is read from the declaration, so these members would " +
        "never be called.",
    { code: "CONSTRAINT_CLAIM_SURFACE_MISMATCH", missing, present },
    {
      suggestion:
        declared ?
          "Implement the missing members, or drop `constraintClaims` from the backend's capabilities."
        : "Declare `constraintClaims: true` in the backend's capabilities, or drop the claim members.",
    },
  );
}
