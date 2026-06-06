/**
 * Edge repoint to canonical + set-dedupe cascade (design §6.3 / §6.4 rule 5, T9).
 *
 * After clustering (T8) collapses fork nodes into canonical survivors and
 * delete/modify resolution (T8a) fixes the FINAL LIVENESS of every endpoint, the
 * inherited and new edges of the merge must be:
 *
 *   1. REPOINTED — each endpoint mapped to its cluster's canonical id. An edge
 *      `x → a` where `{a, b}` collapsed to canonical `c*` becomes `x → c*`.
 *   2. DROPPED — any edge whose (repointed) `from` or `to` is a finally-deleted
 *      node (per T8a, NOT resurrected) is removed, recorded as a
 *      {@link DroppedItem} with reason {@link ENDPOINT_DELETED_DROP_REASON}.
 *   3. DEDUPED — repointing can make two distinct edges identical. Edges are
 *      collapsed as a pure SET operation keyed by
 *      `(fromCanonical | type | toCanonical | propsKey)`, where `propsKey` is the
 *      T2 canonical serializer over PARSED props. So `x → a` and `x → b` (both
 *      repointed to `x → c*`) with equal props yield a SINGLE `x → c*`.
 *   4. RECONCILED — when two edges collapse to the same `(from, type, to)` but
 *      carry DIFFERING props, the per-property disagreement is resolved by the
 *      shared T8 conflict policy ({@link resolveConflictValue}) on the captured,
 *      non-wall-clock branch order, recording an edge-level {@link PropertyConflict}
 *      whose `entityId` is the surviving edge's id.
 *
 * Determinism: the dedupe is a pure function of the (unordered) staged-edge SET.
 * Within a collision group the surviving edge id is the lexicographically-minimal
 * member id, property resolution uses only the captured `branchRank`, and the
 * output is sorted by dedupe key — so shuffling the input edges yields an
 * identical result. Clusters are computed once upstream (T8) and passed in as
 * {@link canonicalOf}; this module never re-clusters.
 */

import { canonicalizeProps, canonicalValueKey } from "./canonical-props";
import type { ClusterResult } from "./clustering";
import type { ProvenanceWeights, ResolutionContext } from "./conflict-policy";
import { resolveConflictValue } from "./conflict-policy";
import {
  compareStrings,
  idOf,
  kindOf,
  type MergeKey,
  mergeKey,
} from "./node-key";
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

/** A node id in its untyped (`NodeType`-default) branded form. */
type AnyNodeId = NodeId<NodeType>;

/** Reason recorded on a {@link DroppedItem} for an edge to a deleted endpoint. */
export const ENDPOINT_DELETED_DROP_REASON = "edge:endpoint-deleted" as const;

/**
 * A `{ kind: "edge" }` dropped item. Mirrors the public {@link DroppedItem} but is
 * narrowed to edges so this module's output is precisely typed. Structurally
 * assignable to {@link DroppedItem}.
 */
export type DroppedEdge = Readonly<{
  kind: "edge";
  id: EdgeId;
  reason: string;
}>;

/**
 * One staged edge fed into the repoint phase: a new fork edge or a surviving
 * inherited edge. Carries the parsed props (NOT a JSON string) so the dedupe key
 * and the conflict union both operate on the canonical structure, and the
 * {@link BranchId} that contributed it so edge-property conflicts resolve on the
 * same stable branch order as node-property conflicts.
 *
 * The orchestrator (T11) builds these from `StagedNewEdge` / surviving
 * `StagedModifiedEdge` items (T7); this module needs no knowledge of the diff
 * shape beyond these fields.
 */
export type StagedEdge = Readonly<{
  id: EdgeId;
  kind: string;
  fromId: AnyNodeId;
  toId: AnyNodeId;
  fromKind: string;
  toKind: string;
  props: Readonly<Record<string, JsonValue>>;
  branchId: BranchId;
}>;

/**
 * A surviving merged edge after repoint + dedupe. `id` is the canonical survivor
 * of its collision group (the lexicographically-minimal contributing edge id);
 * `mergedIds` is every staged edge id that collapsed into it (always includes
 * `id`), so the commit phase (T11) knows which inherited edges to fold away.
 */
export type MergedEdge = Readonly<{
  id: EdgeId;
  kind: string;
  fromId: AnyNodeId;
  toId: AnyNodeId;
  fromKind: string;
  toKind: string;
  props: Readonly<Record<string, JsonValue>>;
  mergedIds: readonly EdgeId[];
}>;

/**
 * The outcome of the repoint + dedupe cascade: the surviving merged edges, every
 * edge dropped for a deleted endpoint, and every edge-level property conflict the
 * dedupe surfaced.
 */
