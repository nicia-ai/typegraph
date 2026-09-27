/**
 * Candidate-bounded identity closure used by merge planning. It starts from
 * the node/edge/assertion endpoints already selected by candidate planning
 * and adds live same-id peers and incident identity assertions to a fixed
 * point. An optional archival projection is retained for callers that need
 * historical assertion rows.
 *
 * The caller supplies endpoints from touched target edges as well as candidate
 * rows: this module deliberately does not perform candidate or edge reads.
 * Every lookup receives the same target, so callers that need a concurrent
 * exact snapshot must pass a transaction-bound, identity-fenced target.
 */
import type { GraphBackend, TransactionBackend } from "../backend/types";
import type { GraphDef } from "../core/define-graph";
import type { IdentityTransferAssertion } from "../identity/service";
import { storeRuntime } from "../store/runtime-port";
import type { Store } from "../store/store";
import { compareCodePoints } from "../utils/compare";

export type CandidateIdentityReference = Readonly<{
  kind: string;
  id: string;
}>;

/** Identity projections shared by sparse clone seeding, diff, and staging. */
export type CandidateIdentityScope = Readonly<{
  /** Matches the base side of diffAgainstBase and ordinary state reads. */
  baseState: readonly IdentityTransferAssertion[];
  /** Matches the default includeDeleted:false working-copy export. */
  cloneState: readonly IdentityTransferAssertion[];
}>;

/**
 * Expands candidate references to the exact current identity component they
 * can affect. Existing assertion rows with a supplied candidate ID are
 * included in the relevant projections even when they are unrelated by
 * endpoints: interchange import's ID conflict check observes those rows
 * before any endpoint-local work.
 */
export async function readCandidateIdentityClosure<G extends GraphDef>(
  store: Store<G>,
  target: GraphBackend | TransactionBackend,
  input: Readonly<{
    references: readonly CandidateIdentityReference[];
    assertionIds?: readonly string[];
    /** Skip historical-only closure reads when the caller needs current scope. */
    includeArchival?: boolean;
  }>,
): Promise<
  Readonly<
    {
      references: readonly CandidateIdentityReference[];
      assertions: readonly IdentityTransferAssertion[];
      baseReferences: readonly CandidateIdentityReference[];
      cloneReferences: readonly CandidateIdentityReference[];
    } & CandidateIdentityScope
  >
> {
  const runtime = storeRuntime(store);
  const references = new Map<string, CandidateIdentityReference>();
  const assertions = new Map<string, IdentityTransferAssertion>();
  const addReference = (reference: CandidateIdentityReference): boolean => {
    const key = JSON.stringify([reference.kind, reference.id]);
    if (references.has(key)) return false;
    references.set(key, reference);
    return true;
  };
  const addAssertion = (assertion: IdentityTransferAssertion): boolean => {
    const isNew = !assertions.has(assertion.id);
    assertions.set(assertion.id, assertion);
    addReference(assertion.a);
    addReference(assertion.b);
    return isNew;
  };

  for (const reference of input.references) addReference(reference);
  const assertionIds =
    input.assertionIds === undefined ? [] : [...new Set(input.assertionIds)];
  if (input.includeArchival !== false && assertionIds.length > 0) {
    const collidingAssertions =
      await runtime.interchangeIdentityAssertionsByIdsAtTarget(
        target,
        assertionIds,
        "archival",
        { includeDeleted: false },
      );
    for (const assertion of collidingAssertions) {
      addAssertion(assertion);
    }
  }

  const expandedReferenceKeys = new Set<string>();
  const expandedIds = new Set<string>();
  let needsExpansion = input.includeArchival !== false;
  while (needsExpansion) {
    const pendingIds = [
      ...new Set(
        [...references.values()]
          .map((reference) => reference.id)
          .filter((id) => !expandedIds.has(id)),
      ),
    ];
    for (const id of pendingIds) expandedIds.add(id);
    if (pendingIds.length > 0) {
      const sameIdPeers = await runtime.liveNodesSharingIds(pendingIds, target);
      for (const peer of sameIdPeers) addReference(peer);
    }

    const pendingReferences = [...references.entries()]
      .filter(([key]) => !expandedReferenceKeys.has(key))
      .map(([, reference]) => reference);
    for (const reference of pendingReferences) {
      expandedReferenceKeys.add(JSON.stringify([reference.kind, reference.id]));
    }
    if (pendingReferences.length > 0) {
      const touchingAssertions =
        await runtime.identityAssertionsTouchingAtTarget(
          target,
          pendingReferences,
          "archival",
          { includeDeleted: false },
        );
      for (const assertion of touchingAssertions) addAssertion(assertion);
    }

    const hasPendingReference = [...references.keys()].some(
      (key) => !expandedReferenceKeys.has(key),
    );
    const hasPendingId = [...references.values()].some(
      (reference) => !expandedIds.has(reference.id),
    );
    needsExpansion = hasPendingReference || hasPendingId;
  }

  const [baseScope, cloneScope] = await Promise.all([
    readStateIdentityProjection(
      store,
      target,
      input.references,
      assertionIds,
      true,
    ),
    readStateIdentityProjection(
      store,
      target,
      input.references,
      assertionIds,
      false,
    ),
  ]);

  return {
    references: [...references.values()].toSorted(compareReferences),
    assertions: [...assertions.values()].toSorted((left, right) =>
      compareCodePoints(left.id, right.id),
    ),
    baseReferences: baseScope.references,
    cloneReferences: cloneScope.references,
    baseState: baseScope.assertions,
    cloneState: cloneScope.assertions,
  };
}

