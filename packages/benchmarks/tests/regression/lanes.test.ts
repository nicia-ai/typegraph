import { describe, expect, it } from "vitest";

import {
  assertUniqueLaneIds,
  REGRESSION_LANES,
  resolveLanes,
  type RegressionLane,
} from "../../src/regression/lanes";
import { REAL_WORKLOAD_LANES } from "../../src/regression/lanes/real-workload";

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
});
