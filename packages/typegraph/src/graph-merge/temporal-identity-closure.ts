import { requireDefined } from "../utils/presence";
import { IdentityMergeConflictError } from "./errors";
import type { PlanIdentityContext } from "./merge-identity";
import {
  compareMergeKeys,
  type MergeKey,
  mergeKey,
  mergeKeyOf,
} from "./node-key";
import type { IdentityTransferAssertion } from "./typegraph-internal";

/**
 * Offline temporal identity validation.
 *
 * Each half-open assertion window is stored in a segment tree. A depth-first
 * walk applies only the assertions visible throughout the current segment and
 * rolls those changes back on return. The disjoint-set therefore represents
 * exactly one temporal coordinate at every leaf without filtering the full
 * ledger or rebuilding every identity class for every boundary.
 *
 * `different` assertions live in component-adjacency sets. When a later
 * `same` union internalizes one, the union records the contradiction; this
 * avoids rescanning all active negative truth after every connectivity change.
 */
type IdentityReference = Readonly<{ kind: string; id: string }>;

type AssertionRange = Readonly<{
  assertionIndex: number;
  start: number;
  end: number;
}>;

type TemporalEvents = Readonly<{
  references: number[];
  sameAssertions: number[];
  differentAssertions: number[];
}>;

type ComponentState = Readonly<{
  parent: number[];
  sizes: number[];
  kinds: Set<string>[];
  differentAssertions: Set<number>[];
  violatesOntology: boolean[];
}>;

type TemporalClosureState = Readonly<{
  assertions: readonly IdentityTransferAssertion[];
  context: PlanIdentityContext;
  references: readonly IdentityReference[];
  referenceIndexByKey: ReadonlyMap<MergeKey, number>;
  activeReferences: boolean[];
  activeReferencesById: Map<string, Set<number>>;
  components: ComponentState;
  contradictoryAssertions: Set<number>;
  undo: (() => void)[];
  disjointCache: Map<string, boolean>;
  sharedIdViolationCount: { value: number };
}>;

function disjointCacheKey(left: string, right: string): string {
  return left <= right ? `${left}\u0000${right}` : `${right}\u0000${left}`;
}

function areDisjoint(
  state: TemporalClosureState,
  left: string,
  right: string,
): boolean {
  const key = disjointCacheKey(left, right);
  const cached = state.disjointCache.get(key);
  if (cached !== undefined) return cached;
  const result = state.context.areDisjoint(left, right);
  state.disjointCache.set(key, result);
  return result;
}

function findRoot(components: ComponentState, index: number): number {
  let root = index;
  while (components.parent[root] !== root) {
    root = requireDefined(components.parent[root]);
  }
  return root;
}

function componentKindsConflict(
  state: TemporalClosureState,
  leftKinds: ReadonlySet<string>,
  rightKinds: ReadonlySet<string>,
): boolean {
  for (const left of leftKinds) {
    for (const right of rightKinds) {
      if (left !== right && areDisjoint(state, left, right)) return true;
    }
  }
  return false;
}

