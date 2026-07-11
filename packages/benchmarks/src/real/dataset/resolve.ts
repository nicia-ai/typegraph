/**
 * Resolves which dataset directory a run reads from. Real datasets are
 * generated out-of-tree and cached; only the tiny smoke fixture is
 * committed (docs/design/benchmark-program-plan.md).
 */
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isSnbDatagenDirectory } from "./ldbc-csv";

export type SnbProfile = "smoke" | "sf1" | "sf10";

/** The real (downloaded, scale-factor) profiles — everything but `smoke`. */
export type SnbRealProfile = Exclude<SnbProfile, "smoke">;

export type SnbDatasetSpec = Readonly<{
  archive: string;
  /**
   * Exported (with the lookup helpers below) so the EC2 bootstrap script
   * (src/real/ec2/) fetches the identical archive to the identical
   * *relative* path instead of re-deriving these from scratch. Segments are
   * separate from the joined cache dir because the bootstrap script runs as
   * root on a *different* machine — `homedir()` there must resolve to
   * "/root", not whatever this (local) process's home directory happens to
   * be.
   */
  cacheRelativeSegments: readonly string[];
  /** Human-readable approximate compressed download size, for error messages. */
  approxCompressedSize: string;
}>;

export const SNB_DATASET_SPECS: Readonly<
  Record<SnbRealProfile, SnbDatasetSpec>
> = {
  sf1: {
    archive: "social_network-sf1-CsvBasic-LongDateFormatter.tar.zst",
    cacheRelativeSegments: [
      ".cache",
      "typegraph",
      "fixtures",
      "ldbc-snb",
      "sf1",
    ],
    approxCompressedSize: "~230 MB",
  },
  sf10: {
    archive: "social_network-sf10-CsvBasic-LongDateFormatter.tar.zst",
    cacheRelativeSegments: [
      ".cache",
      "typegraph",
      "fixtures",
      "ldbc-snb",
      "sf10",
    ],
    approxCompressedSize: "~2.5 GB",
  },
};

export function snbDownloadUrl(profile: SnbRealProfile): string {
  return `https://datasets.ldbcouncil.org/snb-interactive-v1/${SNB_DATASET_SPECS[profile].archive}`;
}

function snbCacheDir(profile: SnbRealProfile): string {
  return path.join(
    homedir(),
    ...SNB_DATASET_SPECS[profile].cacheRelativeSegments,
  );
}

function smokeFixtureRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/real/dataset/ -> ../../../fixtures/ldbc-snb-smoke
  return path.join(here, "..", "..", "..", "fixtures", "ldbc-snb-smoke");
}

function datasetDownloadInstructions(profile: SnbRealProfile): string {
  const cacheDir = snbCacheDir(profile);
  const spec = SNB_DATASET_SPECS[profile];
  return (
    `${profile.toUpperCase()} dataset not found at ${cacheDir}.\n` +
    "Download and extract the official LDBC SNB Interactive v1 datagen output " +
    `(CsvBasic serializer, LongDateFormatter epoch-millis dates, ${spec.approxCompressedSize} compressed):\n\n` +
    `  mkdir -p ${cacheDir} && cd ${cacheDir}\n` +
    `  curl -L -O ${snbDownloadUrl(profile)}\n` +
    // The archive extracts into its own social_network-...-LongDateFormatter/
    // subdirectory, not flat — --strip-components=1 lands dynamic/, static/,
    // etc. directly here, matching what isSnbDatagenDirectory expects.
    `  zstd -d --stdout ${spec.archive} | tar -xf - --strip-components=1\n\n` +
    "Or pass --data-dir <extracted-dir> to point at an existing extract."
  );
}

export async function resolveDatasetRoot(
  profile: SnbProfile,
  override?: string,
): Promise<string> {
  if (override !== undefined) {
    if (!(await isSnbDatagenDirectory(override))) {
      throw new Error(
        `--data-dir ${override} does not look like extracted LDBC datagen output ` +
          "(missing dynamic/person_0_0.csv).",
      );
    }
    return override;
  }

  if (profile === "smoke") {
    return smokeFixtureRoot();
  }

  const cacheDir = snbCacheDir(profile);
  if (!(await isSnbDatagenDirectory(cacheDir))) {
    throw new Error(datasetDownloadInstructions(profile));
  }
  return cacheDir;
}
