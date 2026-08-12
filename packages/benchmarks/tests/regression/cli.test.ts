import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  parseRegressionCliOptions,
  RegressionCliUsageError,
} from "../../src/regression/cli";
import { resolveLanes } from "../../src/regression/lanes";

describe("parseRegressionCliOptions", () => {
  let originalPostgresUrl: string | undefined;

  beforeEach(() => {
    originalPostgresUrl = process.env["POSTGRES_URL"];
    delete process.env["POSTGRES_URL"];
  });

  afterEach(() => {
    if (originalPostgresUrl === undefined) {
      delete process.env["POSTGRES_URL"];
    } else {
      process.env["POSTGRES_URL"] = originalPostgresUrl;
    }
  });

  it("parses --name=value and --name value identically", () => {
    const inlineForm = parseRegressionCliOptions(["--base=abc123"]);
    const spaceForm = parseRegressionCliOptions(["--base", "abc123"]);
    expect(inlineForm.baseRef).toBe("abc123");
    expect(spaceForm.baseRef).toBe("abc123");
  });

  it("refuses --candidate together with --candidate-worktree", () => {
    expect(() =>
      parseRegressionCliOptions([
        "--candidate=abc123",
        "--candidate-worktree=/tmp/foo",
      ]),
    ).toThrowError(RegressionCliUsageError);
  });

  it("refuses --backend=postgres with no POSTGRES_URL instead of downgrading", () => {
    expect(() =>
      parseRegressionCliOptions(["--backend=postgres"]),
    ).toThrowError(RegressionCliUsageError);
  });

  it("refuses --backend=both with no POSTGRES_URL instead of downgrading", () => {
    expect(() => parseRegressionCliOptions(["--backend=both"])).toThrowError(
      RegressionCliUsageError,
    );
  });

  it("accepts --backend=postgres when POSTGRES_URL is set", () => {
    process.env["POSTGRES_URL"] = "postgresql://example/db";
    const options = parseRegressionCliOptions(["--backend=postgres"]);
    expect(options.backends).toEqual(["postgres"]);
  });

  it("defaults lanes to perf,write,identity", () => {
    const options = parseRegressionCliOptions([]);
    expect(options.laneIds).toBeUndefined();
    const lanes = resolveLanes(options.laneIds);
    expect(lanes.map((lane) => lane.id)).toEqual(["perf", "write", "identity"]);
  });

  it("splits --lanes into an explicit id list", () => {
    const options = parseRegressionCliOptions(["--lanes=perf,vector"]);
    expect(options.laneIds).toEqual(["perf", "vector"]);
  });

  it("rejects a non-positive --lane-timeout-ms", () => {
    expect(() =>
      parseRegressionCliOptions(["--lane-timeout-ms=0"]),
    ).toThrowError(RegressionCliUsageError);
    expect(() =>
      parseRegressionCliOptions(["--lane-timeout-ms=-100"]),
    ).toThrowError(RegressionCliUsageError);
  });

  it("defaults backends to sqlite-only", () => {
    const options = parseRegressionCliOptions([]);
    expect(options.backends).toEqual(["sqlite"]);
  });
});