function unionReferences(
  state: TemporalClosureState,
  leftIndex: number,
  rightIndex: number,
): void {
  const { components } = state;
  const leftRoot = findRoot(components, leftIndex);
  const rightRoot = findRoot(components, rightIndex);
  if (leftRoot === rightRoot) return;

  const [parentRoot, childRoot] =
    (
      requireDefined(components.sizes[leftRoot]) >=
      requireDefined(components.sizes[rightRoot])
    ) ?
      [leftRoot, rightRoot]
    : [rightRoot, leftRoot];
  const parentKinds = requireDefined(components.kinds[parentRoot]);
  const childKinds = requireDefined(components.kinds[childRoot]);
  const parentDifferent = requireDefined(
    components.differentAssertions[parentRoot],
  );
  const childDifferent = requireDefined(
    components.differentAssertions[childRoot],
  );
  const previousParentSize = requireDefined(components.sizes[parentRoot]);
  const previousViolation = requireDefined(
    components.violatesOntology[parentRoot],
  );
  const addedKinds = [...childKinds].filter((kind) => !parentKinds.has(kind));
  const addedDifferent = [...childDifferent].filter(
    (assertionIndex) => !parentDifferent.has(assertionIndex),
  );
  const addedContradictions: number[] = [];
  const crossesDisjointKinds = componentKindsConflict(
    state,
    parentKinds,
    childKinds,
  );

  components.parent[childRoot] = parentRoot;
  components.sizes[parentRoot] =
    previousParentSize + requireDefined(components.sizes[childRoot]);
  for (const kind of addedKinds) parentKinds.add(kind);
  for (const assertionIndex of addedDifferent) {
    parentDifferent.add(assertionIndex);
  }
  components.violatesOntology[parentRoot] =
    previousViolation ||
    requireDefined(components.violatesOntology[childRoot]) ||
    crossesDisjointKinds;

  for (const assertionIndex of childDifferent) {
    const assertion = requireDefined(state.assertions[assertionIndex]);
    const aIndex = requireDefined(
      state.referenceIndexByKey.get(mergeKeyOf(assertion.a)),
    );
    const bIndex = requireDefined(
      state.referenceIndexByKey.get(mergeKeyOf(assertion.b)),
    );
    if (
      findRoot(components, aIndex) === findRoot(components, bIndex) &&
      !state.contradictoryAssertions.has(assertionIndex)
    ) {
      state.contradictoryAssertions.add(assertionIndex);
      addedContradictions.push(assertionIndex);
    }
  }

  state.undo.push(() => {
    for (const assertionIndex of addedContradictions) {
      state.contradictoryAssertions.delete(assertionIndex);
    }
    components.violatesOntology[parentRoot] = previousViolation;
    for (const assertionIndex of addedDifferent) {
      parentDifferent.delete(assertionIndex);
    }
    for (const kind of addedKinds) parentKinds.delete(kind);
    components.sizes[parentRoot] = previousParentSize;
    components.parent[childRoot] = childRoot;
  });
}

function activateReference(
  state: TemporalClosureState,
  referenceIndex: number,
): void {
  if (state.activeReferences[referenceIndex] === true) return;
  const reference = requireDefined(state.references[referenceIndex]);
  const peers = [...(state.activeReferencesById.get(reference.id) ?? [])];
  let addedSharedIdViolations = 0;
  for (const peerIndex of peers) {
    const peer = requireDefined(state.references[peerIndex]);
    if (areDisjoint(state, reference.kind, peer.kind)) {
      addedSharedIdViolations += 1;
    }
  }
  state.sharedIdViolationCount.value += addedSharedIdViolations;
  state.activeReferences[referenceIndex] = true;
  const activeForId =
    state.activeReferencesById.get(reference.id) ?? new Set<number>();
  activeForId.add(referenceIndex);
  state.activeReferencesById.set(reference.id, activeForId);
  state.undo.push(() => {
    activeForId.delete(referenceIndex);
    if (activeForId.size === 0) {
      state.activeReferencesById.delete(reference.id);
    }
    state.activeReferences[referenceIndex] = false;
    state.sharedIdViolationCount.value -= addedSharedIdViolations;
  });

  if (state.context.sameIdAcrossKinds === "fold") {
    for (const peerIndex of peers) {
      unionReferences(state, referenceIndex, peerIndex);
    }
  }
}

function addDifferentAssertion(
  state: TemporalClosureState,
  assertionIndex: number,
): void {
  const assertion = requireDefined(state.assertions[assertionIndex]);
  const aIndex = requireDefined(
    state.referenceIndexByKey.get(mergeKeyOf(assertion.a)),
  );
  const bIndex = requireDefined(
    state.referenceIndexByKey.get(mergeKeyOf(assertion.b)),
  );
  const aRoot = findRoot(state.components, aIndex);
  const bRoot = findRoot(state.components, bIndex);
  if (aRoot === bRoot) {
    state.contradictoryAssertions.add(assertionIndex);
    state.undo.push(() => {
      state.contradictoryAssertions.delete(assertionIndex);
    });
    return;
  }

  const aDifferent = requireDefined(
    state.components.differentAssertions[aRoot],
  );
  const bDifferent = requireDefined(
    state.components.differentAssertions[bRoot],
  );
  aDifferent.add(assertionIndex);
  bDifferent.add(assertionIndex);
  state.undo.push(() => {
    aDifferent.delete(assertionIndex);
    bDifferent.delete(assertionIndex);
  });
}

function rollback(state: TemporalClosureState, snapshot: number): void {
  while (state.undo.length > snapshot) {
    requireDefined(state.undo.pop())();
  }
}

function firstDisjointPair(
  state: TemporalClosureState,
  kinds: readonly string[],
): readonly [string, string] | undefined {
  for (const [index, left] of kinds.entries()) {
    for (const right of kinds.slice(index + 1)) {
      if (areDisjoint(state, left, right)) return [left, right];
    }
  }
  return undefined;
}

