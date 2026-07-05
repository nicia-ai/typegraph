/**
 * Resolves which dataset directory a run reads from. Real datasets are
 * generated out-of-tree and cached; only the tiny smoke fixture is
 * committed (docs/design/benchmark-program-plan.md).
 */
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isSnbDatagenDirectory } from "./ldbc-csv";

export type SnbProfile = "smoke" | "sf1";

const SF1_CACHE_DIR = path.join(
  homedir(),
  ".cache",
  "typegraph",
  "fixtures",
  "ldbc-snb",
  "sf1",
);

const SF1_ARCHIVE = "social_network-sf1-CsvBasic-LongDateFormatter.tar.zst";
const SF1_DOWNLOAD_URL = `https://datasets.ldbcouncil.org/snb-interactive-v1/${SF1_ARCHIVE}`;

function smokeFixtureRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/real/dataset/ -> ../../../fixtures/ldbc-snb-smoke
  return path.join(here, "..", "..", "..", "fixtures", "ldbc-snb-smoke");
}

function sf1DownloadInstructions(): string {
  return (
    `SF1 dataset not found at ${SF1_CACHE_DIR}.\n` +
    "Download and extract the official LDBC SNB Interactive v1 datagen output " +
    "(CsvBasic serializer, LongDateFormatter epoch-millis dates, ~230 MB compressed):\n\n" +
    `  mkdir -p ${SF1_CACHE_DIR} && cd ${SF1_CACHE_DIR}\n` +
    `  curl -L -O ${SF1_DOWNLOAD_URL}\n` +
    `  zstd -d --stdout ${SF1_ARCHIVE} | tar -xf -\n\n` +
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

  if (!(await isSnbDatagenDirectory(SF1_CACHE_DIR))) {
    throw new Error(sf1DownloadInstructions());
  }
  return SF1_CACHE_DIR;
}
