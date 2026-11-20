import type { z } from "zod";

import {
  computeMergePlanDigest,
  finalizeMergePlanArtifact,
} from "./plan-canonical";
import {
  LEGACY_MERGE_PLAN_FORMAT_VERSIONS,
  legacyMergePlanArtifactSchema,
  MERGE_PLAN_FORMAT_VERSION,
  type MergePlanArtifact,
  type MergePlanArtifactV3,
  type MergePlanArtifactV3Input,
  mergePlanArtifactV3InputSchema,
  mergePlanArtifactV3Schema,
} from "./plan-schema";

type MergePlanParseFailure =
  | Readonly<{ kind: "unsupported-version"; received: unknown }>
  | Readonly<{ kind: "malformed"; issues: z.core.$ZodIssue[] }>;

export type MergePlanParseResult =
  | Readonly<{ success: true; artifact: MergePlanArtifact }>
  | Readonly<{ success: false; error: MergePlanParseFailure }>;

export type MergePlanDigestResult =
  | Readonly<{ valid: true }>
  | Readonly<{ valid: false; expected: string; received: string }>;

export type MergePlanValidationResult =
  | Readonly<{ success: true; artifact: MergePlanArtifact }>
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

/**
 * Parses an untrusted value without conflating an unknown version with
 * malformed data. A legacy format parses under its own grammar, for
 * inspection; applying it is refused.
 */
export function parseMergePlanArtifact(input: unknown): MergePlanParseResult {
  const version = readFormatVersion(input);
  if (
    version !== MERGE_PLAN_FORMAT_VERSION &&
    !(LEGACY_MERGE_PLAN_FORMAT_VERSIONS as readonly unknown[]).includes(version)
  ) {
    return {
      success: false,
      error: { kind: "unsupported-version", received: version },
    };
  }
  const parsed =
    version === MERGE_PLAN_FORMAT_VERSION ?
      mergePlanArtifactV3Schema.safeParse(input)
    : legacyMergePlanArtifactSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: { kind: "malformed", issues: parsed.error.issues },
    };
  }
  return {
    success: true,
    artifact: parsed.data as unknown as MergePlanArtifact,
  };
}

/** Verifies the digest on a structurally valid artifact. */
export async function verifyMergePlanDigest(
  artifact: MergePlanArtifact,
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

/** Constructs and hashes a current-format wire artifact. */
export async function constructMergePlanArtifact(
  input: MergePlanArtifactV3Input,
): Promise<MergePlanArtifactV3> {
  const validatedInput = mergePlanArtifactV3InputSchema.parse(input);
  return finalizeMergePlanArtifact(
    validatedInput as unknown as MergePlanArtifactV3Input,
  );
}

/** Reads a wire artifact's `formatVersion` before any schema validation. */
export function readFormatVersion(input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  return Reflect.get(input, "formatVersion") as unknown;
}

export type {
  MergePlanArtifact,
  MergePlanArtifactV3,
  MergePlanArtifactV3Input,
} from "./plan-schema";
