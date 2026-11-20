import { encodeTupleKey } from "../utils/tuple-key";
import { type IdentityRelation } from "./types";

type IdentityKeyReference = Readonly<{ kind: string; id: string }>;

/** Injective semantic identity for an assertion, excluding its ledger row id. */
export function identityAssertionSemanticKey(
  relation: IdentityRelation,
  a: IdentityKeyReference,
  b: IdentityKeyReference,
): string {
  return encodeTupleKey([relation, a.kind, a.id, b.kind, b.id]);
}
