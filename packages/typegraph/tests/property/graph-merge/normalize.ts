/**
 * The SINGLE normalization comparator for the determinism property test (T12).
 *
 * Determinism is meaningful only against a canonical representation: two merges
 * of the same branch set in different orders must produce the same {@link
 * MergeReport} and the same committed graph — but the raw values carry
 * order-/time-sensitive noise that would defeat a naive `deepEqual`:
 *
 *   - The {@link MergeReport.provenance} field is a CLOSURE
 *     (`byBranch(id) => …`), not data, so it cannot be structurally compared; it
 *     is replaced by a materialized, sorted map keyed by the branches under test.
 *   - Committed rows carry non-deterministic META — `created_at` / `updated_at`
 *     (wall-clock) and `version` (write counter) — which differ between two
 *     independent commits even when the logical result is identical. These are
 *     STRIPPED, and every props bag is re-serialized through the same canonical,
 *     recursively key-sorted JSON form so key-ordering noise cannot leak in.
 *   - Every array in the report and the graph is sorted by a stable key so two
 *     orderings that produce the same SET produce the same SEQUENCE.
 *
 * Centralizing both `normalizeReport` and `normalizeGraph` here avoids the
 * inconsistent-equality smell of ad-hoc per-test comparators: the determinism
 * gate asserts deep-equality over exactly these two canonical forms and nothing
 * else.
 */

import type { GraphDef, Store } from "@nicia-ai/typegraph";
import { getEdgeKinds, getNodeKinds } from "@nicia-ai/typegraph";

import { rowPropsToObject } from "../../../src/backend/types";
import { canonicalizeProps } from "../../../src/graph-merge/canonical-props";
import {
  enumerateAllEdges,
  enumerateAllNodes,
} from "../../../src/graph-merge/state-diff";
import type { BranchId, MergeReport } from "../../../src/graph-merge/types";
import { storeBackend } from "../../../src/store/runtime-port";

/** Lexicographic comparator over two strings (ids, kinds, properties). */
function compareStrings(left: string, right: string): number {
  return (
    left < right ? -1
    : left > right ? 1
    : 0
  );
}

/**
 * A property bag rendered to a canonical, recursively key-sorted JSON string, so
 * two logically-equal bags compare equal regardless of key insertion order.
 */
function canonicalProps(props: Readonly<Record<string, unknown>>): string {
  return canonicalizeProps(props);
}

/** One canonical conflicting value: branch id + its canonical-JSON value. */
type NormalizedConflictValue = Readonly<{ branchId: string; value: string }>;

/** A property/edge conflict reduced to its order-independent canonical fields. */
type NormalizedConflict = Readonly<{
  entityId: string;
  kind: string;
  property: string;
  values: readonly NormalizedConflictValue[];
  resolution: string;
}>;

/** An entity resolution reduced to its order-independent canonical fields. */
type NormalizedResolution = Readonly<{
  canonicalId: string;
  kind: string;
  memberIds: readonly string[];
  branchOrigins: readonly string[];
}>;

/** A delete/modify conflict in canonical form. */
type NormalizedDeleteModify = Readonly<{
  entityId: string;
  kind: string;
  deletedBy: string;
  modifiedBy: string;
  resolution: string;
}>;

/** A type reconciliation in canonical form. */
type NormalizedTypeReconciliation = Readonly<{
  entityId: string;
  fromTypes: readonly string[];
  toType: string;
}>;

/** A dropped item in canonical form. */
type NormalizedDropped = Readonly<{
  kind: "edge" | "node";
  id: string;
  reason: string;
}>;

/** Per-branch provenance materialized from the report closure, sorted. */
type NormalizedProvenance = Readonly<{
  branchId: string;
  nodeIds: readonly string[];
  edgeIds: readonly string[];
}>;

/**
 * A new-vs-base ambiguity event reduced to canonical `(kind, id)` identity strings,
 * each list sorted, so a permutation-order-dependent base-guard report would surface
 * as a determinism-gate failure (rather than being silently dropped from comparison).
 */
