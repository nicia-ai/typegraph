import { describe, expect, it } from "vitest";

import {
  findUncommittedProofPaths,
  parseProofCliOptions,
  ProofCliUsageError,
} from "../../src/regression/proof/cli";

const HARNESS_LANE_TIMEOUT_DEFAULT_MS = 900_000;

describe("parseProofCliOptions", () => {
  it("requires --seed", () => {
    expect(() => parseProofCliOptions([])).toThrowError(ProofCliUsageError);
  });

  it("defaults to both halves, the seed's own lane, sqlite, and a lane timeout above the harness default", () => {
    const options = parseProofCliOptions(["--seed=identity-frontier-396"]);
    expect(options.seedId).toBe("identity-frontier-396");
    expect(options.half).toBe("both");
    expect(options.laneIds).toBeUndefined();
    expect(options.backends).toEqual(["sqlite"]);
    expect(options.laneTimeoutMs).toBeGreaterThan(
      HARNESS_LANE_TIMEOUT_DEFAULT_MS,
    );
    expect(options.explainTimeoutMs).toBe(HARNESS_LANE_TIMEOUT_DEFAULT_MS);
    expect(options.keepWorktrees).toBe(false);
  });

  it("rejects an unknown --half value", () => {
    expect(() =>
      parseProofCliOptions(["--seed=identity-frontier-396", "--half=bogus"]),
    ).toThrowError(ProofCliUsageError);
  });

  it("parses --name=value and --name value identically", () => {
    const inlineForm = parseProofCliOptions([
      "--seed=identity-frontier-396",
      "--base=abc123",
    ]);
    const spaceForm = parseProofCliOptions([
      "--seed=identity-frontier-396",
      "--base",
      "abc123",
    ]);
    expect(inlineForm.baseRef).toBe("abc123");
    expect(spaceForm.baseRef).toBe("abc123");
  });

  it("splits --lanes into an explicit id list", () => {
    const options = parseProofCliOptions([
      "--seed=identity-frontier-396",
      "--lanes=identity-frontier,perf",
    ]);
    expect(options.laneIds).toEqual(["identity-frontier", "perf"]);
  });

  it("parses --backend into sqlite, postgres, or both", () => {
    expect(
      parseProofCliOptions([
        "--seed=identity-frontier-396",
        "--backend=postgres",
      ]).backends,
    ).toEqual(["postgres"]);
    expect(
      parseProofCliOptions(["--seed=identity-frontier-396", "--backend=both"])
        .backends,
    ).toEqual(["sqlite", "postgres"]);
  });

  it("rejects a non-positive --lane-timeout-ms or --explain-timeout-ms", () => {
    expect(() =>
      parseProofCliOptions([
        "--seed=identity-frontier-396",
        "--lane-timeout-ms=0",
      ]),
    ).toThrowError(ProofCliUsageError);
    expect(() =>
      parseProofCliOptions([
        "--seed=identity-frontier-396",
        "--explain-timeout-ms=-5",
      ]),
    ).toThrowError(ProofCliUsageError);
  });

  it("parses --keep-worktrees as a boolean flag", () => {
    expect(
      parseProofCliOptions(["--seed=identity-frontier-396", "--keep-worktrees"])
        .keepWorktrees,
    ).toBe(true);
  });
});

describe("findUncommittedProofPaths", () => {
  const WATCHED_PREFIXES = [
    "packages/benchmarks/src",
    "packages/benchmarks/etc/seeds",
    "packages/typegraph/src",
  ];

  it("reports a dirty watched path and ignores unwatched ones", () => {
    const porcelain = [
      " M packages/benchmarks/src/regression-proof.ts",
      " M README.md",
      "?? packages/typegraph/src/new-file.ts",
      " M apps/docs/src/content/index.mdx",
    ].join("\n");
    expect(findUncommittedProofPaths(porcelain, WATCHED_PREFIXES)).toEqual([
      "packages/benchmarks/src/regression-proof.ts",
      "packages/typegraph/src/new-file.ts",
    ]);
  });

  it("returns an empty list for a clean tree", () => {
    expect(findUncommittedProofPaths("", WATCHED_PREFIXES)).toEqual([]);
  });

  it("resolves a rename to its new path", () => {
    const porcelain =
      "R  packages/benchmarks/src/old-name.ts -> packages/benchmarks/src/new-name.ts";
    expect(findUncommittedProofPaths(porcelain, WATCHED_PREFIXES)).toEqual([
      "packages/benchmarks/src/new-name.ts",
    ]);
  });
});
