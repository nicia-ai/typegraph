/**
 * Records per-file test durations for the duration-balanced shard split
 * (`vitest.shard-sequencer.ts`) from a vitest JSON report of a full lane run:
 *
 *   pnpm exec vitest run --reporter=json --outputFile=report.json
 *   node --import tsx scripts/update-shard-weights.ts sqlite report.json
 *
 *   pnpm test:postgres --reporter=json --outputFile=report.json
 *   node --import tsx scripts/update-shard-weights.ts postgres report.json
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
  "Usage: update-shard-weights.ts <sqlite|postgres> <vitest-json-report>";

function isLane(value: string | undefined): value is ShardWeightLane {
  return value === "sqlite" || value === "postgres";
}

function weightsFromReport(report: JsonReport): ShardWeights {
  const entries = report.testResults.map(
    (file) =>
      [
        path.relative(PACKAGE_ROOT, file.name).split(path.sep).join("/"),
        Math.max(0, Math.round(file.endTime - file.startTime)),
      ] as const,
  );
  return Object.fromEntries(
    entries.toSorted(([left], [right]) => (left < right ? -1 : 1)),
  );
}

function main(): void {
  const [lane, reportPath] = process.argv.slice(2);
  if (!isLane(lane) || reportPath === undefined) {
    throw new Error(USAGE);
  }

  const report = JSON.parse(readFileSync(reportPath, "utf8")) as JsonReport;
  const recorded = JSON.parse(
    readFileSync(SHARD_WEIGHTS_FILE, "utf8"),
  ) as Record<ShardWeightLane, ShardWeights>;
  const weights = weightsFromReport(report);
  writeFileSync(
    SHARD_WEIGHTS_FILE,
    `${JSON.stringify({ ...recorded, [lane]: weights }, undefined, 2)}\n`,
  );
  console.log(
    `Recorded ${Object.keys(weights).length} ${lane} file durations in ${path.relative(PACKAGE_ROOT, SHARD_WEIGHTS_FILE)}.`,
  );
}

main();
