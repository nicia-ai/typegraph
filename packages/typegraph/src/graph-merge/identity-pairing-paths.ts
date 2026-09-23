/**
 * Which identity pairings a `"flag"` policy drops: the ones ON THE PATH between
 * the entities a conflict names, never every pairing the cluster happens to
 * hold.
 *
 * A cluster's members are first contracted to the components its NON-identity
 * surviving edges form (similarity, a shared unique value, a retype — fusions
 * no identity policy owns). The identity edges then form a multigraph over
 * those components, and a pairing induced a fusion between two named
 * entities exactly when its edge lies on some simple path between their
 * components. That set is the union of the biconnected blocks along the
 * block-cut-tree path between the two components: a pendant assertion hanging
 * off the path, or a cycle attached at a single articulation point, connects
 * nothing the conflict names and stays.
 *
 * Pure over the cluster and the named endpoints, so the plan builder and the
 * resolver read one decision.
 */
import { requireDefined } from "../utils/presence";
import { connectedComponents } from "./clustering";
import { compareStrings, type MergeKey } from "./node-key";
import type { CandidateEdge } from "./scoring";

/** The identity-edge view of one identity-paired cluster this module reads. */
export type IdentityPairedClusterGraph = Readonly<{
  members: readonly MergeKey[];
  identityEdges: readonly CandidateEdge[];
  nonIdentityEdges: readonly CandidateEdge[];
}>;

/** One identity edge of the contracted graph, keyed by its position. */
type ContractedEdge = Readonly<{ index: number; from: number; to: number }>;

/**
 * The assertion ids an identity edge carries — every `identity` source's ids,
 * since one edge can fold several assertions over the same pair.
 */
function assertionIdsOf(edge: CandidateEdge): readonly string[] {
  return edge.evidence.sources.flatMap((source) =>
    source.kind === "identity" ? source.assertionIds : [],
  );
}

/**
 * Whether the cluster's non-identity edges alone connect `a` and `b`: then
 * the fusion between them is not the identity pairing's doing.
 */
export function connectedWithoutIdentity(
  cluster: IdentityPairedClusterGraph,
  a: MergeKey,
  b: MergeKey,
): boolean {
  const componentOf = componentIndex(cluster);
  return componentOf.get(a) === componentOf.get(b);
}

function componentIndex(
  cluster: IdentityPairedClusterGraph,
): ReadonlyMap<MergeKey, number> {
  const componentOf = new Map<MergeKey, number>();
  for (const [index, component] of connectedComponents(
    cluster.nonIdentityEdges,
    cluster.members,
  ).entries()) {
    for (const member of component.members) componentOf.set(member, index);
  }
  return componentOf;
}

/**
 * The biconnected blocks of an undirected multigraph, each as the set of edge
 * indices it holds (Hopcroft–Tarjan, iterative over an explicit edge stack).
 * A parallel edge is its own block with its twin; a self-loop is skipped, since
 * it lies on no simple path between distinct vertices.
 */
function biconnectedBlocks(
  vertexCount: number,
  edges: readonly ContractedEdge[],
): readonly (readonly ContractedEdge[])[] {
  const adjacency: ContractedEdge[][] = Array.from(
    { length: vertexCount },
    () => [],
  );
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    adjacency[edge.from]?.push(edge);
    adjacency[edge.to]?.push(edge);
  }
  const discovery = new Map<number, number>();
  const low = new Map<number, number>();
  const blocks: (readonly ContractedEdge[])[] = [];
  const edgeStack: ContractedEdge[] = [];
  let clock = 0;

  const visit = (root: number): void => {
    interface Frame {
      vertex: number;
      parentEdge: number | undefined;
      next: number;
    }
    const frames: Frame[] = [{ vertex: root, parentEdge: undefined, next: 0 }];
    discovery.set(root, clock);
    low.set(root, clock);
    clock += 1;
    while (frames.length > 0) {
      const frame = requireDefined(frames.at(-1));
      const neighbors = adjacency[frame.vertex] ?? [];
      if (frame.next < neighbors.length) {
        const edge = requireDefined(neighbors[frame.next]);
        frame.next += 1;
        if (edge.index === frame.parentEdge) continue;
        const other = edge.from === frame.vertex ? edge.to : edge.from;
        const seen = discovery.get(other);
        if (seen === undefined) {
          edgeStack.push(edge);
          discovery.set(other, clock);
          low.set(other, clock);
          clock += 1;
          frames.push({ vertex: other, parentEdge: edge.index, next: 0 });
        } else if (seen < requireDefined(discovery.get(frame.vertex))) {
          edgeStack.push(edge);
          low.set(
            frame.vertex,
            Math.min(requireDefined(low.get(frame.vertex)), seen),
          );
        }
        continue;
      }
      frames.pop();
      const parent = frames.at(-1);
      if (parent === undefined) continue;
      low.set(
        parent.vertex,
        Math.min(
          requireDefined(low.get(parent.vertex)),
          requireDefined(low.get(frame.vertex)),
        ),
      );
      if (
        requireDefined(low.get(frame.vertex)) >=
        requireDefined(discovery.get(parent.vertex))
      ) {
        const block: ContractedEdge[] = [];
        for (;;) {
          const edge = requireDefined(edgeStack.pop());
          block.push(edge);
          if (edge.index === frame.parentEdge) break;
        }
        blocks.push(block);
      }
    }
  };
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    if (!discovery.has(vertex)) visit(vertex);
  }
  return blocks;
}

