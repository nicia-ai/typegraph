import {
  CandidateWriteSetSchema,
  planCandidateWriteSet,
  type PlanCandidateWriteSetArgs,
} from "./candidate-write-set";
import {
  MergeError,
  MergePlanningStaleError,
  MergeReviewError,
} from "./errors";
import {
  assertPlanningFenceUnchanged,
  captureMergePlanTargetFence,
  sameMergePlanTargetFence,
} from "./merge";
import type { MergePlanArtifact, MergePlanTargetFence } from "./plan-schema";
import { validateMergePlanArtifact } from "./plan-wire";
import { err, isErr, ok, type Result } from "./result";
import {
  captureReviewBaseline,
  compareReviewBaseline,
  reviewRowKey,
  withReviewAbsences,
} from "./review-baseline";
import {
  reviewDigest,
  reviewJson,
  reviewOptionEvidence,
} from "./review-evidence";
import {
  MERGE_REVIEW_FORMAT_VERSION,
  type MergeReviewArtifact,
  mergeReviewArtifactSchema,
  type MergeReviewDifference,
  type MergeReviewPolicy,
  mergeReviewPolicySchema,
  type MergeReviewRevalidation,
} from "./review-schema";
import type { GraphDef } from "./typegraph-internal";

export type PlanCandidateWriteSetReviewArgs<G extends GraphDef> =
  PlanCandidateWriteSetArgs<G> &
    Readonly<{
      policy: MergeReviewPolicy;
    }>;

export type RevalidateCandidateWriteSetReviewArgs<G extends GraphDef> = Omit<
  PlanCandidateWriteSetReviewArgs<G>,
  "writeSet"
> &
  Readonly<{
    review: unknown;
  }>;

/** Capture a durable review, with planning and baseline reads under one fence. */
export async function planCandidateWriteSetReview<G extends GraphDef>(
  args: PlanCandidateWriteSetReviewArgs<G>,
): Promise<Result<MergeReviewArtifact, MergeError>> {
  try {
    const writeSet = CandidateWriteSetSchema.parse(args.writeSet);
    const policy = mergeReviewPolicySchema.parse(args.policy);
    const options = reviewOptionEvidence(args.options);
    const startingFence = await captureMergePlanTargetFence(args.target);
    const baseline = await captureReviewBaseline(args.target);
    const planned = await planCandidateWriteSet({ ...args, writeSet });
    if (isErr(planned)) return planned;
    assertReviewPlanFence(startingFence, planned.data);
    await assertPlanningFenceUnchanged(args.target, startingFence);
    assertOptionsUnchanged(options, reviewOptionEvidence(args.options));
    const input = {
      formatVersion: MERGE_REVIEW_FORMAT_VERSION,
      kind: "candidate-write-set" as const,
      writeSet,
      policy,
      options,
      plan: planned.data,
      baseline: withReviewAbsences(
        baseline,
        writeSet,
        planned.data,
        args.target.graph,
      ),
    };
    const review: MergeReviewArtifact = {
      ...input,
      digest: { algorithm: "sha256", value: await reviewDigest(input) },
    };
    mergeReviewArtifactSchema.parse(review);
    return ok(review);
  } catch (error) {
    return err(asReviewError(error));
  }
}

/**
 * Replan the retained input and relate it to its original review. Never writes
 * the target, edits an old plan, or authorizes execution. Apply a compatible
 * result with applyMergePlan(), retaining its final transactional revision fence.
 */
export async function revalidateCandidateWriteSetReview<G extends GraphDef>(
  args: RevalidateCandidateWriteSetReviewArgs<G>,
): Promise<Result<MergeReviewRevalidation, MergeError>> {
  try {
    const review = await validateReview(args.review);
    const policy = mergeReviewPolicySchema.parse(args.policy);
    const options = reviewOptionEvidence(args.options);
    const startingFence = await captureMergePlanTargetFence(args.target);
    const targetDifferences = compareReviewTarget(
      review.plan.target,
      startingFence,
    );
    if (targetDifferences.length > 0)
      return ok({
        status: "incompatible",
        reviewDigest: review.digest,
        differences: targetDifferences,
      });
    if (
      withReviewAbsences(
        review.baseline,
        review.writeSet,
        review.plan,
        args.target.graph,
      ).rows.length !== review.baseline.rows.length
    ) {
      throw new MergeReviewError(
        "The merge review is missing required baseline evidence.",
        { details: { reason: "incomplete-baseline" } },
      );
    }
    const policyDifferences = compareFields(
      "policy",
      { policy: review.policy, options: review.options },
      { policy, options },
    );
    if (policyDifferences.length > 0)
      return ok({
        status: "changed",
        reviewDigest: review.digest,
        differences: policyDifferences,
      });

    const baseline = await captureReviewBaseline(args.target);
    const baselineDifferences = compareReviewBaseline(
      review.baseline,
      baseline,
    );
    if (baselineDifferences.length > 0) {
      await assertPlanningFenceUnchanged(args.target, startingFence);
      return ok({
        status: "changed",
        reviewDigest: review.digest,
        differences: baselineDifferences,
      });
    }
    const planned = await planCandidateWriteSet({
      ...args,
      writeSet: review.writeSet,
    });
    if (isErr(planned)) return planned;
    assertReviewPlanFence(startingFence, planned.data);
    await assertPlanningFenceUnchanged(args.target, startingFence);
    assertOptionsUnchanged(options, reviewOptionEvidence(args.options));
    const differences = compareFields(
      "plan",
      reviewPlanContent(review.plan),
      reviewPlanContent(planned.data),
    );
    return ok(
      differences.length === 0 ?
        {
          status: "compatible",
          reviewDigest: review.digest,
          plan: planned.data,
        }
      : {
          status: "changed",
          reviewDigest: review.digest,
          differences,
          plan: planned.data,
        },
    );
  } catch (error) {
    return err(asReviewError(error));
  }
}

