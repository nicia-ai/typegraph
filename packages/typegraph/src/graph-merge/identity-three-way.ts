/**
 * The identity survivor rule and semantic pair key: the ONE place that decides
 * which of several colliding identity assertions survives a merge, and the
 * ONE place that computes the semantic key two assertions are compared under.
 *
 * Extracted out of `merge-identity.ts` so both the plan-time dedupe
 * (`merge-identity.ts`) and the post-remap re-dedupe it runs after endpoint
 * canonicalization call the SAME comparator — a second inline copy of the
 * survivor rule is exactly the kind of decision this repository's contract
 * discipline forbids re-spelling.
 */
import { identityAssertionSemanticKey } from "../identity/assertion-key";
import { encodeTupleKey } from "../utils/tuple-key";
import {
  compareCodePoints,
  type IdentityTransferAssertion,
} from "./typegraph-internal";

/**
 * The semantic key two identity assertions are compared under: the relation
 * plus the code-point-normalized endpoint pair, WITHOUT the validity window.
 * Two assertions sharing this key describe the same claim about the same
 * pair, whatever window each one carries.
 */
export function identitySemanticKey(
  assertion: IdentityTransferAssertion,
): string {
  return identityAssertionSemanticKey(
    assertion.relation,
    assertion.a,
    assertion.b,
  );
}

/**
 * The WINDOW-AWARE dedupe key: the semantic key, further split by validity
 * window for a BOUNDED assertion (one with a `validTo`). An unbounded
 * (current) assertion dedupes purely on the semantic key — there is only ever
 * one "current" truth for a pair — while two branches asserting the SAME
 * bounded window are treated as the same claim and two DIFFERENT bounded
 * windows are kept distinct.
 */
export function identityDedupeKey(
  assertion: IdentityTransferAssertion,
): string {
  const semantic = identitySemanticKey(assertion);
  if (assertion.validTo === undefined) return semantic;
  return encodeTupleKey([semantic, assertion.validFrom, assertion.validTo]);
}

/**
 * Orders two colliding identity assertions so the caller can pick a
 * deterministic survivor: earliest `validFrom` wins, and a tie breaks on the
 * assertion id's code-point order. Callers needing the COMMITTED-id override
 * (an id the target already holds with the exact staged truth always wins
 * regardless of this order) apply it before falling back to this comparator —
 * see `merge-identity.ts`'s `dedupeIdentityAssertions`.
 */
export function compareIdentitySurvivors(
  left: IdentityTransferAssertion,
  right: IdentityTransferAssertion,
): number {
  const byValidity = compareCodePoints(left.validFrom, right.validFrom);
  return byValidity === 0 ? compareCodePoints(left.id, right.id) : byValidity;
}
