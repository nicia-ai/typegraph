import { requireDefined } from "../utils/presence";
/**
 * The centralized property-conflict resolution rule (design §6.4 rule 4 / §7.3,
 * T8). Shared by canonical node-property union (T8 / `canonicalize.ts`) and edge
 * property-collision resolution (T9), so the determinism contract lives in
 * exactly one place.
 *
 * DETERMINISM CONTRACT — the single most important invariant of the merge:
 *   Conflict resolution NEVER consults wall-clock arrival time. When a value
 *   must be chosen among differing per-branch candidates, the choice is made on
 *   a STABLE branch total order — either the caller-supplied
 *   `MergeOptions.branchOrder`, or branch ids sorted lexicographically — captured
 *   ONCE before any resolution runs. Two merges of the same branch set in any
 *   order therefore resolve every conflict identically.
 */
import { canonicalValueKey } from "./canonical-props";
import { compareStrings } from "./node-key";
import type {
  EdgeId,
  GraphDef,
  JsonValue,
  NodeId,
  NodeType,
} from "./typegraph-internal";
import type {
  BranchId,
  ConflictingValue,
  PropertyConflict,
  PropertyConflictPolicy,
} from "./types";

/**
 * The candidate values for one conflicted property, each tagged with the branch
 * that contributed it. Built by the union phases (node/edge) before delegating
 * to {@link resolveConflictValue}.
 */
type ConflictInput = Readonly<{
  /** The property name in conflict. */
  property: string;
  /** Every distinct contributing `(branchId, value)`, one per source. */
  values: readonly ConflictingValue[];
  /** The canonical survivor's own value — kept under the `"flag"` policy. */
  canonicalValue: JsonValue;
}>;

/**
 * Per-branch trust weights for the `"provenanceWeighted"` policy. Branches absent
 * from the map default to weight `0`. Ties are broken by the stable branch order.
 */
export type ProvenanceWeights = ReadonlyMap<BranchId, number>;

/**
 * The captured, immutable resolution context. The stable branch order is passed
 * separately as a precomputed `branchRank` (built once via {@link buildBranchRank}
 * and shared across every conflict), so this context carries only the policy and
 * the optional `"provenanceWeighted"` weights.
 *
 * BRANCH ORDER IS A PRIORITY ORDER: the branch appearing EARLIER in
 * `MergeOptions.branchOrder` (lower rank) has higher precedence. `"lastWriteWins"`
 * therefore picks the value of the HIGHEST-PRIORITY branch (lowest rank / first
 * in the order) — the "winning write" is defined by the stable order, NOT by
 * wall-clock arrival. There is no wall-clock anywhere in this module.
 */
export type ResolutionContext<G extends GraphDef = GraphDef> = Readonly<{
  policy: PropertyConflictPolicy<G>;
  weights?: ProvenanceWeights;
}>;

/**
 * The outcome of resolving one property conflict: the surviving value and
 * whether the values actually differed (so callers know whether to record a
 * {@link PropertyConflict}).
 */
type ConflictResolution = Readonly<{
  value: JsonValue;
  conflicted: boolean;
}>;

/**
 * Builds the rank lookup for a stable branch order. Branch ids not present in
 * the supplied order are appended in lexicographic order after the explicit
 * ones, so an incomplete `branchOrder` is still total and deterministic.
 */
export function buildBranchRank(
  branchOrder: readonly BranchId[],
  allBranchIds: readonly BranchId[],
): ReadonlyMap<BranchId, number> {
  const rank = new Map<BranchId, number>();
  let next = 0;
  for (const branchId of branchOrder) {
    if (!rank.has(branchId)) {
      rank.set(branchId, next);
      next += 1;
    }
  }
  const remaining = allBranchIds
    .filter((branchId) => !rank.has(branchId))
    .sort((left, right) => compareStrings(left, right));
  for (const branchId of remaining) {
    if (!rank.has(branchId)) {
      rank.set(branchId, next);
      next += 1;
    }
  }
  return rank;
}

/**
 * Returns the value contributed by the HIGHEST-PRIORITY branch — the one with
 * the lowest rank (earliest in the stable branch order). Ties (two contributions
 * sharing a rank, e.g. when the same branch staged two values) are broken by the
 * canonical serialization of the value, so the choice is fully deterministic.
 */
