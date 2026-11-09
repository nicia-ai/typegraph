import { sortedReplacer } from "../schema/canonical";
import { sha256Hex } from "../utils/hash";
import {
  MERGE_PLAN_DIGEST_ALGORITHM,
  type MergePlanArtifact,
  type MergePlanArtifactInput,
} from "./plan-schema";

/** Returns the recursively key-sorted JSON representation used for plan identity. */
export function canonicalMergePlanJson(
  artifact: MergePlanArtifact | MergePlanArtifactInput,
): string {
  const digestless = "digest" in artifact ? omitDigest(artifact) : artifact;
  return JSON.stringify(digestless, sortedReplacer);
}

/** Computes the full 256-bit digest of every plan field except `digest` itself. */
export async function computeMergePlanDigest(
  artifact: MergePlanArtifact | MergePlanArtifactInput,
): Promise<string> {
  return sha256Hex(canonicalMergePlanJson(artifact), 32);
}

/** Adds the canonical digest to an otherwise complete V1 artifact. */
export async function finalizeMergePlanArtifact(
  artifact: MergePlanArtifactInput,
): Promise<MergePlanArtifact> {
  const finalized = {
    ...artifact,
    digest: {
      algorithm: MERGE_PLAN_DIGEST_ALGORITHM,
      value: await computeMergePlanDigest(artifact),
    },
  };
  const canonical: unknown = JSON.parse(
    JSON.stringify(finalized, sortedReplacer),
  );
  return canonical as MergePlanArtifact;
}

function omitDigest(artifact: MergePlanArtifact): MergePlanArtifactInput {
  const { digest: _digest, ...digestless } = artifact;
  return digestless;
}
