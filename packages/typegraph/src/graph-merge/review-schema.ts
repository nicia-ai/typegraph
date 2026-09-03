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

export const MERGE_REVIEW_FORMAT_VERSION = 1 as const;

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

/** Conservative baseline: all original rows and the complete identity ledger. */
export type MergeReviewBaseline = Readonly<{
  rows: readonly MergeReviewRow[];
  identityDigest: string;
}>;

/**
 * Immutable review evidence, distinct from its single-use execution plan.
 * V1 supports candidate write sets only. Authenticate stored artifacts separately.
 */
export type MergeReviewArtifact = Readonly<{
  formatVersion: typeof MERGE_REVIEW_FORMAT_VERSION;
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
    formatVersion: z.literal(MERGE_REVIEW_FORMAT_VERSION),
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
      })
      .strict(),
  })
  .strict();
