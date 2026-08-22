import { describe, expect, it } from "vitest";

import { resolveRepoRoot } from "../../src/git";
import {
  assertUniqueLaneIds,
  REGRESSION_LANES,
  resolveLanes,
  type RegressionLane,
} from "../../src/regression/lanes";
import { REAL_WORKLOAD_LANES } from "../../src/regression/lanes/real-workload";
import { laneScriptExists } from "../../src/regression/worktree";

describe("resolveLanes", () => {
  it("rejects an unknown lane id naming the valid ids", () => {
    expect(() => resolveLanes(["bogus"])).toThrowError(/bogus/);
    try {
      resolveLanes(["bogus"]);
      expect.fail("expected resolveLanes to throw");
    } catch (error) {
      for (const lane of REGRESSION_LANES) {
        expect((error as Error).message).toContain(lane.id);
      }
    }
  });

  it("defaults to perf, write, identity when no ids are given", () => {
    const lanes = resolveLanes(undefined);
    expect(lanes.map((lane) => lane.id)).toEqual(["perf", "write", "identity"]);
  });

  it("resolves a requested id to its registered lane definition", () => {
    const [lane] = resolveLanes(["vector"]);
    expect(lane?.id).toBe("vector");
  });
});

describe("assertUniqueLaneIds", () => {
  it("passes for the real registry", () => {
    expect(() => assertUniqueLaneIds(REGRESSION_LANES)).not.toThrow();
  });

  it("registry has no duplicate ids", () => {
    const duplicated: readonly RegressionLane[] = [
      ...REGRESSION_LANES,
      { ...REGRESSION_LANES[0]! },
    ];
    expect(() => assertUniqueLaneIds(duplicated)).toThrowError(
      /Duplicate regression lane id/,
    );
  });
});

describe("REGRESSION_LANES", () => {
  it("real-workload lanes compose into the registry", () => {
    for (const lane of REAL_WORKLOAD_LANES) {
      expect(REGRESSION_LANES).toContainEqual(lane);
    }
  });

  it("registers identity-frontier with both backend scripts", () => {
    const lane = REGRESSION_LANES.find(
      (candidate) => candidate.id === "identity-frontier",
    );
    expect(lane).toBeDefined();
    expect(lane?.scripts.sqlite).toBe("bench:identity-frontier");
    expect(lane?.scripts.postgres).toBe("bench:identity-frontier:postgres");
  });

  /**
   * `runLane` reports a script absent from a baseline worktree as
   * `unavailable` -> `unrunnable` -> `reportExitCode` 2 (see `run-lane.ts`
   * I8, `compare.ts` I8/I9). The last PUBLISHED tag baseline is checked out
   * from a real historical tag, which cannot contain a lane this batch just
   * registered — defaulting to it here would fail every future
   * `bench:regression` run against that baseline until a release ships it.
   */
  it("keeps identity-frontier out of the default lane set until it exists in the published tag", () => {
    const defaultLaneIds = resolveLanes(undefined).map((lane) => lane.id);
    expect(defaultLaneIds).toEqual(["perf", "write", "identity"]);
    expect(defaultLaneIds).not.toContain("identity-frontier");
  });

  it("every registered lane's per-backend script exists in this package's package.json", () => {
    const repoRoot = resolveRepoRoot();
    for (const lane of REGRESSION_LANES) {
      for (const script of Object.values(lane.scripts)) {
        if (script === undefined) {
          continue;
        }
        expect(laneScriptExists(repoRoot, script)).toBe(true);
      }
    }
  });
});
