/**
 * The optimistic guard on a node delete, `delete(id, { expect })`: reading the
 * stated options, and the one comparison between the plan a caller confirmed
 * and the plan the delete computes for itself.
 */
import { z } from "zod";

import {
  NodeDeletePlanMismatchError,
  ValidationError,
  type ValidationIssue,
} from "../../errors";
import { zodIssuesToValidationIssues } from "../../errors/validation";
import { compareStrings } from "../../utils/compare";
import { encodeTupleKey } from "../../utils/tuple-key";
import { type CompositionCascadedPart, type NodeDeletePlan } from "../types";

type DeletedNode = Readonly<{ kind: string; id: string }>;

const NODE_REF_SCHEMA = z.strictObject({ kind: z.string(), id: z.string() });

const NODE_DELETE_OPTIONS_SCHEMA = z.strictObject({
  expect: z.strictObject({
    cascadedParts: z.array(
      z.strictObject({
        kind: z.string(),
        id: z.string(),
        whole: NODE_REF_SCHEMA,
        viaEdgeKind: z.string(),
      }),
    ),
    removedEdgeIds: z.array(z.string()),
  }),
});

/**
 * The `expect` plan `delete(id, options)` must honor, or `undefined` when the
 * caller passed no options. Refuses with `ValidationError` anything that is
 * not exactly a `NodeDeleteOptions`: an unknown key, a missing or
 * `undefined` `expect`, a plan of the wrong shape, or a plan naming one part
 * or edge id twice, which no `planDelete` answer does.
 */
export function readNodeDeleteOptions(
  options: unknown,
  node: DeletedNode,
): NodeDeletePlan | undefined {
  if (options === undefined) return undefined;
  const parsed = NODE_DELETE_OPTIONS_SCHEMA.safeParse(options);
  const issues =
    parsed.success ?
      duplicateEntryIssues(parsed.data.expect)
    : zodIssuesToValidationIssues(parsed.error);
  if (!parsed.success || issues.length > 0) {
    throw new ValidationError(
      `Invalid delete options for ${node.kind}/${node.id}: ${issues.map((issue) => issue.path || "(root)").join(", ")}`,
      {
        entityType: "node",
        kind: node.kind,
        id: node.id,
        operation: "delete",
        issues,
      },
      {
        suggestion:
          "Pass `{ expect: plan }` with the plan planDelete(id) returned, or omit the options for an unguarded delete.",
      },
    );
  }
  return parsed.data.expect;
}

function duplicateEntryIssues(plan: NodeDeletePlan): ValidationIssue[] {
  const seenParts = new Set<string>();
  const seenEdgeIds = new Set<string>();
  const issues: ValidationIssue[] = [];
  for (const [index, part] of plan.cascadedParts.entries()) {
    const key = encodeTupleKey([part.kind, part.id]);
    if (seenParts.has(key)) {
      issues.push({
        path: `expect.cascadedParts.${index}`,
        message: `Part ${part.kind}/${part.id} is listed more than once.`,
      });
    }
    seenParts.add(key);
  }
  for (const [index, edgeId] of plan.removedEdgeIds.entries()) {
    if (seenEdgeIds.has(edgeId)) {
      issues.push({
        path: `expect.removedEdgeIds.${index}`,
        message: `Edge id "${edgeId}" is listed more than once.`,
      });
    }
    seenEdgeIds.add(edgeId);
  }
  return issues;
}

/**
 * How the plan a delete computed differs from the plan it was told to
 * expect. `added*` entries are in the delete's plan only, `dropped*` entries
 * in the expected plan only.
 */
type NodeDeletePlanDiff = Readonly<{
  addedParts: readonly CompositionCascadedPart[];
  droppedParts: readonly CompositionCascadedPart[];
  addedEdgeIds: readonly string[];
  droppedEdgeIds: readonly string[];
}>;

/**
 * THE comparison of two delete plans, order-insensitive: a part matches only
 * the same `(kind, id, whole, viaEdgeKind)`, so a reparented part reads as
 * dropped under its old whole and added under its new one, and an edge
 * matches by id. `undefined` when the plans are the same.
 */
function diffNodeDeletePlans(
  expected: NodeDeletePlan,
  actual: NodeDeletePlan,
): NodeDeletePlanDiff | undefined {
  const diff: NodeDeletePlanDiff = {
    addedParts: partsAbsentFrom(actual.cascadedParts, expected.cascadedParts),
    droppedParts: partsAbsentFrom(expected.cascadedParts, actual.cascadedParts),
    addedEdgeIds: edgeIdsAbsentFrom(
      actual.removedEdgeIds,
      expected.removedEdgeIds,
    ),
    droppedEdgeIds: edgeIdsAbsentFrom(
      expected.removedEdgeIds,
      actual.removedEdgeIds,
    ),
  };
  const unchanged =
    diff.addedParts.length === 0 &&
    diff.droppedParts.length === 0 &&
    diff.addedEdgeIds.length === 0 &&
    diff.droppedEdgeIds.length === 0;
  return unchanged ? undefined : diff;
}

/**
 * Refuses a guarded delete whose own plan is not `expected`: `actual` is
 * `undefined` when the node is absent or already deleted.
 *
 * @throws NodeDeletePlanMismatchError
 */
export function assertNodeDeletePlanExpected(
  node: DeletedNode,
  expected: NodeDeletePlan,
  actual: NodeDeletePlan | undefined,
): void {
  if (actual === undefined) {
    throw new NodeDeletePlanMismatchError({
      kind: node.kind,
      id: node.id,
      situation: "notLive",
    });
  }
  const diff = diffNodeDeletePlans(expected, actual);
  if (diff === undefined) return;
  throw new NodeDeletePlanMismatchError({
    kind: node.kind,
    id: node.id,
    situation: "changed",
    ...diff,
  });
}

function cascadedPartKey(part: CompositionCascadedPart): string {
  return encodeTupleKey([
    part.kind,
    part.id,
    part.whole.kind,
    part.whole.id,
    part.viaEdgeKind,
  ]);
}

function partsAbsentFrom(
  parts: readonly CompositionCascadedPart[],
  other: readonly CompositionCascadedPart[],
): readonly CompositionCascadedPart[] {
  const otherKeys = new Set(other.map((part) => cascadedPartKey(part)));
  return parts.filter((part) => !otherKeys.has(cascadedPartKey(part)));
}

function edgeIdsAbsentFrom(
  edgeIds: readonly string[],
  other: readonly string[],
): readonly string[] {
  const otherIds = new Set(other);
  return edgeIds
    .filter((edgeId) => !otherIds.has(edgeId))
    .toSorted((left, right) => compareStrings(left, right));
}