function firstAssertionIndex(assertionIndexes: ReadonlySet<number>): number {
  let first = Number.POSITIVE_INFINITY;
  for (const assertionIndex of assertionIndexes) {
    first = Math.min(first, assertionIndex);
  }
  return first;
}

function activeClassMembers(
  state: TemporalClosureState,
  root: number,
): readonly IdentityReference[] {
  return state.references
    .filter(
      (_reference, index) =>
        state.activeReferences[index] === true &&
        findRoot(state.components, index) === root,
    )
    .toSorted((left, right) =>
      compareMergeKeys(
        mergeKey(left.kind, left.id),
        mergeKey(right.kind, right.id),
      ),
    );
}

function assertCoordinateConsistent(state: TemporalClosureState): void {
  if (state.sharedIdViolationCount.value > 0) {
    const activeById = new Map<string, IdentityReference[]>();
    for (const [index, reference] of state.references.entries()) {
      if (state.activeReferences[index] !== true) continue;
      const references = activeById.get(reference.id) ?? [];
      references.push(reference);
      activeById.set(reference.id, references);
    }
    for (const [sharedId, references] of activeById) {
      const disjointKinds = firstDisjointPair(state, [
        ...new Set(references.map((reference) => reference.kind)),
      ]);
      if (disjointKinds === undefined) continue;
      throw new IdentityMergeConflictError(
        "The merged graph would give one id to two ontology-disjoint kinds.",
        { details: { disjointKinds, sharedId } },
      );
    }
  }

  if (state.contradictoryAssertions.size > 0) {
    const assertionIndex = firstAssertionIndex(state.contradictoryAssertions);
    const assertion = requireDefined(state.assertions[assertionIndex]);
    const root = findRoot(
      state.components,
      requireDefined(state.referenceIndexByKey.get(mergeKeyOf(assertion.a))),
    );
    throw new IdentityMergeConflictError(
      "The merged identity ledger would assert one pair of nodes is both the same and different.",
      {
        details: {
          assertion,
          sameClass: activeClassMembers(state, root),
        },
      },
    );
  }

  for (const [
    index,
    violatesOntology,
  ] of state.components.violatesOntology.entries()) {
    if (
      !violatesOntology ||
      state.components.parent[index] !== index ||
      state.activeReferences[index] !== true
    ) {
      continue;
    }
    const sameClass = activeClassMembers(state, index);
    const disjointKinds = firstDisjointPair(state, [
      ...new Set(sameClass.map((member) => member.kind)),
    ]);
    if (disjointKinds === undefined) continue;
    throw new IdentityMergeConflictError(
      "The merged identity ledger would join two ontology-disjoint kinds into one class.",
      { details: { disjointKinds, sameClass } },
    );
  }
}

function addRangeEvent(
  events: readonly TemporalEvents[],
  node: number,
  left: number,
  right: number,
  start: number,
  end: number,
  add: (event: TemporalEvents) => void,
): void {
  if (start <= left && right <= end) {
    add(requireDefined(events[node]));
    return;
  }
  const middle = Math.floor((left + right) / 2);
  if (start < middle) {
    addRangeEvent(events, node * 2, left, middle, start, end, add);
  }
  if (middle < end) {
    addRangeEvent(events, node * 2 + 1, middle, right, start, end, add);
  }
}

function visitTemporalEvents(
  events: readonly TemporalEvents[],
  state: TemporalClosureState,
  node: number,
  left: number,
  right: number,
): void {
  const snapshot = state.undo.length;
  const event = requireDefined(events[node]);
  for (const referenceIndex of event.references) {
    activateReference(state, referenceIndex);
  }
  for (const assertionIndex of event.sameAssertions) {
    const assertion = requireDefined(state.assertions[assertionIndex]);
    unionReferences(
      state,
      requireDefined(state.referenceIndexByKey.get(mergeKeyOf(assertion.a))),
      requireDefined(state.referenceIndexByKey.get(mergeKeyOf(assertion.b))),
    );
  }
  for (const assertionIndex of event.differentAssertions) {
    addDifferentAssertion(state, assertionIndex);
  }

  if (right - left === 1) {
    assertCoordinateConsistent(state);
  } else {
    const middle = Math.floor((left + right) / 2);
    visitTemporalEvents(events, state, node * 2, left, middle);
    visitTemporalEvents(events, state, node * 2 + 1, middle, right);
  }
  rollback(state, snapshot);
}

