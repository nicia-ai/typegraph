import { requireDefined } from "../utils/presence";
/**
 * Canonical survivor selection + commutative property union (design §6.4 rule 3
 * & rule 4 / §7.3, T8).
 *
 * Given a {@link ClusterResult} (member ids) and the per-member, per-branch
 * property contributions, this module:
 *
 *   1. Picks the CANONICAL survivor — by default the member with the
 *      lexicographically-minimal node id (`MergeOptions.canonical` overrides).
 *      Because `generateId()` is nanoid (random, NOT time-prefixed), min-id is
 *      independent of creation order — the canonical choice cannot leak the
 *      order nodes were created or branches were merged in.
 *   2. UNIONS properties across all members: per property, collect every
 *      `(branchId, value)`; if all agree → that value; if they differ → defer to
 *      the conflict policy on a STABLE non-wall-clock branch order (T8 /
 *      `conflict-policy.ts`), recording a {@link PropertyConflict}.
 *
 * The result is a pure function of the (unordered) member set + the captured
 * branch order, so shuffling members or branches yields an identical resolution.
 */
import type { ClusterResult } from "./clustering";
import type { ProvenanceWeights, ResolutionContext } from "./conflict-policy";
import {
  collectConflictingValues,
  resolvePropertyUnion,
} from "./conflict-policy";
import { compareMergeKeys, compareStrings, idOf, mergeKeyOf } from "./node-key";
import type {
  GraphDef,
  JsonValue,
  NodeId,
  NodeType,
} from "./typegraph-internal";
import type {
  BranchId,
  ConflictingValue,
  EntityResolution,
  PropertyConflict,
  PropertyConflictPolicy,
  ResolvedCluster,
} from "./types";
import { asBranchId } from "./types";

/**
 * Reserved provenance "branch" for a BASE contribution (§6.4-D). A committed base
 * member has no real branch; this BranchId-shaped sentinel is the key its
 * contributions carry through the value union and the provenance records, so those
 * paths tolerate a base member without a separate code path. It is NOT a real branch
 * id — it is EXCLUDED from the public {@link EntityResolution.branchOrigins} (which
 * lists only real contributing branches), and callers must never mint a branch with
 * this reserved value (rejected at the merge boundary; kept NUL-free so it round-trips
 * through `persistProvenance` on every backend).
 */
export const BASE_PROVENANCE_BRANCH: BranchId =
  asBranchId("__committed_base__");

/** A node id in its untyped (`NodeType`-default) branded form. */
type AnyNodeId = NodeId<NodeType>;

/**
 * Where a {@link ClusterMember}'s contribution originated: a branch's STAGED diff,
 * or a committed BASE node a base source pulled into the cluster (design §6.4-C).
 * The mandatory `branchId` cannot represent a base member, so this discriminator is
 * what lets the reconciler tell the two apart — it enforces base-id-wins (§6.4-C: a
 * base member is the canonical survivor, see {@link pickClusterSurvivor}) and tags
 * base provenance with {@link BASE_PROVENANCE_BRANCH} (§6.4-D). The new-vs-base
 * sources (`baseUnique`) emit `"base"` members; the public snapshot `merge()` path
 * stays staged-only, so every member there is `"staged"`.
 */
type MemberOrigin = "staged" | "base";

/**
 * One member of a cluster, with the parsed props the contributing branch staged
 * for it. A node that appears in several branches contributes several
 * {@link ClusterMember} entries (one per branch), so property differences across
 * branches surface as conflicts.
 */
export type ClusterMember = Readonly<{
  origin: MemberOrigin;
  id: AnyNodeId;
  kind: string;
  branchId: BranchId;
  props: Readonly<Record<string, JsonValue>>;
}>;

/**
 * The fully-resolved canonical entity for one cluster: the survivor id, the
 * unioned property bag, the {@link EntityResolution} record, and any
 * {@link PropertyConflict}s the union surfaced.
 */
export type CanonicalEntity = Readonly<{
  canonicalId: AnyNodeId;
  kind: string;
  props: Readonly<Record<string, JsonValue>>;
  resolution: EntityResolution;
  conflicts: readonly PropertyConflict[];
}>;

