import { requireDefined } from "../utils/presence";
/**
 * Connected-components clustering over the candidate-edge graph (design §6.4
 * rule 2, T8).
 *
 * Two staged nodes are merged into the same cluster iff they are connected
 * (transitively) by a chain of candidate-merge edges. This is the SINGLE-LINK
 * rule: A~B and B~C cluster {A,B,C} even when A≁C directly, because each hop
 * cleared the similarity threshold. The frozen v1 default is single-link with NO
 * guard; the optional diameter guard (below) is the only deviation.
 *
 * Determinism:
 *   - The component assignment is computed via union-find over the candidate
 *     edge SET (a pure function of the edges, never their arrival order). We
 *     additionally order edge consumption by `(a, b)` and union with a
 *     min-id-as-root tie-break, so even the internal forest is identical across
 *     shuffled inputs — not merely the resulting partition.
 *   - Every cluster's `members` array is sorted by node id, and the cluster list
 *     is sorted by each cluster's minimum member id. So the output is fully
 *     canonical regardless of the order edges or seed node ids are supplied in.
 *
 * Diameter guard (optional, design §6.4 / T8):
 *   When `clusterMaxDiameter` is set, a formed component must satisfy a single
 *   bound: the maximum pairwise graph distance (in candidate-edge hops) between
 *   any two members must not exceed the guard. A component that violates the
 *   bound is split by the deterministic DROP-WEAKEST single-link rule: remove the
 *   lowest-scoring candidate edge (ties broken by `(a, b)` id order) and
 *   recompute components on the survivors, repeating until every sub-component
 *   satisfies the bound. This is the frozen v1 behavior — no correlation
 *   clustering in P0.
 */
import type { CandidateEdge } from "./candidate-gen";
import { compareMergeKeys, type MergeKey } from "./node-key";
import { compareCandidateEdges } from "./scoring";
import { UnionFind } from "./union-find";

/**
 * The node IDENTITY the cluster graph is built over: the composite `(kind, id)`
 * {@link MergeKey}, NOT a bare node id. Two different-kind nodes that share an id
 * string are DISTINCT identities here, so single-link clustering never fuses them
 * into one component (the base guard would otherwise be silently bypassed).
 */
type AnyNodeId = MergeKey;

/**
 * A resolved cluster of node identities that the merge collapses into one canonical
 * survivor. `members` is always sorted (by id, then kind) and never empty.
 */
export type ClusterResult = Readonly<{
  members: readonly AnyNodeId[];
}>;

/**
 * Builds connected components from a candidate-edge set plus an explicit seed
 * set of all node ids in scope. Seed ids with no incident edge become singleton
 * components, so the result partitions the ENTIRE node set, not just edge
 * endpoints.
 */
function buildComponents(
  edges: readonly CandidateEdge[],
  nodeIds: readonly AnyNodeId[],
  edgesSorted = false,
): ClusterResult[] {
  const forest = new UnionFind<AnyNodeId>(compareMergeKeys);
  const seed = new Set<AnyNodeId>(nodeIds);
  for (const id of nodeIds) {
    forest.add(id);
  }
  // Consume edges in canonical order so the forest is identical across shuffles.
  // An edge whose endpoint is NOT in the seed set is out of scope and skipped, so
  // the partition is a function of exactly the supplied node set — a candidate
  // edge can never inject a phantom member never passed in `nodeIds`.
  // `edgesSorted` lets a caller that already holds the edges in canonical order
  // (the drop-weakest loop) skip the redundant re-sort on every iteration.
  const orderedEdges =
    edgesSorted ? edges : (
      [...edges].sort((left, right) => compareCandidateEdges(left, right))
    );
  for (const edge of orderedEdges) {
    if (!seed.has(edge.a) || !seed.has(edge.b)) {
      continue;
    }
    forest.union(edge.a, edge.b);
  }

  const byRoot = new Map<AnyNodeId, AnyNodeId[]>();
  for (const id of forest.members()) {
    const root = forest.find(id);
    const bucket = byRoot.get(root);
    if (bucket === undefined) {
      byRoot.set(root, [id]);
    } else {
      bucket.push(id);
    }
  }

  const clusters: ClusterResult[] = [];
  for (const members of byRoot.values()) {
    clusters.push({
      members: [...members].sort((left, right) =>
        compareMergeKeys(left, right),
      ),
    });
  }
  // Order clusters by their (sorted) first member, which is the minimum id.
  clusters.sort((left, right) =>
    compareMergeKeys(
      requireDefined(left.members[0]),
      requireDefined(right.members[0]),
    ),
  );
  return clusters;
}