export type EdgeRepointResult<G extends GraphDef = GraphDef> = Readonly<{
  edges: readonly MergedEdge[];
  dropped: readonly DroppedEdge[];
  conflicts: readonly PropertyConflict<G>[];
}>;

/**
 * Builds the endpoint → canonical map from the resolved clusters. Every member of
 * a cluster maps to that cluster's canonical id; ids absent from the map (cluster
 * singletons / nodes never compared) are treated as their own canonical by the
 * `?? id` fallback at lookup time, so the map need only carry the rewrites.
 *
 * @param clusters Resolved clusters (T8). Each must be non-empty.
 * @param canonicalOf A `cluster → canonicalId` selector (T8 `pickCanonical`),
 *   threaded so this module reuses the merge-wide canonical choice rather than
 *   re-deriving it.
 */
export function buildCanonicalMap(
  clusters: readonly ClusterResult[],
  canonicalOf: (cluster: ClusterResult) => MergeKey,
): ReadonlyMap<MergeKey, MergeKey> {
  const map = new Map<MergeKey, MergeKey>();
  for (const cluster of clusters) {
    const canonical = canonicalOf(cluster);
    for (const member of cluster.members) {
      map.set(member, canonical);
    }
  }
  return map;
}

/**
 * Resolves an endpoint IDENTITY (`(kind, id)` key) to its cluster canonical,
 * defaulting to itself. Keying on the composite identity is what stops an edge from
 * a `Patient` and an edge from an `Encounter` that share an endpoint id from being
 * repointed onto the same survivor.
 */
function repoint(
  key: MergeKey,
  canonicalOf: ReadonlyMap<MergeKey, MergeKey>,
): MergeKey {
  return canonicalOf.get(key) ?? key;
}

/**
 * The dedupe key for a repointed edge: a JSON-encoded `[from', type, to',
 * propsKey]` tuple. The `propsKey` is the T2 canonical serializer over the PARSED
 * props, so two edges that agree on endpoints, type, AND every property collapse to
 * one regardless of property key order. JSON-encoding the tuple (rather than
 * concatenating with a literal separator) keeps the key unambiguous even when an
 * edge `type` — a user-defined schema string — or a caller-supplied endpoint id
 * contains the separator character.
 */
function dedupeKey(
  fromKey: MergeKey,
  type: string,
  toKey: MergeKey,
  props: Readonly<Record<string, JsonValue>>,
): string {
  return JSON.stringify([fromKey, type, toKey, canonicalizeProps(props)]);
}

/**
 * The key identifying a collision GROUP — edges sharing `(from', type, to')`
 * regardless of props. Edges in the same group but with differing props are the
 * ones whose properties must be reconciled by the conflict policy. JSON-encoded
 * (see {@link dedupeKey}) so a `|`-bearing type/id can never fuse two distinct
 * groups.
 */
function groupKey(fromKey: MergeKey, type: string, toKey: MergeKey): string {
  return JSON.stringify([fromKey, type, toKey]);
}

/**
 * A repointed staged edge plus both endpoints already mapped to their canonical
 * IDENTITY key (`(kind, id)`). The composite keys carry the canonical node's kind, so
 * the surviving edge's bare `fromId`/`toId` and `fromKind`/`toKind` are read off
 * `idOf`/`kindOf` of these keys — never the (possibly different-kind) staged endpoint.
 */
type RepointedEdge = Readonly<{
  staged: StagedEdge;
  fromKey: MergeKey;
  toKey: MergeKey;
}>;

/**
 * Collects the distinct `(branchId, value)` contributions for one property across
 * the edges of a collision group, in stable `(branchId, canonical-value)` order.
 * Distinct on `(branchId, value)`, mirroring the node property union (T8) so the
 * conflict record is shaped identically for nodes and edges.
 */