/**
 * Bare-id reference selector over a PUBLIC {@link ResolvedCluster}: the member with
 * the lexicographically-minimal node id, or the caller's override. It is NOT the
 * live survivor selector — the merge path selects survivors via
 * {@link pickClusterSurvivor}, which is cross-kind-aware (composite `(kind, id)`
 * keys), enforces base-id-wins, and is where the {@link MergeOptions.canonical} hook
 * is actually consulted. Kept as the documented bare-id default a `canonical` hook
 * mirrors; do not wire new phases onto this helper.
 */
export function pickCanonical(
  cluster: ResolvedCluster,
  override?: (cluster: ResolvedCluster) => AnyNodeId,
): AnyNodeId {
  if (override !== undefined) {
    return override(cluster);
  }
  return requireDefined(
    [...cluster.members].sort((left, right) => compareStrings(left, right))[0],
  );
}

/**
 * Selects a cluster's canonical survivor MEMBER, enforcing BASE-ID-WINS (§6.4-C)
 * UPSTREAM of the `MergeOptions.canonical` hook. Returning the member (not just its
 * id) carries the survivor's KIND alongside its id, so the canonical entity's kind is
 * the survivor's own kind — never a different-kind member that merely shares the id
 * string (the cross-kind identity hazard).
 *
 *   - if the cluster contains a BASE member, the committed base identity is the
 *     survivor and the hook is BYPASSED — the committed identity (and everything
 *     pointing at it) must stay stable, so this is a commit-correctness invariant,
 *     not a survivor preference. By §6.4-A a merged cluster holds ≤1 base member; the
 *     min base `(id, kind)` is taken defensively so selection is deterministic even
 *     before that guard lands.
 *   - otherwise the cluster is pure staged-vs-staged and the hook (mapped over the
 *     bare-id view of the cluster) or the min-`(id, kind)` default applies.
 */
function pickClusterSurvivor(
  members: readonly ClusterMember[],
  cluster: ClusterResult,
  canonicalOverride?: (cluster: ResolvedCluster) => AnyNodeId,
  preferKind?: (kinds: readonly string[]) => string | undefined,
): ClusterMember {
  const byKey = (left: ClusterMember, right: ClusterMember): number =>
    compareMergeKeys(mergeKeyOf(left), mergeKeyOf(right));

  // base-id-wins (§6.4-C): the committed identity is the survivor outright. By the
  // staged-only ontology-retype rule, a base member never shares an id with a
  // different-kind member, so no cross-kind kind choice arises here.
  const baseMembers = members
    .filter((member) => member.origin === "base")
    .sort(byKey);
  if (baseMembers.length > 0) {
    return requireDefined(baseMembers[0]);
  }

  // The survivor's bare id: the override's pick (mapped over the bare-id view of the
  // cluster) when it names a real member, else the minimum identity's id.
  let canonicalId: AnyNodeId | undefined;
  if (canonicalOverride !== undefined) {
    const chosen = canonicalOverride({ members: cluster.members.map(idOf) });
    if (members.some((member) => member.id === chosen)) {
      canonicalId = chosen;
    }
  }
  if (canonicalId === undefined) {
    const minIdentity = [...cluster.members].sort((left, right) =>
      compareMergeKeys(left, right),
    )[0];
    canonicalId =
      minIdentity === undefined ?
        requireDefined(members[0]).id
      : idOf(minIdentity);
  }

  // Among the members AT that id, choose the KIND. An ontology-retype cluster carries
  // several subtype-compatible kinds under one id; `preferKind` selects the
  // MOST-SPECIFIC one, BYPASSING the bare-id hook (which cannot tell `Doctor:x` from
  // `SpecialistDoctor:x`). Otherwise the id has a single kind and the min `(id, kind)`
  // member is taken.
  const membersAtId = members.filter((member) => member.id === canonicalId);
  if (membersAtId.length === 0) {
    return requireDefined([...members].sort(byKey)[0]);
  }
  const kinds = [...new Set(membersAtId.map((member) => member.kind))];
  const chosenKind =
    preferKind !== undefined && kinds.length > 1 ?
      preferKind(kinds)
    : undefined;
  return (
    (chosenKind === undefined ? undefined : (
      membersAtId.find((member) => member.kind === chosenKind)
    )) ?? requireDefined([...membersAtId].sort(byKey)[0])
  );
}