type NormalizedBaseAmbiguity = Readonly<{
  baseIds: readonly string[];
  memberIds: readonly string[];
}>;

/** The fully canonical, deep-equal-comparable form of a {@link MergeReport}. */
export type NormalizedReport = Readonly<{
  merged: Readonly<{ nodes: number; edges: number }>;
  resolutions: readonly NormalizedResolution[];
  conflicts: readonly NormalizedConflict[];
  deleteModifyConflicts: readonly NormalizedDeleteModify[];
  typeReconciliations: readonly NormalizedTypeReconciliation[];
  dropped: readonly NormalizedDropped[];
  baseAmbiguities: readonly NormalizedBaseAmbiguity[];
  provenance: readonly NormalizedProvenance[];
}>;

/** A committed node reduced to id + kind + canonical props (meta stripped). */
type NormalizedNode = Readonly<{
  id: string;
  kind: string;
  props: string;
}>;

/** A committed edge reduced to its structural identity (meta stripped). */
type NormalizedEdge = Readonly<{
  id: string;
  kind: string;
  from: string;
  to: string;
  fromKind: string;
  toKind: string;
  props: string;
}>;

/** The fully canonical, deep-equal-comparable form of a committed graph. */
export type NormalizedGraph = Readonly<{
  nodes: readonly NormalizedNode[];
  edges: readonly NormalizedEdge[];
}>;

/** Sorts conflicting values by `(branchId, value)`. */
function normalizeConflictValues(
  values: MergeReport["conflicts"][number]["values"],
): readonly NormalizedConflictValue[] {
  return values
    .map((entry) => ({
      branchId: entry.branchId,
      value: JSON.stringify(entry.value),
    }))
    .sort((left, right) => {
      const byBranch = compareStrings(left.branchId, right.branchId);
      return byBranch === 0 ?
          compareStrings(left.value, right.value)
        : byBranch;
    });
}

/**
 * Reduces a {@link MergeReport} to a {@link NormalizedReport}: every array sorted
 * by a stable key, the provenance closure materialized over the branches under
 * test, and every conflicting value rendered to canonical JSON. Two merges of the
 * same branch set in any order normalize to a deep-equal report.
 *
 * @param report The report returned by `merge`.
 * @param branchIds The branch ids whose provenance to materialize (the branches
 *   passed to `merge`). Sorted internally so order does not matter.
 */