/**
 * Builds the undirected adjacency (member id → set of neighbor ids) for one
 * component's members, restricted to candidate edges whose BOTH endpoints are in
 * the component.
 */
function adjacencyOf(
  members: readonly AnyNodeId[],
  edges: readonly CandidateEdge[],
): Map<AnyNodeId, Set<AnyNodeId>> {
  const memberSet = new Set(members);
  const adjacency = new Map<AnyNodeId, Set<AnyNodeId>>();
  for (const id of members) {
    adjacency.set(id, new Set());
  }
  for (const edge of edges) {
    if (memberSet.has(edge.a) && memberSet.has(edge.b)) {
      requireDefined(adjacency.get(edge.a)).add(edge.b);
      requireDefined(adjacency.get(edge.b)).add(edge.a);
    }
  }
  return adjacency;
}

/**
 * Whether one component's pairwise graph diameter (in candidate-edge hops) EXCEEDS
 * `maxDiameter`. Runs a BFS from each member but EARLY-EXITS the moment it reaches
 * a node beyond `maxDiameter` (or finds the component disconnected), so a check
 * costs `O(members + edges-within-the-bound)` rather than the full all-pairs
 * `O(V·(V+E))` exact diameter — the guard only needs the threshold answer, never
 * the exact value. Equivalent to `componentDiameter(...) > maxDiameter`.
 */
function exceedsDiameter(
  members: readonly AnyNodeId[],
  edges: readonly CandidateEdge[],
  maxDiameter: number,
): boolean {
  if (members.length <= 1) {
    return false;
  }
  const adjacency = adjacencyOf(members, edges);
  for (const source of members) {
    const distance = new Map<AnyNodeId, number>([[source, 0]]);
    const queue: AnyNodeId[] = [source];
    let head = 0;
    while (head < queue.length) {
      const current = requireDefined(queue[head]);
      head += 1;
      const currentDistance = requireDefined(distance.get(current));
      for (const neighbor of requireDefined(adjacency.get(current))) {
        if (!distance.has(neighbor)) {
          const neighborDistance = currentDistance + 1;
          if (neighborDistance > maxDiameter) {
            return true; // a pair already exceeds the bound — stop early
          }
          distance.set(neighbor, neighborDistance);
          queue.push(neighbor);
        }
      }
    }
    if (distance.size < members.length) {
      return true; // disconnected from `source` → diameter is infinite
    }
  }
  return false;
}

/**
 * The candidate edges internal to a single component (both endpoints inside it),
 * in canonical `(a, b)` order.
 */
function internalEdges(
  members: readonly AnyNodeId[],
  edges: readonly CandidateEdge[],
): CandidateEdge[] {
  const memberSet = new Set(members);
  return edges
    .filter((edge) => memberSet.has(edge.a) && memberSet.has(edge.b))
    .sort((left, right) => compareCandidateEdges(left, right));
}

/**
 * The single weakest edge of a set: lowest score, ties broken by `(a, b)` id
 * order. The deterministic edge the drop-weakest splits remove first.
 */
function weakestEdge(edges: readonly CandidateEdge[]): CandidateEdge {
  return edges.reduce((current, candidate) => {
    if (candidate.score !== current.score) {
      return candidate.score < current.score ? candidate : current;
    }
    return compareCandidateEdges(candidate, current) < 0 ? candidate : current;
  });
}

/**
 * The shared DROP-WEAKEST splitter (design §6.4 / §6.4-A). Repeatedly removes the
 * lowest-scoring internal candidate edge (ties broken by `(a, b)` id order) and
 * recomputes components until NO sub-component is still `isOffending`, then returns
 * the satisfying sub-components. `isOffending` receives the current surviving edge
 * set so a predicate like the diameter check can measure against it.
 *
 * The degenerate "still offending but no internal edge left to drop" case — only
 * reachable if a future caller passes a ≥2-member component with no internal edge —
 * degrades EVERY such offending component to singletons (keeping every satisfying
 * sibling intact), so the partition is never silently truncated. It first exhausts the
 * splittable offending components (those with an edge to drop), so an edgeless
 * offending sibling can never leave another offending component unsplit.
 */
