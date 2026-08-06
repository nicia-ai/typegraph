import { requireDefined } from "../utils/presence";
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
 *   3. DEDUPED — repointing can make two distinct edges identical. Edges brought
 *      together THAT WAY are collapsed as a pure SET operation keyed by
 *      `(fromCanonical | type | toCanonical | propsKey)`, where `propsKey` is the
 *      T2 canonical serializer over PARSED props. So `x → a` and `x → b` (both
 *      repointed to `x → c*`) with equal props yield a SINGLE `x → c*`.
 *   4. RECONCILED — when two such edges collapse to the same `(from, type, to)`
 *      but carry DIFFERING props, the per-property disagreement is resolved by the
 *      shared T8 conflict policy ({@link resolvePropertyUnion}) on the captured,
 *      non-wall-clock branch order, recording an edge-level {@link PropertyConflict}
 *      whose `entityId` is the surviving edge's id.
 *
 * SCOPE OF THE FOLD (issue #393). Steps 3 and 4 apply ONLY to a collision the
 * repointing INDUCED. The store is a MULTIGRAPH: nothing enforces uniqueness on
 * `(from, type, to)`, `create()` makes a parallel edge, and
 * `getOrCreateByEndpoints()` is the opt-in set-semantics accessor. Folding edges
 * that ALREADY named the same endpoints would therefore destroy authored
 * multigraph intent and break branch-effect commutativity — a merge must produce
 * what the operation would have produced applied directly to the target, and
 * `create(x, y, props)` on the target yields a parallel edge.
 *
 * So the fold groups by PRE-REPOINT endpoint pair ({@link foldSets}): one row per
 * pair collapses into a single set — that is the `x → a` / `x → b` case above —
 * and every further row a pair authored commits as its own parallel row. A group
 * that MIXES the two folds only across the pairs: a repointed `x → b` joining two
 * parallel `x → a` rows collapses into the lower-id one of them and the other
 * still commits, because repointing said nothing about the rows already there.
 *
 * What makes two staged edges one ROW is their EDGE ID, not equal props:
 * re-staging one INHERITED row from several branches is the same row (it folds, so
 * concurrent property edits still reconcile into one write), while a
 * branch-CREATED row carries a fresh id and is a new parallel edge even when its
 * props happen to coincide with an inherited one's. Consequently a window claim
 * lands on the row its author touched.
 *
 * SURVIVOR OF A FOLD (issue #395). A fold REWRITES the row it keeps and never
 * deletes the rows that folded into it, so which member survives is a matter of
 * commit correctness rather than taste: a survivor the target does not already hold
 * would leave every committed member of the set live BESIDE its own replacement,
 * carrying the props it had before the merge and never receiving the edit staged for
 * it. So an INHERITED member wins survivorship whenever the set holds one — the edge
 * analog of the node path's base-id-wins (design §6.4-C) — and only a set that is
 * entirely branch-created falls back to the minimum edge id (see
 * {@link pickSurvivor}). This is why {@link StagedEdge} carries its
 * {@link StagedEdgeOrigin}.
 *
 * Determinism: the dedupe is a pure function of the (unordered) staged-edge SET.
 * Group membership derives only from the staged endpoints and {@link canonicalOf} —
 * never from id sort order. Within a folded group the survivor is chosen by origin
 * and edge id alone, property resolution uses only the captured `branchRank`, and
 * the output is sorted by dedupe key with the edge id as the final tiebreaker
 * (parallel edges can share every other component) — so shuffling the input edges
 * yields an identical result. Clusters are computed once upstream (T8) and passed in
 * as {@link canonicalOf}; this module never re-clusters.
 */
import { canonicalizeProps } from "./canonical-props";
import type { ClusterResult } from "./clustering";
import type { ProvenanceWeights, ResolutionContext } from "./conflict-policy";
import {
  collectConflictingValues,
  resolvePropertyUnion,
} from "./conflict-policy";
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
  PropertyConflict,
  PropertyConflictPolicy,
} from "./types";
import { resolveEndClaims } from "./valid-window";

/** A node id in its untyped (`NodeType`-default) branded form. */
type AnyNodeId = NodeId<NodeType>;

/** Reason recorded on a {@link DroppedItem} for an edge to a deleted endpoint. */
export const ENDPOINT_DELETED_DROP_REASON = "edge:endpoint-deleted" as const;

/**
 * A `{ kind: "edge" }` dropped item. Mirrors the public {@link DroppedItem} but is
 * narrowed to edges so this module's output is precisely typed. Structurally
 * assignable to {@link DroppedItem}.
 */
type DroppedEdge = Readonly<{
  kind: "edge";
  id: EdgeId;
  reason: string;
}>;

/** {@link StagedEdgeOrigin} of a row the merge base already holds. */
export const INHERITED_EDGE_ORIGIN = "inherited" as const;

/** {@link StagedEdgeOrigin} of a row a branch created after the fork point. */
export const BRANCH_CREATED_EDGE_ORIGIN = "branch-created" as const;

/**
 * Whether a staged edge's ROW already existed at the fork point its branch diffed
 * against, or was created after it. It is the diff BUCKET the staging phase (T7) put the
 * edge in — a modified or re-windowed inherited edge is {@link INHERITED_EDGE_ORIGIN}, a
 * new fork edge is {@link BRANCH_CREATED_EDGE_ORIGIN} — threaded through as data because
 * nothing about an edge id reveals its origin (ids are opaque and may be caller-chosen,
 * so re-deriving one from the id is not possible, not merely unwise).
 *
 * Survivor selection is the consumer: an inherited row is one the merge target already
 * holds, so a fold must land on it (see {@link pickSurvivor}). Note this is not a
 * liveness dichotomy — an incremental target's OWN new edge is
 * {@link BRANCH_CREATED_EDGE_ORIGIN} while being a live committed row of the target too,
 * which is why the order between the two is a decision {@link pickSurvivor} has to make
 * rather than a tautology.
 */
type StagedEdgeOrigin =
  typeof INHERITED_EDGE_ORIGIN | typeof BRANCH_CREATED_EDGE_ORIGIN;

/**
 * One staged edge fed into the repoint phase: a new fork edge or a surviving
 * inherited edge. Carries the parsed props (NOT a JSON string) so the dedupe key
 * and the conflict union both operate on the canonical structure, the
 * {@link BranchId} that contributed it so edge-property conflicts resolve on the
 * same stable branch order as node-property conflicts, and its
 * {@link StagedEdgeOrigin} so a fold survives onto a row the target already holds.
 *
 * The orchestrator (T11) builds these from `StagedNewEdge` / surviving
 * `StagedModifiedEdge` items (T7); this module needs no knowledge of the diff
 * shape beyond these fields.
 */
export type StagedEdge = Readonly<{
  id: EdgeId;
  kind: string;
  origin: StagedEdgeOrigin;
  fromId: AnyNodeId;
  toId: AnyNodeId;
  fromKind: string;
  toKind: string;
  props: Readonly<Record<string, JsonValue>>;
  branchId: BranchId;
  /**
   * The valid-time window the commit must write. A NEW edge carries the branch's
   * authored window; an INHERITED edge carries `validTo` only, and only when the
   * merge reconciled an end-of-validity for it (an unreconciled inherited window
   * is absent, so the committed row's own window stays untouched).
   *
   * Windows take no part in the dedupe key or the conflict union. `validFrom`
   * rides along with whichever edge survives a fold; `validTo` is instead
   * resolved across the folded set (see {@link repointEdges}), because an end is
   * a monotone claim that must not be lost to the survivor pick.
   */
  validFrom?: string;
  validTo?: string;
}>;

/**
 * A surviving merged edge after repoint + dedupe. `id` is the canonical survivor
 * of its fold set (its inherited member, else its minimum contributing edge id — see
 * {@link pickSurvivor}); `mergedIds` is every staged edge id that collapsed into it
 * (always includes `id`), which is how the commit phase (T11) records each contributing
 * branch's provenance against the row that actually persists. Nothing ENDS a folded-away
 * row — that is precisely why `id` is a commit-correctness choice and not a preference
 * (see the module header's survivor rule).
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
  /** The survivor's {@link StagedEdge} window, if it carried one. */
  validFrom?: string;
  validTo?: string;
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
 * @param canonicalOf A `cluster → canonicalId` selector returning the cluster's
 *   canonical survivor (as chosen by T8 `pickClusterSurvivor`), threaded so this
 *   module reuses the merge-wide canonical choice rather than re-deriving it.
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
 * The PRE-repoint endpoint identity pair of a staged edge — the relationship the
 * author named. {@link foldSets} partitions a collision group by it: distinct pairs
 * are distinct relationships that repointing collapsed (so they fold), one pair is
 * ordinary multigraph multiplicity (so it does not). Direction-sensitive, so the
 * reversed intra-cluster pair `a → b` / `b → a` reads as two source pairs and still
 * folds once `{a, b}` collapse. JSON-encoded (see {@link dedupeKey}) so a
 * separator-bearing id cannot fuse pairs.
 */
function sourcePairKey(fromKey: MergeKey, toKey: MergeKey): string {
  return JSON.stringify([fromKey, toKey]);
}

/**
 * A repointed staged edge plus both endpoints already mapped to their canonical
 * IDENTITY key (`(kind, id)`). The composite keys carry the canonical node's kind, so
 * the surviving edge's bare `fromId`/`toId` and `fromKind`/`toKind` are read off
 * `idOf`/`kindOf` of these keys — never the (possibly different-kind) staged endpoint.
 * `sourcePair` and `dedupeKey` are computed during the single repoint pass so the
 * fold partition and the props-identity check never recanonicalize props.
 */
type RepointedEdge = Readonly<{
  staged: StagedEdge;
  fromKey: MergeKey;
  toKey: MergeKey;
  sourcePair: string;
  dedupeKey: string;
}>;

/**
 * Groups a collision group's members into ROWS: one row per edge id, holding every
 * staged copy of it. Two branches that both staged one inherited edge contribute two
 * members of the SAME row — the id is what makes them the same row.
 */
function rowsById(
  groupEdges: readonly RepointedEdge[],
): ReadonlyMap<EdgeId, readonly RepointedEdge[]> {
  const rows = new Map<EdgeId, RepointedEdge[]>();
  for (const edge of groupEdges) {
    const row = rows.get(edge.staged.id);
    if (row === undefined) {
      rows.set(edge.staged.id, [edge]);
    } else {
      row.push(edge);
    }
  }
  return rows;
}

/**
 * The pre-repoint relationship of each ROW: the minimal {@link sourcePairKey} its
 * members named. A row normally names exactly one pair; the minimum keeps the choice
 * total (and order-independent) for the chosen-id case where two branches staged the
 * same edge id from different endpoints, which is still ONE row and so must land in
 * exactly one fold set.
 */
function sourcePairByRow(
  rows: ReadonlyMap<EdgeId, readonly RepointedEdge[]>,
): ReadonlyMap<EdgeId, string> {
  const pairs = new Map<EdgeId, string>();
  for (const [id, members] of rows) {
    const sorted = members
      .map((member) => member.sourcePair)
      .sort((left, right) => compareStrings(left, right));
    pairs.set(id, requireDefined(sorted[0]));
  }
  return pairs;
}

/**
 * Partitions one `(from', type, to')` collision group into the member sets that each
 * commit as a SINGLE row.
 *
 * Two staged edges are the same ROW when they share an edge id; two rows are the same
 * pre-repoint RELATIONSHIP when they named the same `(from, to)` pair before
 * repointing. Repointing can collapse distinct relationships onto one identity, and
 * that is the collision the §6.3 set-collapse exists for — so ONE row per pre-repoint
 * pair (its minimum-id row: which of a pair's rows REPRESENTS it needs only to be
 * total and order-independent, since every row a pair authored commits either way)
 * folds into a single set. Whether that set then lands on a committed row is
 * {@link pickSurvivor}'s decision, not this partition's. Every FURTHER row a pair
 * authored is ordinary multigraph multiplicity and
 * commits as its own parallel row: nothing enforces uniqueness on `(from, type, to)`,
 * so a merge that collapsed them would destroy multiplicity the branch author's
 * operation would have produced applied straight to the target.
 *
 * The two ends of that rule are the cases the module exists to get right:
 *   - `x → a` and `x → b` both landing on `x → c*` are two pairs of one row each, so
 *     they fold to one edge as before;
 *   - two parallel `x → y` edges are one pair of two rows, so neither is folded away.
 *
 * A group that mixes them folds only ACROSS the pairs: a repointed `x → b` joining two
 * parallel `x → a` rows collapses into the lower-id one of them and the other still
 * commits, because repointing said nothing about the rows that were already there.
 *
 * Determinism: the partition derives only from the staged ids and their pre-repoint
 * pairs — never from input order — and the sets are emitted in id order.
 */
function foldSets(
  groupEdges: readonly RepointedEdge[],
): readonly (readonly RepointedEdge[])[] {
  const rows = rowsById(groupEdges);
  const sourcePairs = sourcePairByRow(rows);
  const representatives = new Map<string, EdgeId>();
  for (const [id, pair] of sourcePairs) {
    const representative = representatives.get(pair);
    if (
      representative === undefined ||
      compareStrings(id, representative) < 0
    ) {
      representatives.set(pair, id);
    }
  }

  const collapsed: RepointedEdge[] = [];
  const parallel: (readonly RepointedEdge[])[] = [];
  for (const id of [...rows.keys()].sort((left, right) =>
    compareStrings(left, right),
  )) {
    const members = requireDefined(rows.get(id));
    const pair = requireDefined(sourcePairs.get(id));
    if (representatives.get(pair) === id) {
      collapsed.push(...members);
    } else {
      parallel.push(members);
    }
  }
  return [collapsed, ...parallel];
}

/**
 * Orders two members of one fold set for the survivor pick: by edge id, then toward
 * the preferred branch, then by branch id.
 *
 * Members that tie on the edge id are the SAME ROW staged by several branches (two
 * branches creating one caller-chosen id), so the row that survives is settled either
 * way and the remaining choice is only WHICH branch's staged copy of it the fold reads
 * its kind, window and survivor prop values from. It goes to the preferred branch,
 * agreeing with {@link pickSurvivor}'s candidate preference — which is where a
 * preferred-branch copy is normally selected, so this clause only ever breaks a tie
 * INSIDE a candidate class. The branch id then makes the order total, so the pick cannot
 * depend on which copy the caller listed first.
 */
function compareMembers(
  left: RepointedEdge,
  right: RepointedEdge,
  preferredBranchId: BranchId | undefined,
): number {
  const byId = compareStrings(left.staged.id, right.staged.id);
  if (byId !== 0) {
    return byId;
  }
  const leftPreferred = left.staged.branchId === preferredBranchId;
  const rightPreferred = right.staged.branchId === preferredBranchId;
  if (leftPreferred !== rightPreferred) {
    return leftPreferred ? -1 : 1;
  }
  return compareStrings(left.staged.branchId, right.staged.branchId);
}

/**
 * Picks the canonical survivor edge of a fold set, enforcing INHERITED-WINS (issue
 * #395) — the edge analog of the node path's base-id-wins (§6.4-C,
 * `pickClusterSurvivor`), and a commit-correctness invariant for the same reason.
 *
 *   - an INHERITED member wins outright (the minimum-id one, for the rare set the
 *     repoint built from several committed rows). A fold rewrites its survivor and
 *     ends none of the rows folded into it, so a survivor the target does not hold
 *     would leave the committed row live beside the new one that was meant to replace
 *     it, with the edit staged for that committed row never written. Writing onto the
 *     row the target already holds is what makes that outcome unreachable, so this
 *     outranks the preferred-branch pick below: the incremental target's own new row
 *     is equally live, but preferring it is precisely what let a committed row lose.
 *   - otherwise every member is branch-created, nothing committed can be stranded,
 *     and the minimum edge id survives — restricted to the preferred (incremental
 *     target) branch's members when the set has any, so an incremental merge still
 *     writes onto the target's row rather than beside it.
 *
 * Order-independent: origin and edge id are intrinsic to the staged set, and
 * {@link compareMembers} is total. (`generateId()` is nanoid — random, not
 * time-prefixed — so min-id never leaks creation order.)
 */
function pickSurvivor(
  edges: readonly RepointedEdge[],
  preferredBranchId?: BranchId,
): RepointedEdge {
  const inherited = edges.filter(
    (edge) => edge.staged.origin === INHERITED_EDGE_ORIGIN,
  );
  const preferred =
    preferredBranchId === undefined ?
      []
    : edges.filter((edge) => edge.staged.branchId === preferredBranchId);
  const candidates =
    inherited.length > 0 ? inherited
    : preferred.length > 0 ? preferred
    : edges;
  return requireDefined(
    [...candidates].sort((left, right) =>
      compareMembers(left, right, preferredBranchId),
    )[0],
  );
}

/**
 * Unions the props of one fold set's edges, resolving any per-property
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
  preferredBranchId?: BranchId,
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

  // The staged record of each edge IS a `(branchId, props)` contribution, so the
  // shared node/edge collector consumes it directly.
  const contributions = edges.map((edge) => edge.staged);

  for (const property of [...propertyNames].sort((left, right) =>
    compareStrings(left, right),
  )) {
    const values = collectConflictingValues(property, contributions);
    if (values.length === 0) {
      continue;
    }
    const survivorValue =
      property in survivor.staged.props ?
        (survivor.staged.props[property] as JsonValue)
      : requireDefined(values[0]).value;
    const canonicalValue: JsonValue =
      values.find((value) => value.branchId === preferredBranchId)?.value ??
      survivorValue;
    const reportedValues =
      preferredBranchId === undefined ? values : (
        values.filter((value) => value.branchId !== preferredBranchId)
      );

    const { value, conflict } = resolvePropertyUnion(
      {
        entityId: survivorId,
        kind,
        property,
        values,
        reportedValues,
        canonicalValue,
      },
      context,
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
 * Folds one set of staged edges (a {@link foldSets} partition) onto the single row the
 * commit will write, resolving props and the valid-time window across its members.
 *
 * @param foldSet Non-empty. Every member shares the same repointed `(from, type, to)`.
 */
function foldEdgeSet(
  foldSet: readonly RepointedEdge[],
  context: ResolutionContext<GraphDef>,
  branchRank: ReadonlyMap<BranchId, number>,
  preferredBranchId?: BranchId,
): Readonly<{ edge: MergedEdge; conflicts: readonly PropertyConflict[] }> {
  const survivor = pickSurvivor(foldSet, preferredBranchId);
  const survivorId = survivor.staged.id;
  const mergedIds = foldSet
    .map((edge) => edge.staged.id)
    .sort((left, right) => compareStrings(left, right));

  // Endpoint ids AND kinds come from the canonical IDENTITY keys, so a repointed
  // edge always names the canonical node's own kind (the commit then applies any
  // retype cascade), never a staged endpoint that merely shared the id string.
  const fromId = idOf(survivor.fromKey);
  const fromKind = kindOf(survivor.fromKey);
  const toId = idOf(survivor.toKey);
  const toKind = kindOf(survivor.toKey);
  // The survivor's lower bound rides along unchanged — a `validFrom` is the
  // branch's authored start for the row we commit. An INHERITED survivor carries
  // none (its start is already committed and a merge never restates it), so a
  // branch-created member's authored start does not migrate onto the committed row
  // the fold lands on; only its END does, below.
  //
  // The END is folded across the set. When repoint/dedupe collapses several
  // DISTINCT edges into one survivor, an end claimed by a non-survivor would
  // otherwise be discarded by the survivor pick — a silent window loss — so the
  // earliest claimed end wins, the same least-claim rule the inherited-window
  // reconciler uses.
  //
  // A survivor from the PREFERRED branch keeps its own end verbatim when it
  // HAS one: that member is the live incremental target's row — or, when the
  // target also staged the inherited survivor, the end already reconciled FOR
  // that row — and a user branch never re-windows what the target already
  // holds, so neither is the fold's to move. When the survivor has none
  // there is no target window to protect, so the fold still resolves across
  // the set — otherwise a preferred survivor would silently swallow the
  // only end any branch claimed.
  const preferredSurvivorEnd =
    survivor.staged.branchId === preferredBranchId ?
      survivor.staged.validTo
    : undefined;
  const foldedEnd =
    preferredSurvivorEnd ??
    resolveEndClaims(
      foldSet
        .filter((edge) => edge.staged.validTo !== undefined)
        .map((edge) => ({
          branchId: edge.staged.branchId,
          validTo: requireDefined(edge.staged.validTo),
        })),
      preferredBranchId,
    );
  const window = {
    ...(survivor.staged.validFrom === undefined ?
      {}
    : { validFrom: survivor.staged.validFrom }),
    ...(foldedEnd === undefined ? {} : { validTo: foldedEnd }),
  };

  const contentKeys = new Set(foldSet.map((edge) => edge.dedupeKey));
  if (contentKeys.size === 1) {
    // Exact-equal collapse: every member shares identical props, so no
    // conflict is possible — keep the survivor's props verbatim.
    return {
      edge: {
        id: survivorId,
        kind: survivor.staged.kind,
        fromId,
        toId,
        fromKind,
        toKind,
        props: survivor.staged.props,
        mergedIds,
        ...window,
      },
      conflicts: [],
    };
  }

  const { props, conflicts } = unionEdgeProps(
    survivorId,
    survivor.staged.kind,
    survivor,
    foldSet,
    context,
    branchRank,
    preferredBranchId,
  );
  return {
    edge: {
      id: survivorId,
      kind: survivor.staged.kind,
      fromId,
      toId,
      fromKind,
      toKind,
      props,
      mergedIds,
      ...window,
    },
    conflicts,
  };
}

/**
 * Repoints every staged edge onto its cluster canonical, drops edges whose
 * (repointed) endpoints are finally deleted, and dedupes the survivors that
 * repointing brought together as a pure set operation keyed by
 * `(from' | type | to' | propsKey)`.
 *
 * Within each folded set — one row per PRE-REPOINT endpoint pair of a group sharing
 * `(from', type, to')`:
 *   - identical props collapse silently to one edge,
 *   - DIFFERING props are reconciled by `policy` on the captured `branchRank`,
 *     recording one edge-level {@link PropertyConflict} per disagreeing property.
 *
 * The parallel rows a pair authored beyond that one are NOT folded together: the store
 * is a multigraph, so each of them commits as its own row (see {@link foldSets} and the
 * module header for the full rule and why identity, not props equality, decides it).
 *
 * The surviving edge of every folded set is its INHERITED member — the row the target
 * already holds, so the fold writes onto it instead of beside it — falling back to the
 * lexicographically-minimal contributing edge id for a set that is entirely
 * branch-created ({@link pickSurvivor}). Its `mergedIds` lists every collapsed edge id.
 * Output is sorted by the full dedupe key plus the edge id, so the result is a pure
 * function of the unordered input set.
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
  preferredBranchId?: BranchId,
): EdgeRepointResult<G> {
  const dropped: DroppedEdge[] = [];
  // Per `(from', type, to')` group → its members. Insertion order is irrelevant:
  // Phase 2 partitions the group, re-derives each survivor, and sorts the output
  // explicitly, so the bucket carries membership only.
  const liveByGroup = new Map<string, RepointedEdge[]>();

  // Phase 1: repoint endpoints (by their `(kind, id)` identity, so a cross-kind id
  // collision can never repoint two unrelated edges onto one survivor), drop edges to
  // deleted nodes, and bucket the survivors by their post-repoint endpoint group.
  for (const staged of stagedEdges) {
    const sourceFromKey = mergeKey(staged.fromKind, staged.fromId);
    const sourceToKey = mergeKey(staged.toKind, staged.toId);
    const fromKey = repoint(sourceFromKey, canonicalOf);
    const toKey = repoint(sourceToKey, canonicalOf);

    if (deletedNodeIds.has(fromKey) || deletedNodeIds.has(toKey)) {
      dropped.push({
        kind: "edge",
        id: staged.id,
        reason: ENDPOINT_DELETED_DROP_REASON,
      });
      continue;
    }

    const repointed: RepointedEdge = {
      staged,
      fromKey,
      toKey,
      sourcePair: sourcePairKey(sourceFromKey, sourceToKey),
      dedupeKey: dedupeKey(fromKey, staged.kind, toKey, staged.props),
    };
    const group = groupKey(fromKey, staged.kind, toKey);
    const bucket = liveByGroup.get(group);
    if (bucket === undefined) {
      liveByGroup.set(group, [repointed]);
    } else {
      bucket.push(repointed);
    }
  }

  // Phase 2: partition every `(from', type, to')` group into the sets that commit as
  // one row ({@link foldSets} — one row per pre-repoint endpoint pair collapses,
  // further parallel rows commit on their own) and fold each set onto its survivor.
  // A set whose members share one dedupe key is an exact-equal collapse (no conflict
  // is possible); several dedupe keys means props differ, so the union runs the
  // conflict policy.
  const context: ResolutionContext<GraphDef> = {
    policy: policy as PropertyConflictPolicy<GraphDef>,
    ...(weights === undefined ? {} : { weights }),
  };

  const merged: MergedEdge[] = [];
  const conflicts: PropertyConflict<G>[] = [];

  const sortedGroups = [...liveByGroup.keys()].sort((left, right) =>
    compareStrings(left, right),
  );

  for (const group of sortedGroups) {
    const groupEdges = requireDefined(liveByGroup.get(group));
    for (const foldSet of foldSets(groupEdges)) {
      const folded = foldEdgeSet(
        foldSet,
        context,
        branchRank,
        preferredBranchId,
      );
      merged.push(folded.edge);
      for (const conflict of folded.conflicts) {
        conflicts.push(conflict as PropertyConflict<G>);
      }
    }
  }

  // Sort on a PRECOMPUTED key per edge (Schwartzian) so `canonicalizeProps` +
  // serialization run once per edge, not twice on every comparison. The edge id is
  // the final component: parallel edges on one endpoint pair can agree on every
  // other one, and a non-total key would leave their order dependent on the stable
  // sort's view of input order.
  const sortedEdges = merged
    .map((edge) => ({
      edge,
      sortKey: JSON.stringify([
        dedupeKey(
          mergeKey(edge.fromKind, edge.fromId),
          edge.kind,
          mergeKey(edge.toKind, edge.toId),
          edge.props,
        ),
        edge.id,
      ]),
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
