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
import { mergePlanArtifactV1Schema } from "./plan-schema";
import type { JsonValue } from "./typegraph-internal";

/** Default review format, retained for callers that validate V1 artifacts. */
export const MERGE_REVIEW_FORMAT_VERSION = 1 as const;
export const MERGE_REVIEW_FORMAT_VERSION_V1 = MERGE_REVIEW_FORMAT_VERSION;
export const MERGE_REVIEW_FORMAT_VERSION_V2 = 2 as const;

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

/** V1 retains a global baseline; V2 records the exact candidate identity scope. */
export type MergeReviewBaseline = Readonly<{
  rows: readonly MergeReviewRow[];
  identityDigest: string;
  scope?: "referenced" | undefined;
  /** Present in V2: endpoint scope retained to make revalidation exact. */
  identityReferences?: readonly MergePlanEntityRef[] | undefined;
  /** Candidate assertion IDs whose unrelated ID collisions affect import. */
  identityAssertionIds?: readonly string[] | undefined;
}>;

/**
 * Immutable review evidence, distinct from its single-use execution plan.
 * Both versions support candidate write sets. Authenticate stored artifacts
 * separately.
 */
export type MergeReviewArtifact = Readonly<{
  formatVersion:
    | typeof MERGE_REVIEW_FORMAT_VERSION_V1
    | typeof MERGE_REVIEW_FORMAT_VERSION_V2;
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
      z.literal(MERGE_REVIEW_FORMAT_VERSION_V1),
      z.literal(MERGE_REVIEW_FORMAT_VERSION_V2),
    ]),
    kind: z.literal("candidate-write-set"),
    digest: z
      .object({ algorithm: z.literal("sha256"), value: digestSchema })
      .strict(),
    writeSet: CandidateWriteSetSchema,
    policy: mergeReviewPolicySchema,
    options: z.json(),
    plan: mergePlanArtifactV1Schema,
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