function splitUntil(
  members: readonly AnyNodeId[],
  edges: readonly CandidateEdge[],
  isOffending: (
    members: readonly AnyNodeId[],
    surviving: readonly CandidateEdge[],
  ) => boolean,
): ClusterResult[] {
  // `surviving` starts in canonical `(a, b)` order and `.filter` preserves it, so
  // every iteration can pass it to `buildComponents` pre-sorted.
  let surviving = internalEdges(members, edges);

  for (;;) {
    const components = buildComponents(surviving, members, true);
    const offending = components.filter((component) =>
      isOffending(component.members, surviving),
    );
    if (offending.length === 0) {
      return components;
    }
    // Prefer to keep dropping the weakest edge of an offending component that still has
    // one; only when EVERY offending component is edgeless do we degrade them all.
    // Scan lazily — stop at the first offending component that still has an internal
    // edge instead of materializing internalEdges for every offending component.
    let splittable: CandidateEdge[] | undefined;
    for (const component of offending) {
      const componentEdges = internalEdges(component.members, surviving);
      if (componentEdges.length > 0) {
        splittable = componentEdges;
        break;
      }
    }
    if (splittable === undefined) {
      const offendingSet = new Set(offending);
      return components.flatMap((component) =>
        offendingSet.has(component) ?
          component.members.map((id) => ({ members: [id] }))
        : [component],
      );
    }
    const weakest = weakestEdge(splittable);
    surviving = surviving.filter((edge) => edge !== weakest);
  }
}

/**
 * Splits a single over-diameter component by the deterministic DROP-WEAKEST
 * single-link rule until every resulting sub-component satisfies `maxDiameter`.
 */
function splitByDropWeakest(
  members: readonly AnyNodeId[],
  edges: readonly CandidateEdge[],
  maxDiameter: number,
): ClusterResult[] {
  return splitUntil(members, edges, (componentMembers, surviving) =>
    exceedsDiameter(componentMembers, surviving, maxDiameter),
  );
}

/**
 * Computes the connected components of the candidate-edge graph over `nodeIds`,
 * applying the optional single-link diameter guard.
 *
 * @param candidateEdges Undirected candidate-merge edges (from T6). Order does
 *   not affect the result.
 * @param nodeIds Every node id in scope. Ids with no incident candidate edge
 *   become singleton clusters, so the output partitions the full set.
 * @returns Clusters with id-sorted members, sorted by minimum member id. Pure
 *   over the input edge/node SETS.
 *
 * The diameter guard is deliberately NOT applied here: {@link enforceBaseGuard}
 * (§6.4-A) must run on these RAW components FIRST, and only then may a caller run
 * {@link enforceDiameter}. Folding the diameter split back in would let it sever a
 * base↔base bridge before base multiplicity is detected.
 */
export function connectedComponents(
  candidateEdges: readonly CandidateEdge[],
  nodeIds: readonly AnyNodeId[],
): readonly ClusterResult[] {
  return buildComponents(candidateEdges, nodeIds);
}

/**
 * Applies the single-link DIAMETER guard to already-formed clusters: any cluster
 * whose pairwise diameter exceeds `clusterMaxDiameter` is split by the deterministic
 * drop-weakest rule. Separated from {@link connectedComponents} so the base guard
 * (§6.4-A) can run on the RAW pre-diameter components FIRST — a diameter split must
 * never sever a base↔base bridge before base-multiplicity is detected.
 */
export function enforceDiameter(
  clusters: readonly ClusterResult[],
  candidateEdges: readonly CandidateEdge[],
  clusterMaxDiameter: number,
): readonly ClusterResult[] {
  const guarded: ClusterResult[] = [];
  for (const component of clusters) {
    if (
      exceedsDiameter(component.members, candidateEdges, clusterMaxDiameter)
    ) {
      guarded.push(
        ...splitByDropWeakest(
          component.members,
          candidateEdges,
          clusterMaxDiameter,
        ),
      );
    } else {
      guarded.push(component);
    }
  }
  guarded.sort((left, right) =>
    compareMergeKeys(
      requireDefined(left.members[0]),
      requireDefined(right.members[0]),
    ),
  );
  return guarded;
}

