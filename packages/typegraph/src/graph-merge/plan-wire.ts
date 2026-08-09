import type { z } from "zod";

import {
  computeMergePlanDigest,
  finalizeMergePlanArtifact,
} from "./plan-canonical";
import {
  MERGE_PLAN_FORMAT_VERSION,
  type MergePlanArtifactV1,
  type MergePlanArtifactV1Input,
  mergePlanArtifactV1InputSchema,
  mergePlanArtifactV1Schema,
} from "./plan-schema";

type MergePlanParseFailure =
  | Readonly<{ kind: "unsupported-version"; received: unknown }>
  | Readonly<{ kind: "malformed"; issues: z.core.$ZodIssue[] }>;

export type MergePlanParseResult =
  | Readonly<{ success: true; artifact: MergePlanArtifactV1 }>
  | Readonly<{ success: false; error: MergePlanParseFailure }>;

export type MergePlanDigestResult =
  | Readonly<{ valid: true }>
  | Readonly<{ valid: false; expected: string; received: string }>;

export type MergePlanValidationResult =
  | Readonly<{ success: true; artifact: MergePlanArtifactV1 }>
  | Readonly<{
      success: false;
      error:
        | MergePlanParseFailure
        | Readonly<{
            kind: "digest-mismatch";
            expected: string;
            received: string;
          }>;
    }>;

/** Parses an untrusted value without conflating an unknown version with bad V1 data. */
export function parseMergePlanArtifact(input: unknown): MergePlanParseResult {
  const version = readFormatVersion(input);
  if (version !== MERGE_PLAN_FORMAT_VERSION) {
    return {
      success: false,
      error: { kind: "unsupported-version", received: version },
    };
  }
  const parsed = mergePlanArtifactV1Schema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: { kind: "malformed", issues: parsed.error.issues },
    };
  }
  return {
    success: true,
    artifact: parsed.data as unknown as MergePlanArtifactV1,
  };
}

/** Verifies the digest on a structurally valid artifact. */
export async function verifyMergePlanDigest(
  artifact: MergePlanArtifactV1,
): Promise<MergePlanDigestResult> {
  const expected = await computeMergePlanDigest(artifact);
  const received = artifact.digest.value;
  return expected === received ?
      { valid: true }
    : { valid: false, expected, received };
}

/** Performs the complete pure wire-boundary validation used before target checks. */
export async function validateMergePlanArtifact(
  input: unknown,
): Promise<MergePlanValidationResult> {
  const parsed = parseMergePlanArtifact(input);
  if (!parsed.success) return parsed;
  const digest = await verifyMergePlanDigest(parsed.artifact);
  if (!digest.valid) {
    return {
      success: false,
      error: {
        kind: "digest-mismatch",
        expected: digest.expected,
        received: digest.received,
      },
    };
  }
  return parsed;
}

/** Constructs and hashes a V1 wire artifact. */
export async function constructMergePlanArtifact(
  input: MergePlanArtifactV1Input,
): Promise<MergePlanArtifactV1> {
  const validatedInput = mergePlanArtifactV1InputSchema.parse(input);
  return finalizeMergePlanArtifact(
    validatedInput as unknown as MergePlanArtifactV1Input,
  );
}

function readFormatVersion(input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  return Reflect.get(input, "formatVersion") as unknown;
}

export type {
  MergePlanArtifactV1,
  MergePlanArtifactV1Input,
} from "./plan-schema";
