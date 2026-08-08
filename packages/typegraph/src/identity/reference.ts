import { compareCodePoints } from "../utils/compare";
import { encodeTupleKey } from "../utils/tuple-key";
import { type PlainNodeRef } from "./sql-target";

/** Canonical, injective map key for a node reference. */
export function identityReferenceKey(ref: PlainNodeRef): string {
  return encodeTupleKey([ref.kind, ref.id]);
}

/** Orders identity references by kind, then id, using code-point order. */
export function compareIdentityReferences(
  left: PlainNodeRef,
  right: PlainNodeRef,
): number {
  const kindOrder = compareCodePoints(left.kind, right.kind);
  return kindOrder === 0 ? compareCodePoints(left.id, right.id) : kindOrder;
}

/** Returns a pair in the canonical identity endpoint order. */
export function normalizeIdentityPair(
  first: PlainNodeRef,
  second: PlainNodeRef,
): readonly [PlainNodeRef, PlainNodeRef] {
  return compareIdentityReferences(first, second) <= 0 ?
      [first, second]
    : [second, first];
}

/** Tests reference membership through the canonical key representation. */
export function identityReferencesContain(
  members: readonly PlainNodeRef[],
  ref: PlainNodeRef,
): boolean {
  const key = identityReferenceKey(ref);
  return members.some((member) => identityReferenceKey(member) === key);
}