function collectEdgeValues(
  property: string,
  edges: readonly RepointedEdge[],
): readonly ConflictingValue[] {
  const seen = new Set<string>();
  const values: ConflictingValue[] = [];
  for (const edge of edges) {
    if (!(property in edge.staged.props)) {
      continue;
    }
    const value = edge.staged.props[property] as JsonValue;
    const branchId = edge.staged.branchId;
    const key = `${branchId} ${canonicalValueKey(value)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    values.push({ branchId, value });
  }
  return [...values].sort((left, right) => {
    const byBranch = compareStrings(left.branchId, right.branchId);
    return byBranch === 0 ? (
        compareStrings(
          canonicalValueKey(left.value),
          canonicalValueKey(right.value),
        )
      ) : byBranch;
  });
}

/**
 * Picks the canonical survivor edge of a collision group: the member with the
 * lexicographically-minimal edge id. Mirrors the node min-id canonical rule (T8)
 * so the surviving id is independent of input edge order. (`generateId()` is
 * nanoid — random, not time-prefixed — so min-id never leaks creation order.)
 */
function pickSurvivor(edges: readonly RepointedEdge[]): RepointedEdge {
  let survivor = edges[0]!;
  for (const candidate of edges.slice(1)) {
    if (candidate.staged.id < survivor.staged.id) {
      survivor = candidate;
    }
  }
  return survivor;
}

/**
 * Unions the props of one collision group's edges, resolving any per-property
 * disagreement via the shared T8 conflict policy. Returns the surviving prop bag
 * plus an edge-level {@link PropertyConflict} for every property that genuinely
 * differed (its `entityId` is the surviving edge id).
 */
function unionEdgeProps(
  survivorId: EdgeId,
  kind: string,
  survivor: RepointedEdge,
  edges: readonly RepointedEdge[],
  context: ResolutionContext<GraphDef>,
  branchRank: ReadonlyMap<BranchId, number>,
): Readonly<{
  props: Record<string, JsonValue>;
  conflicts: PropertyConflict[];
}> {
  const propertyNames = new Set<string>();
  for (const edge of edges) {
    for (const name of Object.keys(edge.staged.props)) {
      propertyNames.add(name);
    }
  }

  const props: Record<string, JsonValue> = {};
  const conflicts: PropertyConflict[] = [];

  for (const property of [...propertyNames].sort((left, right) =>
    compareStrings(left, right),
  )) {
    const values = collectEdgeValues(property, edges);
    if (values.length === 0) {
      continue;
    }
    const canonicalValue =
      (property in survivor.staged.props ?
        (survivor.staged.props[property] as JsonValue)
      : values[0]!.value) ?? null;

    const resolved = resolveConflictValue(
      { property, values, canonicalValue },
      context,
      branchRank,
      (resolution) => ({
        entityId: survivorId,
        kind,
        property,
        values,
        resolution,
      }),
    );
    props[property] = resolved.value;
    if (resolved.conflicted) {
      conflicts.push({
        entityId: survivorId,
        kind,
        property,
        values,
        resolution: resolved.value,
      });
    }
  }

  return { props, conflicts };
}

/**
 * Repoints every staged edge onto its cluster canonical, drops edges whose
 * (repointed) endpoints are finally deleted, and dedupes the survivors as a pure
 * set operation keyed by `(from' | type | to' | propsKey)`.
 *
 * Within a collision group sharing `(from', type, to')`:
 *   - identical props collapse silently to one edge,
 *   - DIFFERING props are reconciled by `policy` on the captured `branchRank`,
 *     recording one edge-level {@link PropertyConflict} per disagreeing property.
 *
 * The surviving edge of every group is the lexicographically-minimal contributing
 * edge id; its `mergedIds` lists every collapsed edge id. Output is sorted by the
 * full dedupe key, so the result is a pure function of the unordered input set.
 *
 * @param stagedEdges The new + surviving-inherited edges to merge. Order does not
 *   affect the result. Props MUST already be parsed objects.
 * @param canonicalOf The endpoint → canonical map (from {@link buildCanonicalMap}).
 *   Endpoints absent from it map to themselves.
 * @param deletedNodeIds The AUTHORITATIVE finally-deleted node id set (T8a). Any
 *   edge whose repointed `from`/`to` is in this set is dropped.
 * @param policy The property-conflict policy (shared with node union, T8).
 * @param branchRank The captured stable branch rank (built once via
 *   `buildBranchRank`). Used only for deterministic conflict resolution — never
 *   wall-clock.
 * @param weights Optional per-branch weights for the `"provenanceWeighted"` policy.
 */
export function repointEdges<G extends GraphDef = GraphDef>(
  stagedEdges: readonly StagedEdge[],
  canonicalOf: ReadonlyMap<MergeKey, MergeKey>,
  deletedNodeIds: ReadonlySet<MergeKey>,
  policy: PropertyConflictPolicy<G>,
  branchRank: ReadonlyMap<BranchId, number>,
  weights?: ProvenanceWeights,
): EdgeRepointResult<G> {
  const dropped: DroppedEdge[] = [];
  const liveByDedupeKey = new Map<string, RepointedEdge[]>();
  // Per `(from', type, to')` group → the SET of distinct dedupe keys seen for it.
  // Insertion order is irrelevant: Phase 2 re-derives the survivor and sorts the
  // output explicitly, so the set carries membership only.
  const dedupeKeyByGroup = new Map<string, Set<string>>();

  // Phase 1: repoint endpoints (by their `(kind, id)` identity, so a cross-kind id
  // collision can never repoint two unrelated edges onto one survivor), drop edges to
  // deleted nodes, and bucket the survivors by their full dedupe key.
  for (const staged of stagedEdges) {
    const fromKey = repoint(
      mergeKey(staged.fromKind, staged.fromId),
      canonicalOf,
    );
    const toKey = repoint(mergeKey(staged.toKind, staged.toId), canonicalOf);

    if (deletedNodeIds.has(fromKey) || deletedNodeIds.has(toKey)) {
      dropped.push({
        kind: "edge",
        id: staged.id,
        reason: ENDPOINT_DELETED_DROP_REASON,
      });
      continue;
    }

    const repointed: RepointedEdge = { staged, fromKey, toKey };
    const key = dedupeKey(fromKey, staged.kind, toKey, staged.props);
    const bucket = liveByDedupeKey.get(key);
    if (bucket === undefined) {
      liveByDedupeKey.set(key, [repointed]);
    } else {
      bucket.push(repointed);
    }

    const group = groupKey(fromKey, staged.kind, toKey);
    const keysForGroup = dedupeKeyByGroup.get(group);
    if (keysForGroup === undefined) {
      dedupeKeyByGroup.set(group, new Set([key]));
    } else {
      keysForGroup.add(key);
    }
  }

  // Phase 2: per `(from', type, to')` group, fold the per-dedupe-key buckets into
  // one survivor. A group with a single dedupe key is an exact-equal collapse (no
  // conflict); a group with several dedupe keys means props differ, so the union
  // runs the conflict policy.
  const context: ResolutionContext<GraphDef> = {
    policy: policy as PropertyConflictPolicy<GraphDef>,
    ...(weights === undefined ? {} : { weights }),
  };

  const merged: MergedEdge[] = [];
  const conflicts: PropertyConflict<G>[] = [];

  const sortedGroups = [...dedupeKeyByGroup.keys()].sort((left, right) =>
    compareStrings(left, right),
  );

  for (const group of sortedGroups) {
    const dedupeKeys = [...dedupeKeyByGroup.get(group)!];
    const groupEdges: RepointedEdge[] = [];
    for (const key of dedupeKeys) {
      for (const edge of liveByDedupeKey.get(key)!) {
        groupEdges.push(edge);
      }
    }

    const survivor = pickSurvivor(groupEdges);
    const survivorId = survivor.staged.id;
    const mergedIds = [...groupEdges]
      .map((edge) => edge.staged.id)
      .sort((left, right) => compareStrings(left, right));

    // Endpoint ids AND kinds come from the canonical IDENTITY keys, so a repointed
    // edge always names the canonical node's own kind (the commit then applies any
    // retype cascade), never a staged endpoint that merely shared the id string.
    const fromId = idOf(survivor.fromKey);
    const fromKind = kindOf(survivor.fromKey);
    const toId = idOf(survivor.toKey);
    const toKind = kindOf(survivor.toKey);

    if (dedupeKeys.length === 1) {
      // Exact-equal collapse: every member shares identical props, so no
      // conflict is possible — keep the survivor's props verbatim.
      merged.push({
        id: survivorId,
        kind: survivor.staged.kind,
        fromId,
        toId,
        fromKind,
        toKind,
        props: survivor.staged.props,
        mergedIds,
      });
      continue;
    }

    const { props, conflicts: groupConflicts } = unionEdgeProps(
      survivorId,
      survivor.staged.kind,
      survivor,
      groupEdges,
      context,
      branchRank,
    );
    for (const conflict of groupConflicts) {
      conflicts.push(conflict as PropertyConflict<G>);
    }
    merged.push({
      id: survivorId,
      kind: survivor.staged.kind,
      fromId,
      toId,
      fromKind,
      toKind,
      props,
      mergedIds,
    });
  }

  // Sort on a PRECOMPUTED dedupe key per edge (Schwartzian) so `canonicalizeProps` +
  // serialization run once per edge, not twice on every comparison.
  const sortedEdges = merged
    .map((edge) => ({
      edge,
      sortKey: dedupeKey(
        mergeKey(edge.fromKind, edge.fromId),
        edge.kind,
        mergeKey(edge.toKind, edge.toId),
        edge.props,
      ),
    }))
    .sort((left, right) => compareStrings(left.sortKey, right.sortKey))
    .map(({ edge }) => edge);

  return {
    edges: sortedEdges,
    dropped: dropped.sort((left, right) => compareStrings(left.id, right.id)),
    conflicts: conflicts.sort((left, right) =>
      compareStrings(
        `${left.entityId}|${left.property}`,
        `${right.entityId}|${right.property}`,
      ),
    ),
  };
}