export function normalizeReport<G extends GraphDef>(
  report: MergeReport<G>,
  branchIds: readonly BranchId[],
): NormalizedReport {
  const resolutions: readonly NormalizedResolution[] = report.resolutions
    .map((resolution) => ({
      canonicalId: resolution.canonicalId,
      kind: resolution.kind,
      memberIds: [...resolution.memberIds]
        .map((id) => id as string)
        .sort((left, right) => compareStrings(left, right)),
      branchOrigins: [...resolution.branchOrigins]
        .map((id) => id as string)
        .sort((left, right) => compareStrings(left, right)),
    }))
    .sort((left, right) => compareStrings(left.canonicalId, right.canonicalId));

  const conflicts: readonly NormalizedConflict[] = report.conflicts
    .map((conflict) => ({
      entityId: conflict.entityId,
      kind: conflict.kind,
      property: conflict.property,
      values: normalizeConflictValues(conflict.values),
      resolution: JSON.stringify(conflict.resolution),
    }))
    .sort((left, right) =>
      compareStrings(
        `${left.entityId}|${left.kind}|${left.property}`,
        `${right.entityId}|${right.kind}|${right.property}`,
      ),
    );

  const deleteModifyConflicts: readonly NormalizedDeleteModify[] =
    report.deleteModifyConflicts
      .map((conflict) => ({
        entityId: conflict.entityId,
        kind: conflict.kind,
        deletedBy: conflict.deletedBy,
        modifiedBy: conflict.modifiedBy,
        resolution: conflict.resolution,
      }))
      .sort((left, right) =>
        compareStrings(
          `${left.entityId}|${left.kind}`,
          `${right.entityId}|${right.kind}`,
        ),
      );

  const typeReconciliations: readonly NormalizedTypeReconciliation[] =
    report.typeReconciliations
      .map((reconciliation) => ({
        entityId: reconciliation.entityId,
        fromTypes: [...reconciliation.fromTypes].sort((left, right) =>
          compareStrings(left, right),
        ),
        toType: reconciliation.toType,
      }))
      .sort((left, right) => compareStrings(left.entityId, right.entityId));

  const dropped: readonly NormalizedDropped[] = report.dropped
    .map((item) => ({
      kind: item.kind,
      id: item.id,
      reason: item.reason,
    }))
    .sort((left, right) =>
      compareStrings(`${left.kind}|${left.id}`, `${right.kind}|${right.id}`),
    );

  const baseAmbiguities: readonly NormalizedBaseAmbiguity[] =
    report.baseAmbiguities
      .map((ambiguity) => ({
        baseIds: ambiguity.baseIds
          .map((identity) => `${identity.kind}|${identity.id as string}`)
          .sort((left, right) => compareStrings(left, right)),
        memberIds: ambiguity.memberIds
          .map((identity) => `${identity.kind}|${identity.id as string}`)
          .sort((left, right) => compareStrings(left, right)),
      }))
      .sort((left, right) =>
        compareStrings(left.baseIds.join(","), right.baseIds.join(",")),
      );

  const provenance: readonly NormalizedProvenance[] = [...branchIds]
    .sort((left, right) => compareStrings(left, right))
    .map((branchId) => {
      const contribution = report.provenance.byBranch(branchId);
      return {
        branchId: branchId,
        nodeIds: [...contribution.nodeIds]
          .map((id) => id as string)
          .sort((left, right) => compareStrings(left, right)),
        edgeIds: [...contribution.edgeIds]
          .map((id) => id as string)
          .sort((left, right) => compareStrings(left, right)),
      };
    });

  return {
    merged: { nodes: report.merged.nodes, edges: report.merged.edges },
    resolutions,
    conflicts,
    deleteModifyConflicts,
    typeReconciliations,
    dropped,
    baseAmbiguities,
    provenance,
  };
}

/**
 * Reduces a committed store's LIVE graph to a {@link NormalizedGraph}: every live
 * node/edge across every kind, with wall-clock / version meta stripped and props
 * rendered to canonical JSON, sorted by id. Two merges of the same branch set in
 * any order commit a deep-equal graph.
 *
 * Soft-deleted rows are excluded — a delete-wins outcome must compare equal to
 * another delete-wins outcome whether the row physically exists (soft-deleted) or
 * not, so the comparator looks only at the live projection.
 */
export async function normalizeGraph<G extends GraphDef>(
  store: Store<G>,
): Promise<NormalizedGraph> {
  const nodeKinds = getNodeKinds(store.graph);
  const edgeKinds = getEdgeKinds(store.graph);

  const nodes: NormalizedNode[] = [];
  for (const kind of nodeKinds) {
    const rows = await enumerateAllNodes(
      storeBackend(store),
      store.graphId,
      kind,
    );
    for (const row of rows) {
      if (row.deleted_at !== undefined) {
        continue;
      }
      const props = rowPropsToObject(row.props);
      nodes.push({ id: row.id, kind: row.kind, props: canonicalProps(props) });
    }
  }

  const edges: NormalizedEdge[] = [];
  for (const kind of edgeKinds) {
    const rows = await enumerateAllEdges(
      storeBackend(store),
      store.graphId,
      kind,
    );
    for (const row of rows) {
      if (row.deleted_at !== undefined) {
        continue;
      }
      const props = rowPropsToObject(row.props);
      edges.push({
        id: row.id,
        kind: row.kind,
        from: row.from_id,
        to: row.to_id,
        fromKind: row.from_kind,
        toKind: row.to_kind,
        props: canonicalProps(props),
      });
    }
  }

  return {
    nodes: nodes.sort((left, right) => compareStrings(left.id, right.id)),
    edges: edges.sort((left, right) => compareStrings(left.id, right.id)),
  };
}