async function validateReview(input: unknown): Promise<MergeReviewArtifact> {
  const review = mergeReviewArtifactSchema.parse(input);
  // Candidate staging schemas normalize defaults and strip unknown transport
  // fields. Stored review evidence must already be normalized: otherwise an
  // added field could disappear before its digest is checked.
  if (reviewJson(input) !== reviewJson(review)) {
    throw new MergeReviewError(
      "Stored merge review evidence must not require normalization.",
      {
        details: { reason: "noncanonical-shape" },
      },
    );
  }
  const { digest, ...content } = review;
  if (digest.value !== (await reviewDigest(content))) {
    throw new MergeReviewError(
      "The merge review digest does not match its content.",
      { details: { reason: "digest-mismatch" } },
    );
  }
  const plan = await validateMergePlanArtifact(review.plan);
  if (!plan.success)
    throw new MergeReviewError("The reviewed execution plan is invalid.", {
      details: { reason: "invalid-plan", error: plan.error },
    });
  const anchors = plan.artifact.anchors;
  if (
    plan.artifact.mode !== "incremental" ||
    anchors.kind !== "incremental" ||
    anchors.forkPoint.graphId !== review.writeSet.target.graphId ||
    plan.artifact.target.graphId !== review.writeSet.target.graphId ||
    plan.artifact.target.schema.version !==
      review.writeSet.target.schemaVersion ||
    plan.artifact.target.schema.hash !== review.writeSet.target.schemaHash ||
    reviewJson(anchors.forkPoint.schema) !==
      reviewJson(plan.artifact.target.schema) ||
    anchors.branches.length !== 1 ||
    anchors.branches[0]?.branchId !== review.writeSet.sourceId ||
    anchors.branches[0].baseVersion !== anchors.forkPoint.baseVersion
  ) {
    throw new MergeReviewError(
      "The reviewed plan does not describe the retained candidate source and target.",
      { details: { reason: "incompatible-plan" } },
    );
  }
  if (
    new Set(review.baseline.rows.map((row) => reviewRowKey(row))).size !==
    review.baseline.rows.length
  ) {
    throw new MergeReviewError(
      "The merge review contains duplicate baseline references.",
      { details: { reason: "duplicate-baseline" } },
    );
  }
  return { ...review, plan: plan.artifact };
}

function assertReviewPlanFence(
  fence: MergePlanTargetFence,
  plan: MergePlanArtifact,
): void {
  if (!sameMergePlanTargetFence(fence, plan.target)) {
    throw new MergePlanningStaleError(
      "The target changed between review evidence capture and planning.",
    );
  }
}

function assertOptionsUnchanged(before: unknown, after: unknown): void {
  if (reviewJson(before) !== reviewJson(after))
    throw new MergeReviewError(
      "Merge options changed while review evidence was being captured.",
    );
}

function compareReviewTarget(
  reviewed: MergePlanTargetFence,
  current: MergePlanTargetFence,
): readonly MergeReviewDifference[] {
  return compareFields(
    "target",
    {
      graphId: reviewed.graphId,
      schema: reviewed.schema,
      origin: reviewed.revision.origin,
    },
    {
      graphId: current.graphId,
      schema: current.schema,
      origin: current.revision.origin,
    },
  );
}

/**
 * Only the candidate adapter may replace its target-derived fork/branch anchors:
 * it recreates them from the retained input on every call. No arbitrary snapshot
 * or incremental plan is accepted by this protocol. Keep every other field.
 */
function reviewPlanContent(
  plan: MergePlanArtifact,
): Omit<MergePlanArtifact, "digest" | "target" | "anchors"> {
  const {
    digest: _digest,
    target: _target,
    anchors: _anchors,
    ...content
  } = plan;
  return content;
}

function compareFields(
  category: MergeReviewDifference["category"],
  reviewed: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>>,
): readonly MergeReviewDifference[] {
  return [...new Set([...Object.keys(reviewed), ...Object.keys(current)])]
    .sort()
    .filter((key) => reviewJson(reviewed[key]) !== reviewJson(current[key]))
    .map((key) => ({ category, path: `${category}.${key}` }));
}

function asReviewError(error: unknown): MergeError {
  return error instanceof MergeError ? error : (
      new MergeReviewError(
        "Unable to validate or capture merge review evidence.",
        { cause: error },
      )
    );
}