function findPreferredMember(
  members: readonly ClusterMember[],
  property: string,
  preferredBranchId: BranchId | undefined,
): ClusterMember | undefined {
  if (preferredBranchId === undefined) {
    return undefined;
  }
  return members.find(
    (member) =>
      member.branchId === preferredBranchId && property in member.props,
  );
}

function memberPropertyValue(
  member: ClusterMember,
  property: string,
): JsonValue | undefined {
  if (!(property in member.props)) {
    return undefined;
  }
  return member.props[property];
}

function pickCanonicalPropertyValue(
  canonicalMember: ClusterMember,
  members: readonly ClusterMember[],
  property: string,
  values: readonly ConflictingValue[],
  preferredBranchId: BranchId | undefined,
): JsonValue {
  const preferredMember = findPreferredMember(
    members,
    property,
    preferredBranchId,
  );
  const preferredValue =
    preferredMember === undefined ? undefined : (
      memberPropertyValue(preferredMember, property)
    );
  if (preferredValue !== undefined) {
    return preferredValue;
  }

  const canonicalValue = memberPropertyValue(canonicalMember, property);
  return canonicalValue === undefined ?
      requireDefined(values[0]).value
    : canonicalValue;
}

/**
 * Unions the properties of a cluster's members into a single canonical property
 * bag, resolving any per-property disagreement via the conflict policy on a
 * stable branch order. Returns the merged props plus a {@link PropertyConflict}
 * for every property that genuinely differed.
 *
 * @param canonicalId The survivor id (from {@link pickClusterSurvivor}); the entity id
 *   on every recorded conflict.
 * @param kind The canonical entity's kind, recorded on each conflict.
 * @param members Every `(branchId, props)` contribution for this cluster.
 * @param context The captured policy + stable branch order + optional weights.
 * @param branchRank The branch rank lookup (built once, shared across clusters).
 */
function unionProperties(
  canonicalMember: ClusterMember,
  members: readonly ClusterMember[],
  context: ResolutionContext<GraphDef>,
  baseContext: ResolutionContext<GraphDef>,
  branchRank: ReadonlyMap<BranchId, number>,
  preferredBranchId?: BranchId,
): Readonly<{
  props: Record<string, JsonValue>;
  conflicts: PropertyConflict[];
}> {
  const canonicalId = canonicalMember.id;
  const kind = canonicalMember.kind;
  const hasBaseMember = members.some((member) => member.origin === "base");

  const propertyNames = new Set<string>();
  for (const member of members) {
    for (const name of Object.keys(member.props)) {
      propertyNames.add(name);
    }
  }

  const props: Record<string, JsonValue> = {};
  const conflicts: PropertyConflict[] = [];

  for (const property of [...propertyNames].sort((left, right) =>
    compareStrings(left, right),
  )) {
    const values = collectConflictingValues(property, members);
    if (values.length === 0) {
      continue;
    }
    const canonicalValue = pickCanonicalPropertyValue(
      canonicalMember,
      members,
      property,
      values,
      preferredBranchId,
    );

    // A disagreement that involves a committed BASE value is governed by the
    // SEPARATE onBasePropertyConflict policy (§6.4-C) — it must not inherit the
    // staged policy, which could let a branch overwrite committed data. Because
    // base-id-wins makes the base member canonical, `canonicalValue` is already the
    // committed value, so `"flag"` keeps it. A property the base lacks is a pure
    // gap-fill / staged-vs-staged conflict and uses the staged policy.
    const baseInvolved =
      hasBaseMember &&
      members.some(
        (member) => member.origin === "base" && property in member.props,
      );

    // Resolution math sees the FULL contributions (including the base value, so the
    // disagreement is detected and base-id-wins resolves it). But the reserved
    // {@link BASE_PROVENANCE_BRANCH} sentinel is NOT a real branch, so it is excluded
    // from the PUBLIC conflict's `values` — exactly as it is from `branchOrigins`. The
    // committed value the base contributed still surfaces as the conflict `resolution`.
    const reportedValues = values.filter(
      (value) =>
        value.branchId !== BASE_PROVENANCE_BRANCH &&
        value.branchId !== preferredBranchId,
    );
    const { value, conflict } = resolvePropertyUnion(
      {
        entityId: canonicalId,
        kind,
        property,
        values,
        reportedValues,
        canonicalValue,
      },
      baseInvolved ? baseContext : context,
      branchRank,
    );
    props[property] = value;
    if (conflict !== undefined) {
      conflicts.push(conflict);
    }
  }

  return { props, conflicts };
}