/**
 * The edges of every block on the block-cut-tree path between `source` and
 * `target` — exactly the edges some simple path between them uses. Empty when
 * the two are the same vertex or not connected.
 */
function edgesOnSimplePaths(
  vertexCount: number,
  edges: readonly ContractedEdge[],
  source: number,
  target: number,
): readonly ContractedEdge[] {
  if (source === target) return [];
  const blocks = biconnectedBlocks(vertexCount, edges);
  // Block-cut tree: block nodes `b:<i>` and vertex nodes `v:<n>`, joined when
  // the vertex touches the block.
  const neighbors = new Map<string, string[]>();
  const link = (left: string, right: string): void => {
    neighbors.set(left, [...(neighbors.get(left) ?? []), right]);
    neighbors.set(right, [...(neighbors.get(right) ?? []), left]);
  };
  for (const [index, block] of blocks.entries()) {
    const vertices = new Set(block.flatMap((edge) => [edge.from, edge.to]));
    for (const vertex of vertices) link(`b:${index}`, `v:${vertex}`);
  }
  const start = `v:${source}`;
  const goal = `v:${target}`;
  const previous = new Map<string, string>([[start, start]]);
  const queue = [start];
  while (queue.length > 0 && !previous.has(goal)) {
    const node = requireDefined(queue.shift());
    for (const next of neighbors.get(node) ?? []) {
      if (previous.has(next)) continue;
      previous.set(next, node);
      queue.push(next);
    }
  }
  if (!previous.has(goal)) return [];
  const onPath: ContractedEdge[] = [];
  for (
    let node = goal;
    node !== start;
    node = requireDefined(previous.get(node))
  ) {
    if (!node.startsWith("b:")) continue;
    onPath.push(...requireDefined(blocks[Number(node.slice(2))]));
  }
  return onPath;
}

/**
 * THE assertions a `"flag"` policy drops for one conflict: every identity
 * assertion carried by an edge on some simple path between any two of the
 * `endpoints` the conflict names, over the cluster's non-identity components.
 * Sorted by id. Naming every member of the cluster names every identity edge
 * (each lies on the path between its own two endpoints).
 */
export function identityAssertionsOnPaths(
  cluster: IdentityPairedClusterGraph,
  endpoints: readonly MergeKey[],
): readonly string[] {
  const componentOf = componentIndex(cluster);
  const vertexCount = new Set(componentOf.values()).size;
  const contracted: ContractedEdge[] = cluster.identityEdges.map(
    (edge, index) => ({
      index,
      from: requireDefined(componentOf.get(edge.a)),
      to: requireDefined(componentOf.get(edge.b)),
    }),
  );
  const named = [
    ...new Set(endpoints.map((key) => componentOf.get(key))),
  ].filter((component): component is number => component !== undefined);
  const selected = new Set<number>();
  for (const [index, source] of named.entries()) {
    for (const target of named.slice(index + 1)) {
      for (const edge of edgesOnSimplePaths(
        vertexCount,
        contracted,
        source,
        target,
      )) {
        selected.add(edge.index);
      }
    }
  }
  const ids = new Set<string>();
  for (const index of selected) {
    for (const id of assertionIdsOf(
      requireDefined(cluster.identityEdges[index]),
    )) {
      ids.add(id);
    }
  }
  return [...ids].sort((left, right) => compareStrings(left, right));
}