function pickByPriority(
  values: readonly ConflictingValue[],
  branchRank: ReadonlyMap<BranchId, number>,
): JsonValue {
  let chosen = requireDefined(values[0]);
  let chosenRank = branchRank.get(chosen.branchId) ?? Number.MAX_SAFE_INTEGER;
  for (const candidate of values.slice(1)) {
    const candidateRank =
      branchRank.get(candidate.branchId) ?? Number.MAX_SAFE_INTEGER;
    if (candidateRank < chosenRank) {
      chosen = candidate;
      chosenRank = candidateRank;
    } else if (
      candidateRank === chosenRank &&
      canonicalValueKey(candidate.value) < canonicalValueKey(chosen.value)
    ) {
      chosen = candidate;
    }
  }
  return chosen.value;
}

/**
 * Picks the value contributed by the highest-weight branch under
 * `"provenanceWeighted"`. Ties on weight fall back to the stable branch order
 * (highest-priority / lowest rank wins), then to canonical value order — never
 * wall-clock.
 */
function pickByWeight(
  values: readonly ConflictingValue[],
  weights: ProvenanceWeights,
  branchRank: ReadonlyMap<BranchId, number>,
): JsonValue {
  let chosen = requireDefined(values[0]);
  let chosenWeight = weights.get(chosen.branchId) ?? 0;
  let chosenRank = branchRank.get(chosen.branchId) ?? Number.MAX_SAFE_INTEGER;
  for (const candidate of values.slice(1)) {
    const candidateWeight = weights.get(candidate.branchId) ?? 0;
    const candidateRank =
      branchRank.get(candidate.branchId) ?? Number.MAX_SAFE_INTEGER;
    if (candidateWeight > chosenWeight) {
      chosen = candidate;
      chosenWeight = candidateWeight;
      chosenRank = candidateRank;
      continue;
    }
    if (candidateWeight === chosenWeight) {
      if (candidateRank < chosenRank) {
        chosen = candidate;
        chosenRank = candidateRank;
      } else if (
        candidateRank === chosenRank &&
        canonicalValueKey(candidate.value) < canonicalValueKey(chosen.value)
      ) {
        chosen = candidate;
      }
    }
  }
  return chosen.value;
}

/**
 * Returns whether every contributing value is deeply equal (so there is no real
 * conflict). Compares the {@link canonicalValueKey} (recursively key-sorted) form
 * so two branches that wrote a logically-equal object with different key order do
 * NOT register as a conflict.
 */
function allValuesEqual(values: readonly ConflictingValue[]): boolean {
  if (values.length <= 1) {
    return true;
  }
  const first = canonicalValueKey(requireDefined(values[0]).value);
  return values.every(
    (candidate) => canonicalValueKey(candidate.value) === first,
  );
}

/**
 * A single `(branchId, props)` contribution to a property union — a cluster
 * member (node) or a collision-group member (edge's staged record). The union
 * phases differ in their surrounding base/survivor logic but agree on HOW to
 * gather a property's candidate values, so they share {@link collectConflictingValues}.
 */
type Contribution = Readonly<{
  branchId: BranchId;
  props: Readonly<Record<string, JsonValue>>;
}>;

/**
 * Collects the distinct `(branchId, value)` contributions for one property across
 * a set of contributions, in stable `(branchId, canonical-value)` order. Distinct
 * on `(branchId, value)`: two contributions from the same branch carrying the same
 * value collapse to one entry, but the same branch contributing two different
 * values is preserved (so an intra-branch contradiction stays visible).
 *
 * Shared by the node property union (T8) and the edge property union (T9) so the
 * determinism-critical dedupe + sort is defined exactly once and node/edge conflict
 * records are shaped identically.
 */