/**
 * Resolves a single cluster into its {@link CanonicalEntity}: picks the survivor,
 * unions properties under the conflict policy, and assembles the
 * {@link EntityResolution} record.
 *
 * @param cluster The cluster's member ids (id-sorted from T8 clustering).
 * @param members The per-branch property contributions for those member ids.
 * @param policy The staged-vs-staged property-conflict policy.
 * @param branchRank The captured stable branch rank (built once).
 * @param weights Optional per-branch trust weights for `"provenanceWeighted"`.
 * @param canonicalOverride Optional `MergeOptions.canonical` survivor selector.
 * @param basePolicy The SEPARATE base↔branch policy (§6.4-C, `onBasePropertyConflict`)
 *   governing conflicts that involve a committed base value. Defaults to `"flag"`
 *   (keep committed value) — it never inherits `policy`.
 */
export function canonicalizeCluster(
  cluster: ClusterResult,
  members: readonly ClusterMember[],
  policy: PropertyConflictPolicy,
  branchRank: ReadonlyMap<BranchId, number>,
  weights?: ProvenanceWeights,
  canonicalOverride?: (cluster: ResolvedCluster) => AnyNodeId,
  basePolicy: PropertyConflictPolicy = "flag",
  preferKind?: (kinds: readonly string[]) => string | undefined,
  preferredBranchId?: BranchId,
): CanonicalEntity {
  const survivor = pickClusterSurvivor(
    members,
    cluster,
    canonicalOverride,
    preferKind,
  );
  const canonicalId = survivor.id;
  const kind = survivor.kind;

  const context: ResolutionContext<GraphDef> = {
    policy,
    ...(weights === undefined ? {} : { weights }),
  };
  const baseContext: ResolutionContext<GraphDef> = {
    policy: basePolicy,
    ...(weights === undefined ? {} : { weights }),
  };

  const { props, conflicts } = unionProperties(
    survivor,
    members,
    context,
    baseContext,
    branchRank,
    preferredBranchId,
  );

  // The public resolution reports the DISTINCT bare member ids; the cluster carries
  // composite `(kind, id)` keys, so project each to its id and dedup (an ontology
  // retype puts several kinds under one id, which collapses to a single member id).
  const memberIds = [
    ...new Set(cluster.members.map((member) => idOf(member))),
  ].sort((left, right) => compareStrings(left, right));
  // `branchOrigins` lists the REAL contributing branches; the reserved
  // {@link BASE_PROVENANCE_BRANCH} sentinel a base member carries is NOT a branch, so
  // it is excluded from this public field (it still flows through the value union and
  // the provenance records, which is where a base contribution is tracked).
  const branchOrigins = [
    ...new Set(
      members
        .map((member) => member.branchId)
        .filter(
          (branchId) =>
            branchId !== BASE_PROVENANCE_BRANCH &&
            branchId !== preferredBranchId,
        ),
    ),
  ].sort((left, right) => compareStrings(left, right));

  const resolution: EntityResolution = {
    canonicalId,
    memberIds,
    kind,
    branchOrigins,
  };

  return { canonicalId, kind, props, resolution, conflicts };
}
