import type { CandidateWriteSet } from "./candidate-write-set";
import { parseRowProps } from "./canonical-props";
import { compareStrings } from "./node-key";
import type { MergePlanArtifact, MergePlanEntityRef } from "./plan-schema";
import { reviewDigest } from "./review-evidence";
import type {
  MergeReviewBaseline,
  MergeReviewDifference,
  MergeReviewRow,
} from "./review-schema";
import { enumerateAllEdges, enumerateAllNodes } from "./state-diff";
import type { GraphDef, Store } from "./typegraph-internal";
import {
  getEdgeKinds,
  getNodeKinds,
  storeBackend,
  storeRuntime,
} from "./typegraph-internal";

export function reviewRowKey(row: MergeReviewRow): string {
  return JSON.stringify([row.role, row.kind, row.id]);
}

/** Caller fences these reads together with planning using one target revision. */
export async function captureReviewBaseline<G extends GraphDef>(
  target: Store<G>,
): Promise<MergeReviewBaseline> {
  const backend = storeBackend(target);
  const rows: MergeReviewRow[] = [];
  for (const kind of getNodeKinds(target.graph)) {
    for (const row of await enumerateAllNodes(backend, target.graphId, kind)) {
      rows.push({
        role: "node",
        kind,
        id: row.id,
        digest: await reviewDigest({ ...row, props: parseRowProps(row.props) }),
      });
    }
  }
  for (const kind of getEdgeKinds(target.graph)) {
    for (const row of await enumerateAllEdges(backend, target.graphId, kind)) {
      rows.push({
        role: "edge",
        kind,
        id: row.id,
        digest: await reviewDigest({ ...row, props: parseRowProps(row.props) }),
      });
    }
  }
  const identity = await storeRuntime(target).readCurrentIdentityAssertions(
    "archival",
    {
      includeDeleted: true,
    },
  );
  return {
    rows: rows.sort((left, right) =>
      compareStrings(reviewRowKey(left), reviewRowKey(right)),
    ),
    identityDigest: await reviewDigest(
      [...identity].sort((left, right) => compareStrings(left.id, right.id)),
    ),
  };
}

/**
 * Existing rows are all guarded. Also guard absence for every input/write/guard
 * reference, so an insertion cannot turn a reviewed create into an overwrite.
 */
export function withReviewAbsences<G extends GraphDef>(
  baseline: MergeReviewBaseline,
  writeSet: CandidateWriteSet,
  plan: MergePlanArtifact,
  graph: G,
): MergeReviewBaseline {
  const rows = new Map(baseline.rows.map((row) => [reviewRowKey(row), row]));
  function addNode(entity: MergePlanEntityRef): void {
    // Guard same-id peers too: a new kind can join an implicit identity class
    // without adding an assertion to the identity ledger. Conservatively guard
    // every kind even when the current identity profile does not fold them.
    for (const kind of getNodeKinds(graph)) {
      const row = { role: "node", kind, id: entity.id } as const;
      if (!rows.has(reviewRowKey(row))) rows.set(reviewRowKey(row), row);
    }
  }
  for (const row of baseline.rows) if (row.role === "node") addNode(row);
  function addEdge(entity: MergePlanEntityRef): void {
    // Edge ids are graph-wide, including across edge kinds.
    for (const kind of getEdgeKinds(graph)) {
      const row = { role: "edge", kind, id: entity.id } as const;
      if (!rows.has(reviewRowKey(row))) rows.set(reviewRowKey(row), row);
    }
  }
  for (const node of [
    ...writeSet.nodes,
    ...plan.writes.nodeUpserts,
    ...plan.writes.nodeDeletes,
    ...plan.guards.deletedNodes,
  ])
    addNode(node);
  for (const edge of [...writeSet.edges, ...plan.writes.edgeUpserts]) {
    addEdge(edge);
    addNode(edge.from);
    addNode(edge.to);
  }
  for (const edge of plan.writes.edgeDeletes) addEdge(edge);
  for (const assertion of [
    ...(writeSet.identity?.assertions ?? []),
    ...plan.writes.identityAssertions,
    ...plan.writes.identityRetractions,
  ]) {
    addNode(assertion.a);
    addNode(assertion.b);
    if (assertion.endedBy !== undefined) addNode(assertion.endedBy);
  }
  for (const mapping of plan.guards.canonicalMappings) {
    addNode(mapping.member);
    addNode(mapping.canonical);
  }
  for (const retype of plan.guards.retypes) {
    addNode(retype.entity);
    addNode({ kind: retype.toKind, id: retype.entity.id });
  }
  return {
    ...baseline,
    rows: [...rows.values()].sort((left, right) =>
      compareStrings(reviewRowKey(left), reviewRowKey(right)),
    ),
  };
}

export function compareReviewBaseline(
  reviewed: MergeReviewBaseline,
  current: MergeReviewBaseline,
): readonly MergeReviewDifference[] {
  const currentRows = new Map(
    current.rows.map((row) => [reviewRowKey(row), row]),
  );
  const differences: MergeReviewDifference[] = [];
  for (const row of reviewed.rows) {
    if (row.digest !== currentRows.get(reviewRowKey(row))?.digest) {
      differences.push({
        category: "baseline",
        path: "baseline.rows",
        entity: { role: row.role, kind: row.kind, id: row.id },
      });
    }
  }
  if (reviewed.identityDigest !== current.identityDigest) {
    differences.push({ category: "baseline", path: "baseline.identityDigest" });
  }
  return differences;
}
