/**
 * Records per-file test durations for the duration-balanced shard split
 * (`vitest.shard-sequencer.ts`) from the vitest JSON reports of one full lane
 * run — one report per shard job, which CI uploads as `shard-durations-*`
 * artifacts:
 *
 *   gh run download <run-id> --pattern 'shard-durations-sqlite-*' --dir durations/sqlite
 *   node --import tsx scripts/update-shard-weights.ts sqlite durations/sqlite/*\/*.json
 *
 * The lane's recorded weights are replaced, not merged, so a deleted test
 * file drops out. Stale weights cost balance, never coverage: the split
 * assigns every file to exactly one shard whatever its weight.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SHARD_WEIGHTS_FILE,
  type ShardWeightLane,
  type ShardWeights,
} from "../vitest.shard-sequencer";

type JsonReport = Readonly<{
  testResults: readonly Readonly<{
    name: string;
    startTime: number;
    endTime: number;
  }>[];
}>;

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const USAGE =
  "Usage: update-shard-weights.ts <sqlite|postgres> <vitest-json-report>...";

/**
 * The package directory as it appears inside any checkout's absolute path. A
 * report names files by the absolute path of the machine that ran them, so a
 * CI report cannot be resolved against this checkout's root.
 */
const PACKAGE_PATH_MARKER = `/${path.basename(path.dirname(PACKAGE_ROOT))}/${path.basename(PACKAGE_ROOT)}/`;

function packageRelativePath(reportedPath: string): string {
  const normalized = reportedPath.split(path.sep).join("/");
  const markerStart = normalized.lastIndexOf(PACKAGE_PATH_MARKER);
  if (markerStart === -1) {
    throw new Error(
      `Report path ${reportedPath} is not under ${PACKAGE_PATH_MARKER}.`,
    );
  }
  return normalized.slice(markerStart + PACKAGE_PATH_MARKER.length);
}

function isLane(value: string | undefined): value is ShardWeightLane {
  return value === "sqlite" || value === "postgres";
}

function weightsFromReports(reports: readonly JsonReport[]): ShardWeights {
  const entries = reports
    .flatMap((report) => report.testResults)
    .map(
      (file) =>
        [
          packageRelativePath(file.name),
          Math.max(0, Math.round(file.endTime - file.startTime)),
        ] as const,
    );
  return Object.fromEntries(
    entries.toSorted(([left], [right]) => (left < right ? -1 : 1)),
  );
}

function main(): void {
  const [lane, ...reportPaths] = process.argv.slice(2);
  if (!isLane(lane) || reportPaths.length === 0) {
    throw new Error(USAGE);
  }

  const reports = reportPaths.map(
    (reportPath) => JSON.parse(readFileSync(reportPath, "utf8")) as JsonReport,
  );
  const recorded = JSON.parse(
    readFileSync(SHARD_WEIGHTS_FILE, "utf8"),
  ) as Record<ShardWeightLane, ShardWeights>;
  const weights = weightsFromReports(reports);
  writeFileSync(
    SHARD_WEIGHTS_FILE,
    `${JSON.stringify({ ...recorded, [lane]: weights }, undefined, 2)}\n`,
  );
  console.log(
    `Recorded ${Object.keys(weights).length} ${lane} file durations in ${path.relative(PACKAGE_ROOT, SHARD_WEIGHTS_FILE)}.`,
  );
}

main();