function mergeRanges(
  ranges: readonly Readonly<{ start: number; end: number }>[],
): readonly Readonly<{ start: number; end: number }>[] {
  const merged: { start: number; end: number }[] = [];
  for (const range of ranges.toSorted(
    (left, right) => left.start - right.start,
  )) {
    const previous = merged.at(-1);
    if (previous === undefined || previous.end < range.start) {
      merged.push({ ...range });
    } else {
      previous.end = Math.max(previous.end, range.end);
    }
  }
  return merged;
}

export function assertTemporalIdentityClosureConsistent(
  assertions: readonly IdentityTransferAssertion[],
  identityContext: PlanIdentityContext,
  nodeUniverse: readonly IdentityReference[],
): void {
  const boundaries = new Set<string>();
  for (const assertion of assertions) {
    boundaries.add(assertion.validFrom);
    if (assertion.validTo !== undefined) boundaries.add(assertion.validTo);
  }
  const sortedBoundaries = [...boundaries].toSorted();
  const leafCount = Math.max(1, sortedBoundaries.length);
  const boundaryIndex = new Map(
    sortedBoundaries.map((boundary, index) => [boundary, index]),
  );
  const assertionRanges: AssertionRange[] = assertions.map(
    (assertion, assertionIndex) => ({
      assertionIndex,
      start: requireDefined(boundaryIndex.get(assertion.validFrom)),
      end:
        assertion.validTo === undefined ?
          leafCount
        : requireDefined(boundaryIndex.get(assertion.validTo)),
    }),
  );

  const references: IdentityReference[] = [];
  const referenceIndexByKey = new Map<MergeKey, number>();
  const addReference = (reference: IdentityReference): number => {
    const key = mergeKey(reference.kind, reference.id);
    const existing = referenceIndexByKey.get(key);
    if (existing !== undefined) return existing;
    const index = references.length;
    references.push(reference);
    referenceIndexByKey.set(key, index);
    return index;
  };
  const alwaysActive = new Set(nodeUniverse.map((node) => addReference(node)));
  const rangesByReference = new Map<
    number,
    Readonly<{ start: number; end: number }>[]
  >();
  for (const range of assertionRanges) {
    if (range.start >= range.end) continue;
    const assertion = requireDefined(assertions[range.assertionIndex]);
    for (const endpoint of [assertion.a, assertion.b]) {
      const referenceIndex = addReference(endpoint);
      const ranges = rangesByReference.get(referenceIndex) ?? [];
      ranges.push({ start: range.start, end: range.end });
      rangesByReference.set(referenceIndex, ranges);
    }
  }

  const events: TemporalEvents[] = Array.from(
    { length: leafCount * 4 },
    () => ({ references: [], sameAssertions: [], differentAssertions: [] }),
  );
  for (const [referenceIndex, ranges] of rangesByReference) {
    if (alwaysActive.has(referenceIndex)) continue;
    for (const range of mergeRanges(ranges)) {
      addRangeEvent(events, 1, 0, leafCount, range.start, range.end, (event) =>
        event.references.push(referenceIndex),
      );
    }
  }
  for (const range of assertionRanges) {
    if (range.start >= range.end) continue;
    const assertion = requireDefined(assertions[range.assertionIndex]);
    addRangeEvent(events, 1, 0, leafCount, range.start, range.end, (event) =>
      assertion.relation === "same" ?
        event.sameAssertions.push(range.assertionIndex)
      : event.differentAssertions.push(range.assertionIndex),
    );
  }

  const state: TemporalClosureState = {
    assertions,
    context: identityContext,
    references,
    referenceIndexByKey,
    activeReferences: references.map(() => false),
    activeReferencesById: new Map(),
    components: {
      parent: references.map((_reference, index) => index),
      sizes: references.map(() => 1),
      kinds: references.map((reference) => new Set([reference.kind])),
      differentAssertions: references.map(() => new Set<number>()),
      violatesOntology: references.map(() => false),
    },
    contradictoryAssertions: new Set(),
    undo: [],
    disjointCache: new Map(),
    sharedIdViolationCount: { value: 0 },
  };
  // Universe nodes are present at every coordinate, so their activation and
  // same-id folds form the rollback traversal's immutable baseline.
  for (const referenceIndex of alwaysActive)
    activateReference(state, referenceIndex);
  state.undo.length = 0;
  visitTemporalEvents(events, state, 1, 0, leafCount);
}
