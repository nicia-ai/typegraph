import type { z } from "zod";

import {
  computeMergePlanDigest,
  finalizeMergePlanArtifact,
} from "./plan-canonical";
import {
  MERGE_PLAN_FORMAT_VERSION,
  type MergePlanArtifactV2,
  type MergePlanArtifactV2Input,
  mergePlanArtifactV2InputSchema,
  mergePlanArtifactV2Schema,
} from "./plan-schema";

type MergePlanParseFailure =
  | Readonly<{ kind: "unsupported-version"; received: unknown }>
  | Readonly<{ kind: "malformed"; issues: z.core.$ZodIssue[] }>;

export type MergePlanParseResult =
  | Readonly<{ success: true; artifact: MergePlanArtifactV2 }>
  | Readonly<{ success: false; error: MergePlanParseFailure }>;

export type MergePlanDigestResult =
  | Readonly<{ valid: true }>
  | Readonly<{ valid: false; expected: string; received: string }>;

export type MergePlanValidationResult =
  | Readonly<{ success: true; artifact: MergePlanArtifactV2 }>
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

/** Parses an untrusted value without conflating an unknown version with bad V2 data. */
export function parseMergePlanArtifact(input: unknown): MergePlanParseResult {
  const version = readFormatVersion(input);
  if (version !== MERGE_PLAN_FORMAT_VERSION) {
    return {
      success: false,
      error: { kind: "unsupported-version", received: version },
    };
  }
  const parsed = mergePlanArtifactV2Schema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: { kind: "malformed", issues: parsed.error.issues },
    };
  }
  return {
    success: true,
    artifact: parsed.data as unknown as MergePlanArtifactV2,
  };
}

/** Verifies the digest on a structurally valid artifact. */
export async function verifyMergePlanDigest(
  artifact: MergePlanArtifactV2,
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

/** Constructs and hashes a V2 wire artifact. */
export async function constructMergePlanArtifact(
  input: MergePlanArtifactV2Input,
): Promise<MergePlanArtifactV2> {
  const validatedInput = mergePlanArtifactV2InputSchema.parse(input);
  return finalizeMergePlanArtifact(
    validatedInput as unknown as MergePlanArtifactV2Input,
  );
}

function readFormatVersion(input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  return Reflect.get(input, "formatVersion") as unknown;
}

export type {
  MergePlanArtifactV2,
  MergePlanArtifactV2Input,
} from "./plan-schema";