/** Count of a component's members that are committed BASE nodes. */
function countBaseMembers(
  members: readonly AnyNodeId[],
  baseIds: ReadonlySet<AnyNodeId>,
): number {
  let count = 0;
  for (const id of members) {
    if (baseIds.has(id)) {
      count += 1;
    }
  }
  return count;
}

/**
 * Splits a component holding ≥2 base members by the deterministic DROP-WEAKEST rule
 * until NO surviving sub-component holds two base members. This is CONTAINMENT, not
 * resolution: it removes the lowest-scoring BRIDGING edges (forced new↔base edges,
 * at max score, are dropped last), so the distinct committed entities land in
 * separate clusters and BOTH survive — it never "picks" which base wins (§6.4-A).
 */
function splitByBaseMultiplicity(
  members: readonly AnyNodeId[],
  edges: readonly CandidateEdge[],
  baseIds: ReadonlySet<AnyNodeId>,
): ClusterResult[] {
  return splitUntil(
    members,
    edges,
    (componentMembers) => countBaseMembers(componentMembers, baseIds) >= 2,
  );
}

/**
 * A connected component that spanned ≥2 distinct committed base entities — an
 * AMBIGUOUS match (§6.4-A). Reported regardless of how the component was split:
 * any component that EVER bridged two base identities is an ambiguity event.
 */
export type BaseMultiplicityEvent = Readonly<{
  baseIds: readonly AnyNodeId[];
  memberIds: readonly AnyNodeId[];
}>;

/**
 * Component-level BASE GUARD (§6.4-A). Single-link clustering is transitive, so two
 * committed entities fuse whenever ANY chain links them (`baseA ~ new ~ baseB`, or
 * through staged hops `baseA ~ new1 ~ new2 ~ baseB` where no single new node spans
 * both). A node-level guard misses the chain case; this guard is COMPONENT-level.
 *
 * MUST run on the RAW connected components, BEFORE any diameter split — otherwise a
 * diameter guard could sever a base↔base bridge into single-base pieces and the
 * ambiguity would go unreported (§6.4-A: reported regardless of how it split).
 *
 * Any component containing ≥2 distinct base members is an ambiguous match and is
 * reported as a {@link BaseMultiplicityEvent}. The committed entities are ALWAYS kept
 * SEPARATE — the base↔base collapse is REFUSED by splitting the component
 * (drop-weakest, containment only) until no sub-component holds two base members.
 * Splitting never downgrades the event from ambiguous, and never silently picks which
 * base wins. (A deliberate-collapse trust path is deferred until committed-entity
 * re-keying + edge repoint exist; §6.4-C.)
 *
 * A no-op fast path when there are no base members (the public snapshot path).
 *
 * @returns the guarded clusters (id-sorted members, sorted by min member id) and
 *   one event per component that spanned ≥2 base entities.
 */
export function enforceBaseGuard(
  clusters: readonly ClusterResult[],
  candidateEdges: readonly CandidateEdge[],
  baseIds: ReadonlySet<AnyNodeId>,
): Readonly<{
  clusters: readonly ClusterResult[];
  events: readonly BaseMultiplicityEvent[];
}> {
  if (baseIds.size === 0) {
    return { clusters, events: [] };
  }

  const result: ClusterResult[] = [];
  const events: BaseMultiplicityEvent[] = [];
  for (const cluster of clusters) {
    const clusterBaseIds = cluster.members.filter((id) => baseIds.has(id));
    if (clusterBaseIds.length < 2) {
      result.push(cluster);
      continue;
    }
    events.push({
      baseIds: [...clusterBaseIds].sort((left, right) =>
        compareMergeKeys(left, right),
      ),
      memberIds: [...cluster.members].sort((left, right) =>
        compareMergeKeys(left, right),
      ),
    });
    // Always REFUSE the base↔base collapse: split for containment so both committed
    // entities survive separately (§6.4-A). A deliberate collapse is deferred (§6.4-C).
    result.push(
      ...splitByBaseMultiplicity(cluster.members, candidateEdges, baseIds),
    );
  }
  result.sort((left, right) =>
    compareMergeKeys(
      requireDefined(left.members[0]),
      requireDefined(right.members[0]),
    ),
  );
  return { clusters: result, events };
}
