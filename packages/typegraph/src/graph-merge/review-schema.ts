import { z } from "zod";

import {
  type CandidateWriteSet,
  CandidateWriteSetSchema,
} from "./candidate-write-set";
import type {
  MergePlanArtifact,
  MergePlanDigest,
  MergePlanEntityRef,
} from "./plan-schema";
import { mergePlanArtifactV2Schema } from "./plan-schema";
import type { JsonValue } from "./typegraph-internal";

// A review embeds its plan under the strict plan schema, so a review stored
// before the plan's own 1 -> 2 bump (`MERGE_PLAN_FORMAT_VERSION`) can never
// validate. Formats 1 (whole-target baseline) and 2 (candidate-scoped
// baseline) embedded a version-1 plan; both evidence modes are numbered past
// them so a stored one is refused as an unsupported version rather than as
// malformed.

/** The default review format: its baseline covers the whole target. */
export const MERGE_REVIEW_FORMAT_VERSION = 3 as const;
/** The opt-in review format whose baseline covers the candidate's own scope. */
export const MERGE_REVIEW_FORMAT_VERSION_CANDIDATE_SCOPED = 4 as const;

/** Every review format this library version validates, in ascending order. */
export const SUPPORTED_MERGE_REVIEW_FORMAT_VERSIONS = [
  MERGE_REVIEW_FORMAT_VERSION,
  MERGE_REVIEW_FORMAT_VERSION_CANDIDATE_SCOPED,
] as const;

type MergeReviewFormatVersion =
  (typeof SUPPORTED_MERGE_REVIEW_FORMAT_VERSIONS)[number];

/** Whether a stored review's `formatVersion` is one this library validates. */
export function isSupportedMergeReviewFormatVersion(
  formatVersion: unknown,
): formatVersion is MergeReviewFormatVersion {
  return (
    formatVersion === MERGE_REVIEW_FORMAT_VERSION ||
    formatVersion === MERGE_REVIEW_FORMAT_VERSION_CANDIDATE_SCOPED
  );
}

/** Application-owned identity of policy code and all opaque/external dependencies. */
export type MergeReviewPolicy = Readonly<{
  id: string;
  /** Explicit evidence; use an empty object only when there are no such dependencies. */
  context: JsonValue;
}>;

/** A fingerprint of an observed row, or an expected absence. */
export type MergeReviewRow = MergePlanEntityRef &
  Readonly<{
    role: "node" | "edge";
    /** Absent means this reference did not exist at review time. */
    digest?: string | undefined;
  }>;

/**
 * The default format retains a whole-target baseline; the candidate-scoped
 * format records the exact candidate identity scope.
 */
export type MergeReviewBaseline = Readonly<{
  rows: readonly MergeReviewRow[];
  identityDigest: string;
  scope?: "referenced" | undefined;
  /** Present in the candidate-scoped format: endpoint scope retained to make revalidation exact. */
  identityReferences?: readonly MergePlanEntityRef[] | undefined;
  /** Candidate assertion IDs whose unrelated ID collisions affect import. */
  identityAssertionIds?: readonly string[] | undefined;
}>;

/**
 * Immutable review evidence, distinct from its single-use execution plan.
 * Both formats review candidate write sets. Authenticate stored artifacts
 * separately.
 */
export type MergeReviewArtifact = Readonly<{
  formatVersion: MergeReviewFormatVersion;
  kind: "candidate-write-set";
  digest: MergePlanDigest;
  writeSet: CandidateWriteSet;
  policy: MergeReviewPolicy;
  options: JsonValue;
  plan: MergePlanArtifact;
  baseline: MergeReviewBaseline;
}>;

/** Structured reason to refuse approval reuse; paths name fields in the review. */
export type MergeReviewDifference = Readonly<{
  category: "target" | "policy" | "baseline" | "plan";
  path: string;
  entity?: MergePlanEntityRef & Readonly<{ role: "node" | "edge" }>;
}>;

/** Compatibility is evidence for application policy, never an authorization decision. */
export type MergeReviewRevalidation =
  | Readonly<{
      status: "compatible";
      reviewDigest: MergePlanDigest;
      plan: MergePlanArtifact;
    }>
  | Readonly<{
      status: "changed" | "incompatible";
      reviewDigest: MergePlanDigest;
      differences: readonly MergeReviewDifference[];
      /** Present when a fresh plan was computed; it requires a new review. */
      plan?: MergePlanArtifact;
    }>;

const digestSchema = z.string().regex(/^[\da-f]{64}$/u);

export const mergeReviewPolicySchema = z
  .object({
    id: z.string().min(1),
    context: z.json(),
  })
  .strict();

export const mergeReviewArtifactSchema = z
  .object({
    formatVersion: z.union([
      z.literal(MERGE_REVIEW_FORMAT_VERSION),
      z.literal(MERGE_REVIEW_FORMAT_VERSION_CANDIDATE_SCOPED),
    ]),
    kind: z.literal("candidate-write-set"),
    digest: z
      .object({ algorithm: z.literal("sha256"), value: digestSchema })
      .strict(),
    writeSet: CandidateWriteSetSchema,
    policy: mergeReviewPolicySchema,
    options: z.json(),
    plan: mergePlanArtifactV2Schema,
    baseline: z
      .object({
        rows: z.array(
          z
            .object({
              role: z.enum(["node", "edge"]),
              kind: z.string().min(1),
              id: z.string().min(1),
              digest: digestSchema.optional(),
            })
            .strict(),
        ),
        identityDigest: digestSchema,
        scope: z.literal("referenced").optional(),
        identityReferences: z
          .array(
            z
              .object({ kind: z.string().min(1), id: z.string().min(1) })
              .strict(),
          )
          .optional(),
        identityAssertionIds: z.array(z.string().min(1)).optional(),
      })
      .strict(),
  })
  .strict();
