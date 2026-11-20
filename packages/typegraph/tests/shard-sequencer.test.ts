/**
 * Guards the duration-balanced shard split.
 *
 * CI runs each lane as several `--shard=<index>/<count>` jobs, and the split
 * decides which job runs which file. A split that dropped a file would remove
 * its tests from CI while every job still reports green, so the property that
 * matters is coverage: the shards of a lane add up to the whole file list,
 * each file exactly once. Balance is the reason the split exists and is
 * checked second.
 */
import { globSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  readShardWeights,
  selectShardPaths,
  type ShardWeightLane,
  type ShardWeights,
} from "../vitest.shard-sequencer";
import { assignBalancedBins } from "./balanced-partition";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const TEST_FILE_GLOB = "tests/**/*.test.ts";
const LANES: readonly ShardWeightLane[] = ["sqlite", "postgres"];
/** The shard counts `.github/workflows/ci.yml` uses, plus the unsharded run. */
const SHARD_COUNTS = [1, 3, 4, 5];
/**
 * How far the heaviest shard may sit above the mean. Greedy packing stays
 * within one item of the mean, so a lane only exceeds this when a single file
 * outweighs a whole shard — which is a file to split, not a split to loosen.
 */
const MAX_LOAD_OVER_MEAN = 1.15;

function allTestFiles(): readonly string[] {
  return globSync(TEST_FILE_GLOB, { cwd: PACKAGE_ROOT }).map((filePath) =>
    filePath.split(path.sep).join("/"),
  );
}

function shardsOf(
  paths: readonly string[],
  weights: ShardWeights,
  count: number,
): readonly (readonly string[])[] {
  return Array.from({ length: count }, (_unused, position) =>
    selectShardPaths(paths, weights, { index: position + 1, count }),
  );
}

describe("assignBalancedBins", () => {
  it("places every item in exactly one bin within range", () => {
    const bins = assignBalancedBins([5, 1, 9, 3, 3, 7, 2], 3);
    expect(bins).toHaveLength(7);
    for (const bin of bins) {
      expect(bin).toBeGreaterThanOrEqual(0);
      expect(bin).toBeLessThan(3);
    }
  });

  it("separates the heaviest items before filling behind them", () => {
    expect(assignBalancedBins([10, 9, 1, 1], 2)).toEqual([0, 1, 1, 0]);
  });

  it("refuses a bin count that is not a positive integer", () => {
    expect(() => assignBalancedBins([1], 0)).toThrow(RangeError);
    expect(() => assignBalancedBins([1], 1.5)).toThrow(RangeError);
  });
});

describe("duration-balanced shard split", () => {
  const paths = allTestFiles();

  it("finds the package's test files", () => {
    expect(paths.length).toBeGreaterThan(0);
  });

  describe.each(LANES)("%s lane", (lane) => {
    const weights = readShardWeights(lane);

    it.each(SHARD_COUNTS)(
      "runs every test file exactly once across %i shards",
      (count) => {
        const assigned = shardsOf(paths, weights, count).flat();
        expect(assigned.toSorted()).toEqual(paths.toSorted());
      },
    );

    it("does not depend on the order files are discovered in", () => {
      const count = 4;
      expect(shardsOf(paths.toReversed(), weights, count)).toEqual(
        shardsOf(paths, weights, count),
      );
    });

    it("places a file with no recorded duration like any other", () => {
      const unrecorded = "tests/not-yet-measured.test.ts";
      const count = 4;
      const assigned = shardsOf([...paths, unrecorded], weights, count).flat();
      expect(assigned.filter((filePath) => filePath === unrecorded)).toEqual([
        unrecorded,
      ]);
      expect(assigned).toHaveLength(paths.length + 1);
    });

    it.each(SHARD_COUNTS.filter((count) => count > 1))(
      "keeps the heaviest of %i shards near the mean recorded load",
      (count) => {
        const recorded = paths.filter(
          (filePath) => weights[filePath] !== undefined,
        );
        const loads = shardsOf(recorded, weights, count).map((shard) =>
          shard.reduce(
            (total, filePath) => total + (weights[filePath] ?? 0),
            0,
          ),
        );
        const mean =
          loads.reduce((total, load) => total + load, 0) / loads.length;
        console.log(
          `${lane} x${count}: shard loads (s) ${loads.map((load) => Math.round(load / 1000)).join(", ")}; mean ${Math.round(mean / 1000)}`,
        );
        expect(Math.max(...loads)).toBeLessThanOrEqual(
          mean * MAX_LOAD_OVER_MEAN,
        );
      },
    );
  });
});