async function readStateIdentityProjection<G extends GraphDef>(
  store: Store<G>,
  target: GraphBackend | TransactionBackend,
  initialReferences: readonly CandidateIdentityReference[],
  assertionIds: readonly string[],
  includeDeletedEndpoints: boolean,
): Promise<
  Readonly<{
    references: readonly CandidateIdentityReference[];
    assertions: readonly IdentityTransferAssertion[];
  }>
> {
  const runtime = storeRuntime(store);
  const references = new Map<string, CandidateIdentityReference>();
  const assertions = new Map<string, IdentityTransferAssertion>();
  const addReference = (reference: CandidateIdentityReference): void => {
    references.set(JSON.stringify([reference.kind, reference.id]), reference);
  };
  const addAssertion = (assertion: IdentityTransferAssertion): void => {
    assertions.set(assertion.id, assertion);
    addReference(assertion.a);
    addReference(assertion.b);
  };
  for (const reference of initialReferences) addReference(reference);

  if (assertionIds.length > 0) {
    const collidingAssertions =
      await runtime.interchangeIdentityAssertionsByIdsAtTarget(
        target,
        assertionIds,
        "state",
        includeDeletedEndpoints ? undefined : { includeDeleted: false },
      );
    for (const assertion of collidingAssertions) addAssertion(assertion);
  }

  const expandedReferenceKeys = new Set<string>();
  const expandedIds = new Set<string>();
  while (
    [...references.keys()].some((key) => !expandedReferenceKeys.has(key)) ||
    [...references.values()].some((reference) => !expandedIds.has(reference.id))
  ) {
    const pendingIds = [
      ...new Set(
        [...references.values()]
          .map((reference) => reference.id)
          .filter((id) => !expandedIds.has(id)),
      ),
    ];
    for (const id of pendingIds) expandedIds.add(id);
    if (pendingIds.length > 0) {
      const sameIdPeers = await runtime.liveNodesSharingIds(pendingIds, target);
      for (const peer of sameIdPeers) addReference(peer);
    }

    const pendingReferences = [...references.entries()]
      .filter(([key]) => !expandedReferenceKeys.has(key))
      .map(([, reference]) => reference);
    for (const reference of pendingReferences) {
      expandedReferenceKeys.add(JSON.stringify([reference.kind, reference.id]));
    }
    if (pendingReferences.length === 0) continue;
    const touchingAssertions = await runtime.identityAssertionsTouchingAtTarget(
      target,
      pendingReferences,
      "state",
      includeDeletedEndpoints ? undefined : { includeDeleted: false },
    );
    for (const assertion of touchingAssertions) addAssertion(assertion);
  }

  return {
    references: [...references.values()].toSorted(compareReferences),
    assertions: [...assertions.values()].toSorted((left, right) =>
      compareCodePoints(left.id, right.id),
    ),
  };
}

function compareReferences(
  left: CandidateIdentityReference,
  right: CandidateIdentityReference,
): number {
  return (
    compareCodePoints(left.kind, right.kind) ||
    compareCodePoints(left.id, right.id)
  );
}
