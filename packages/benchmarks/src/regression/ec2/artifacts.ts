/**
 * Decodes the gzip+base64 artifacts `collect` fetches over SSM
 * (`renderFetchCompressedScript`, `remote-scripts.ts`). Compression exists
 * specifically to dodge SSM's `StandardOutputContent` cap on a report that
 * would otherwise be truncated mid-JSON (the exact failure mode
 * `run-sf1-ec2.ts`'s `renderBenchmarkRunScript` doc comment documents for
 * the SNB runner) — but a *compressed* payload that gets cut off decodes to
 * garbage or fails gzip's CRC outright, so a truncated fetch here is a hard
 * error, never a silently short report.
 */
import { gunzipSync } from "node:zlib";

/**
 * AWS's hard cap on `StandardOutputContent` for one SSM command invocation.
 * A base64 payload at or past this length has certainly been truncated —
 * `decodeCompressedArtifact` refuses it before even attempting to decode.
 */
export const SSM_STDOUT_CHARACTER_LIMIT = 24_000;

export class CompressedArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompressedArtifactError";
  }
}

/**
 * Decodes a gzip+base64 artifact fetched over SSM. Throws
 * `CompressedArtifactError` naming the 24,000-character
 * `StandardOutputContent` cap when the payload is at or past that length,
 * and naming the decode failure otherwise (a truncated-but-under-the-cap
 * payload still fails gzip's CRC check, which `gunzipSync` surfaces as a
 * thrown error, not a corrupted-but-successful result).
 */
export function decodeCompressedArtifact(stdout: string): string {
  const trimmed = stdout.trim();
  if (trimmed.length >= SSM_STDOUT_CHARACTER_LIMIT) {
    throw new CompressedArtifactError(
      `Compressed artifact stdout is ${trimmed.length} characters, at or ` +
        `past SSM's ${SSM_STDOUT_CHARACTER_LIMIT}-character ` +
        "StandardOutputContent cap — it was almost certainly truncated.",
    );
  }
  try {
    return gunzipSync(Buffer.from(trimmed, "base64")).toString("utf-8");
  } catch (error) {
    throw new CompressedArtifactError(
      `Failed to decode compressed artifact (likely truncated or corrupt ` +
        `stdout): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
