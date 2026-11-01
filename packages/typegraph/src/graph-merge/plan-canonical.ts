import { sortedReplacer } from "../schema/canonical";
import { sha256Hex } from "../utils/hash";
import {
  MERGE_PLAN_DIGEST_ALGORITHM,
  type MergePlanArtifactV2,
  type MergePlanArtifactV2Input,
} from "./plan-schema";

/** Returns the recursively key-sorted JSON representation used for plan identity. */
export function canonicalMergePlanJson(
  artifact: MergePlanArtifactV2 | MergePlanArtifactV2Input,
): string {
  const digestless = "digest" in artifact ? omitDigest(artifact) : artifact;
  return JSON.stringify(digestless, sortedReplacer);
}

/** Computes the full 256-bit digest of every plan field except `digest` itself. */
export async function computeMergePlanDigest(
  artifact: MergePlanArtifactV2 | MergePlanArtifactV2Input,
): Promise<string> {
  return sha256Hex(canonicalMergePlanJson(artifact), 32);
}

/** Adds the canonical digest to an otherwise complete V2 artifact. */
export async function finalizeMergePlanArtifact(
  artifact: MergePlanArtifactV2Input,
): Promise<MergePlanArtifactV2> {
  const finalized: MergePlanArtifactV2 = {
    ...artifact,
    digest: {
      algorithm: MERGE_PLAN_DIGEST_ALGORITHM,
      value: await computeMergePlanDigest(artifact),
    },
  };
  const canonical: unknown = JSON.parse(
    JSON.stringify(finalized, sortedReplacer),
  );
  return canonical as MergePlanArtifactV2;
}

function omitDigest(artifact: MergePlanArtifactV2): MergePlanArtifactV2Input {
  const { digest: _digest, ...digestless } = artifact;
  return digestless;
}
