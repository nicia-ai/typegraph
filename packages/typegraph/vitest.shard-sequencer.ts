import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BaseSequencer, type TestSpecification } from "vitest/node";

import { assignBalancedBins } from "./tests/balanced-partition";

/**
 * Which recorded durations apply. A file's cost depends on the lane: a suite
 * with a server-PostgreSQL leg skips it in the default lane and runs it in
 * the PostgreSQL one.
 */
export type ShardWeightLane = "sqlite" | "postgres";

/** Recorded milliseconds per test file path, relative to the package root. */
export type ShardWeights = Readonly<Record<string, number>>;

export type ShardSelection = Readonly<{
  /** One-based, as `--shard=<index>/<count>` states it. */
  index: number;
  count: number;
}>;

const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));

export const SHARD_WEIGHTS_FILE = path.join(
  PACKAGE_ROOT,
  "vitest.shard-weights.json",
);

/**
 * Worker startup and module import, which a file's recorded test time leaves
 * out. Without it a shard of several hundred near-instant files weighs
 * nothing and absorbs all of them.
 */
const FILE_OVERHEAD_MS = 1500;

function currentLane(): ShardWeightLane {
  return process.env["POSTGRES_URL"] === undefined ? "sqlite" : "postgres";
}

export function readShardWeights(lane: ShardWeightLane): ShardWeights {
  const recorded = JSON.parse(
    readFileSync(SHARD_WEIGHTS_FILE, "utf8"),
  ) as Readonly<Record<ShardWeightLane, ShardWeights>>;
  return recorded[lane];
}

function meanWeight(weights: ShardWeights): number {
  const values = Object.values(weights);
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * The test files shard `shard.index` of `shard.count` runs.
 *
 * Vitest's own split hashes file paths, which spreads file counts evenly and
 * durations not at all. This one balances recorded duration instead. The
 * assignment depends only on the set of paths, the recorded weights and the
 * shard count, so shard jobs that each see the same checkout agree on it and
 * together run every file exactly once. A file with no recorded duration is
 * placed at the mean, so a new test file needs no bookkeeping to be run.
 */
export function selectShardPaths(
  paths: readonly string[],
  weights: ShardWeights,
  shard: ShardSelection,
): readonly string[] {
  const unrecordedWeight = meanWeight(weights);
  const ordered = paths.toSorted();
  const bins = assignBalancedBins(
    ordered.map(
      (filePath) => (weights[filePath] ?? unrecordedWeight) + FILE_OVERHEAD_MS,
    ),
    shard.count,
  );
  return ordered.filter(
    (_path, position) => bins[position] === shard.index - 1,
  );
}

export class DurationBalancedSequencer extends BaseSequencer {
  override shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { shard, root } = this.ctx.config;
    if (shard === undefined) return Promise.resolve(files);

    const pathOf = (spec: TestSpecification): string =>
      path.relative(root, spec.moduleId).split(path.sep).join("/");
    const selected = new Set(
      selectShardPaths(
        files.map((spec) => pathOf(spec)),
        readShardWeights(currentLane()),
        shard,
      ),
    );
    return Promise.resolve(files.filter((spec) => selected.has(pathOf(spec))));
  }
}
