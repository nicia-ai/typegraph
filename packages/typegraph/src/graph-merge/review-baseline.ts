import type { IdentityTransferAssertion } from "../identity/service";
import { type CandidateIdentityReference } from "./candidate-identity-closure";
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
import {
  createGraphEdgeKindReader,
  createGraphNodeKindReader,
} from "./state-diff";
import type { GraphDef, Store } from "./typegraph-internal";
import {
  batchPointReadVerdict,
  getEdgeKinds,
  getEdgeRowsByIds,
  getNodeKinds,
  getNodeRowsByIds,
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
  const readNodes = createGraphNodeKindReader(
    backend,
    target.graphId,
    getNodeKinds(target.graph),
  );
  for (const kind of getNodeKinds(target.graph)) {
    for (const row of await readNodes(kind)) {
      rows.push({
        role: "node",
        kind,
        id: row.id,
        digest: await reviewDigest({ ...row, props: parseRowProps(row.props) }),
      });
    }
  }
  const readEdges = createGraphEdgeKindReader(
    backend,
    target.graphId,
    getEdgeKinds(target.graph),
  );
  for (const kind of getEdgeKinds(target.graph)) {
    for (const row of await readEdges(kind)) {
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
 * Captures a V2 review baseline over candidate references and their exact
 * archival identity closure. The retained scope is re-read during approval
 * revalidation; newly connected peers/assertions therefore change the evidence.
 */
export async function captureReferencedReviewBaseline<G extends GraphDef>(
  target: Store<G>,
  rowReferences: readonly MergeReviewRow[],
  identityReferences: readonly CandidateIdentityReference[] = rowReferences
    .filter((row) => row.role === "node")
    .map(({ kind, id }) => ({ kind, id })),
  assertionIds: readonly string[] = [],
): Promise<MergeReviewBaseline> {
  const backend = storeBackend(target);
  const closure = await readReviewIdentityClosure(
    target,
    [...identityReferences],
    assertionIds,
  );
  const requestedRows = new Map(
    rowReferences.map((row) => [reviewRowKey(row), row]),
  );
  for (const reference of closure.references) {
    for (const kind of getNodeKinds(target.graph)) {
      const row = { role: "node", kind, id: reference.id } as const;
      requestedRows.set(reviewRowKey(row), row);
    }
  }

  const refs = [...requestedRows.values()];
  const rows: MergeReviewRow[] = [];
  const nodeIdsByKind = new Map<string, string[]>();
  const edgeIds: string[] = [];
  for (const reference of refs) {
    if (reference.role === "node") {
      const ids = nodeIdsByKind.get(reference.kind) ?? [];
      ids.push(reference.id);
      nodeIdsByKind.set(reference.kind, ids);
    } else {
      edgeIds.push(reference.id);
    }
  }
  const pointRead = batchPointReadVerdict(backend);
  for (const [kind, ids] of nodeIdsByKind) {
    const found = await getNodeRowsByIds(
      backend,
      pointRead,
      target.graphId,
      kind,
      ids,
    );
    for (const id of ids) {
      const row = found.get(id);
      const reference = { role: "node", kind, id } as const;
      rows.push(
        row === undefined ? reference : (
          {
            ...reference,
            digest: await reviewDigest({
              ...row,
              props: parseRowProps(row.props),
            }),
          }
        ),
      );
    }
  }
  if (edgeIds.length > 0) {
    const found = await getEdgeRowsByIds(
      backend,
      pointRead,
      target.graphId,
      edgeIds,
    );
    for (const reference of refs) {
      if (reference.role !== "edge") continue;
      const row = found.get(reference.id);
      rows.push(
        row?.kind === reference.kind ?
          {
            ...reference,
            digest: await reviewDigest({
              ...row,
              props: parseRowProps(row.props),
            }),
          }
        : reference,
      );
    }
  }
  const scopedReferences = closure.references.toSorted((left, right) =>
    compareStrings(
      reviewRowKey({ role: "node", ...left }),
      reviewRowKey({ role: "node", ...right }),
    ),
  );
  return {
    rows: rows.toSorted((left, right) =>
      compareStrings(reviewRowKey(left), reviewRowKey(right)),
    ),
    identityDigest: await reviewDigest(closure.assertions),
    identityReferences: scopedReferences,
    identityAssertionIds: [...new Set(assertionIds)].toSorted(compareStrings),
    scope: "referenced",
  };
}

async function readReviewIdentityClosure<G extends GraphDef>(
  target: Store<G>,
  seedReferences: readonly CandidateIdentityReference[],
  assertionIds: readonly string[],
): Promise<
  Readonly<{
    references: readonly CandidateIdentityReference[];
    assertions: readonly IdentityTransferAssertion[];
  }>
> {
  const runtime = storeRuntime(target);
  const references = new Map<string, CandidateIdentityReference>();
  const assertions = new Map<string, IdentityTransferAssertion>();
  function addReference(reference: CandidateIdentityReference): boolean {
    const key = JSON.stringify([reference.kind, reference.id]);
    if (references.has(key)) return false;
    references.set(key, reference);
    return true;
  }
  function addAssertion(assertion: IdentityTransferAssertion): void {
    assertions.set(assertion.id, assertion);
    addReference(assertion.a);
    addReference(assertion.b);
    if (assertion.endedBy !== undefined) addReference(assertion.endedBy);
  }
  for (const reference of seedReferences) addReference(reference);
  for (const assertion of await runtime.interchangeIdentityAssertionsByIdsAtTarget(
    storeBackend(target),
    assertionIds,
    "archival",
    { includeDeleted: true },
  ))
    addAssertion(assertion);

  const expandedReferences = new Set<string>();
  const expandedIds = new Set<string>();
  for (;;) {
    const ids = [
      ...new Set([...references.values()].map((ref) => ref.id)),
    ].filter((id) => !expandedIds.has(id));
    for (const id of ids) expandedIds.add(id);
    for (const peer of await runtime.liveNodesSharingIds(ids))
      addReference(peer);
    const pending = [...references.entries()]
      .filter(([key]) => !expandedReferences.has(key))
      .map(([, reference]) => reference);
    for (const reference of pending)
      expandedReferences.add(JSON.stringify([reference.kind, reference.id]));
    for (const assertion of await runtime.identityAssertionsTouchingAtTarget(
      storeBackend(target),
      pending,
      "archival",
      { includeDeleted: true },
    ))
      addAssertion(assertion);
    if (
      [...references.keys()].every((key) => expandedReferences.has(key)) &&
      [...references.values()].every((reference) =>
        expandedIds.has(reference.id),
      )
    )
      break;
  }
  return {
    references: [...references.values()],
    assertions: [...assertions.values()].sort((left, right) =>
      compareStrings(left.id, right.id),
    ),
  };
}

/** Candidate-local row keys that can affect writes, guards, or identity probes. */
export function candidateReviewReferenceRows<G extends GraphDef>(
  writeSet: CandidateWriteSet,
  plan: MergePlanArtifact,
  graph: G,
): readonly MergeReviewRow[] {
  const rows = new Map<string, MergeReviewRow>();
  function addNode(entity: MergePlanEntityRef): void {
    for (const kind of getNodeKinds(graph)) {
      const row = { role: "node", kind, id: entity.id } as const;
      rows.set(reviewRowKey(row), row);
    }
  }
  function addEdge(entity: MergePlanEntityRef): void {
    for (const kind of getEdgeKinds(graph)) {
      const row = { role: "edge", kind, id: entity.id } as const;
      rows.set(reviewRowKey(row), row);
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
  return [...rows.values()].sort((left, right) =>
    compareStrings(reviewRowKey(left), reviewRowKey(right)),
  );
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
  for (const row of candidateReviewReferenceRows(writeSet, plan, graph))
    if (!rows.has(reviewRowKey(row))) rows.set(reviewRowKey(row), row);
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
  const reviewedRows = new Map(
    reviewed.rows.map((row) => [reviewRowKey(row), row]),
  );
  const differences: MergeReviewDifference[] = [];
  const comparedRows =
    reviewed.identityReferences === undefined ?
      [...reviewedRows.keys()]
    : [...new Set([...reviewedRows.keys(), ...currentRows.keys()])];
  for (const key of comparedRows) {
    const row = reviewedRows.get(key) ?? currentRows.get(key);
    if (reviewedRows.get(key)?.digest !== currentRows.get(key)?.digest) {
      if (row === undefined) continue;
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
  if (
    reviewed.identityReferences !== undefined &&
    reviewRowKeyArray(reviewed.identityReferences) !==
      reviewRowKeyArray(current.identityReferences)
  ) {
    differences.push({
      category: "baseline",
      path: "baseline.identityReferences",
    });
  }
  return differences;
}

function reviewRowKeyArray(
  references: readonly MergePlanEntityRef[] | undefined,
): string {
  return JSON.stringify(
    (references ?? [])
      .map((reference) => [reference.kind, reference.id])
      .sort((left, right) =>
        compareStrings(JSON.stringify(left), JSON.stringify(right)),
      ),
  );
}
