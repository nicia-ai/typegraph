import { identityReferenceKey } from "./reference";
import { type PlainNodeRef } from "./sql-target";
import { type IdentityAssertionStorageRow } from "./storage-types";

/** Finds a negative assertion connecting two structural identity classes. */
export function spanningDifferentAssertion(
  assertions: readonly IdentityAssertionStorageRow[],
  first: readonly PlainNodeRef[],
  second: readonly PlainNodeRef[],
): IdentityAssertionStorageRow | undefined {
  const firstKeys = new Set(
    first.map((reference) => identityReferenceKey(reference)),
  );
  const secondKeys = new Set(
    second.map((reference) => identityReferenceKey(reference)),
  );
  return assertions.find((assertion) => {
    if (assertion.rel !== "different") return false;
    const firstEndpoint = identityReferenceKey({
      kind: assertion.a_kind,
      id: assertion.a_id,
    });
    const secondEndpoint = identityReferenceKey({
      kind: assertion.b_kind,
      id: assertion.b_id,
    });
    return (
      (firstKeys.has(firstEndpoint) && secondKeys.has(secondEndpoint)) ||
      (firstKeys.has(secondEndpoint) && secondKeys.has(firstEndpoint))
    );
  });
}