export function collectConflictingValues(
  property: string,
  contributions: readonly Contribution[],
): readonly ConflictingValue[] {
  const seen = new Set<string>();
  const values: ConflictingValue[] = [];
  for (const { branchId, props } of contributions) {
    if (!(property in props)) {
      continue;
    }
    const value = props[property] as JsonValue;
    const dedupeKey = `${branchId}\0${canonicalValueKey(value)}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    values.push({ branchId, value });
  }
  return [...values].sort((left, right) => {
    const byBranch = compareStrings(left.branchId, right.branchId);
    return byBranch === 0 ?
        compareStrings(
          canonicalValueKey(left.value),
          canonicalValueKey(right.value),
        )
      : byBranch;
  });
}

/**
 * Resolves one property conflict under the captured {@link ResolutionContext}.
 *
 * - If all contributing values are equal → that value, `conflicted: false`.
 * - `"flag"` → keep the canonical's value, `conflicted: true` (caller records a
 *   {@link PropertyConflict}; no auto-resolution).
 * - `"lastWriteWins"` → the value of the HIGHEST-PRIORITY branch (earliest in the
 *   stable order / lowest rank). NEVER wall-clock.
 * - `"provenanceWeighted"` → the value of the highest-weight branch (ties →
 *   highest-priority branch → canonical value order).
 * - function policy → the value returned by the delegate.
 *
 * @param input The conflicted property, its tagged candidate values, and the
 *   canonical survivor's own value.
 * @param context The captured policy + stable branch order + optional weights.
 * @param makeConflict Builds the {@link PropertyConflict}-shaped record passed to
 *   a function policy. Kept as a callback so this module needs no knowledge of
 *   the node-vs-edge entity shape.
 * @returns The surviving value and whether the values genuinely differed.
 */
function resolveConflictValue<G extends GraphDef = GraphDef>(
  input: ConflictInput,
  context: ResolutionContext<G>,
  branchRank: ReadonlyMap<BranchId, number>,
  makeConflict: (
    resolution: JsonValue,
  ) => Parameters<
    Extract<PropertyConflictPolicy<G>, (...args: never[]) => unknown>
  >[0],
): ConflictResolution {
  if (allValuesEqual(input.values)) {
    return {
      value: input.values[0]?.value ?? input.canonicalValue,
      conflicted: false,
    };
  }

  const { policy } = context;

  if (policy === "flag") {
    return { value: input.canonicalValue, conflicted: true };
  }
  if (policy === "lastWriteWins") {
    return {
      value: pickByPriority(input.values, branchRank),
      conflicted: true,
    };
  }
  if (policy === "provenanceWeighted") {
    const weights = context.weights ?? new Map<BranchId, number>();
    return {
      value: pickByWeight(input.values, weights, branchRank),
      conflicted: true,
    };
  }
  // Function policy: delegate, but first resolve a stable provisional value so
  // the conflict record handed to the delegate is itself deterministic.
  const provisional = pickByPriority(input.values, branchRank);
  const resolved = policy(makeConflict(provisional));
  return { value: resolved, conflicted: true };
}

/**
 * The resolve-and-record tail every property union shares (node cluster union T8,
 * edge collision union T9, inherited 3-way merge T8a): resolve the conflict, then —
 * if the values genuinely differed — build the public {@link PropertyConflict}. The
 * SINGLE place the conflict record is shaped, so the value the function policy sees
 * and the value recorded can never drift.
 *
 * `values` is the FULL contributing set the policy resolves over; `reportedValues`
 * is the PUBLIC subset (synthetic sentinels excluded) recorded on the conflict.
 */
export function resolvePropertyUnion<G extends GraphDef = GraphDef>(
  input: Readonly<{
    entityId: NodeId<NodeType> | EdgeId;
    kind: string;
    property: string;
    values: readonly ConflictingValue[];
    reportedValues: readonly ConflictingValue[];
    canonicalValue: JsonValue;
  }>,
  context: ResolutionContext<G>,
  branchRank: ReadonlyMap<BranchId, number>,
): Readonly<{ value: JsonValue; conflict: PropertyConflict<G> | undefined }> {
  const makeRecord = (resolution: JsonValue): PropertyConflict<G> => ({
    entityId: input.entityId,
    kind: input.kind,
    property: input.property,
    values: input.reportedValues,
    resolution,
  });
  const resolved = resolveConflictValue(
    {
      property: input.property,
      values: input.values,
      canonicalValue: input.canonicalValue,
    },
    context,
    branchRank,
    (resolution) => makeRecord(resolution),
  );
  return {
    value: resolved.value,
    conflict: resolved.conflicted ? makeRecord(resolved.value) : undefined,
  };
}
