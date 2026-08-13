import { describe, expect, it } from "vitest";

import {
  reportExitCode,
  type LaneComparison,
  type MeasurementComparison,
  type RegressionReport,
} from "../../src/regression/compare";
import { DEFAULT_REGRESSION_POLICY } from "../../src/regression/policy";
import {
  combineProofVerdict,
  judgeExplainProof,
  judgeTimingProof,
  parseVitestJsonReport,
  proofExitCode,
  type ProofHalfVerdict,
  type VitestAssertionResult,
  type VitestJsonReport,
} from "../../src/regression/proof/verdict";
import {
  type SeedExplainExpectation,
  type SeedTimingExpectation,
} from "../../src/regression/proof/seeds";

const TIMING_EXPECTATION: SeedTimingExpectation = {
  laneId: "identity-frontier",
  label: "identity-frontier:current-hop",
  baseline: "base",
  classification: "failed",
};

function measurementComparison(
  overrides: Partial<MeasurementComparison> = {},
): MeasurementComparison {
  return {
    laneId: TIMING_EXPECTATION.laneId,
    label: TIMING_EXPECTATION.label,
    baseline: TIMING_EXPECTATION.baseline,
    baselineMs: 0.008,
    candidateMs: 564,
    ratio: 70_500,
    deltaMs: 563.992,
    classification: "failed",
    ...overrides,
  };
}

function comparedLane(
  comparisons: readonly MeasurementComparison[],
): LaneComparison {
  return {
    kind: "compared",
    laneId: TIMING_EXPECTATION.laneId,
    baseline: TIMING_EXPECTATION.baseline,
    comparisons,
  };
}

function buildReport(
  overrides: Partial<RegressionReport> = {},
): RegressionReport {
  return {
    generatedAt: new Date().toISOString(),
    candidate: { ref: "HEAD", sha: "cand-sha", path: "/tmp/candidate" },
    baselines: [{ id: "base", ref: "main", sha: "base-sha" }],
    backends: ["sqlite"],
    policy: DEFAULT_REGRESSION_POLICY,
    lanes: [comparedLane([measurementComparison()])],
    staleAcceptances: [],
    hardFailures: [],
    flags: [],
    ...overrides,
  };
}

describe("judgeTimingProof", () => {
  it("proves the timing half on a matched failed comparison", () => {
    const verdict = judgeTimingProof({
      report: buildReport(),
      expectation: TIMING_EXPECTATION,
    });
    expect(verdict.kind).toBe("proven");
  });

  it("refuses a timing proof whose lane produced no comparison (unrunnable lane, report exit code 2)", () => {
    const report = buildReport({
      lanes: [
        {
          kind: "unrunnable",
          laneId: TIMING_EXPECTATION.laneId,
          baseline: TIMING_EXPECTATION.baseline,
          reason: 'Script "bench:identity-frontier" is absent.',
        },
      ],
    });
    // The point of this test (PROOF-EXIT-ONLY): a report exit code of 2 is
    // real here, but is never itself proof — judgeTimingProof must still be
    // inconclusive.
    expect(reportExitCode(report)).toBe(2);
    const verdict = judgeTimingProof({
      report,
      expectation: TIMING_EXPECTATION,
    });
    expect(verdict.kind).toBe("inconclusive");
  });

  it("is inconclusive when no lane comparison matches the expected baseline", () => {
    const report = buildReport({
      lanes: [
        {
          ...comparedLane([measurementComparison()]),
          baseline: "tag",
        },
      ],
    });
    const verdict = judgeTimingProof({
      report,
      expectation: TIMING_EXPECTATION,
    });
    expect(verdict.kind).toBe("inconclusive");
  });

  it("refuses a hard failure on a different label", () => {
    const report = buildReport({
      lanes: [
        comparedLane([measurementComparison({ label: "some-other-label" })]),
      ],
    });
    const verdict = judgeTimingProof({
      report,
      expectation: TIMING_EXPECTATION,
    });
    expect(verdict.kind).toBe("inconclusive");
  });

  it("refuses a flagged comparison where the seed declares failed", () => {
    const report = buildReport({
      lanes: [
        comparedLane([
          measurementComparison({ classification: "flagged", ratio: 1.3 }),
        ]),
      ],
    });
    const verdict = judgeTimingProof({
      report,
      expectation: TIMING_EXPECTATION,
    });
    expect(verdict.kind).toBe("inconclusive");
  });

  it("refuses a report whose policy was softened", () => {
    const softenedThreshold = judgeTimingProof({
      report: buildReport({
        policy: { ...DEFAULT_REGRESSION_POLICY, failRatio: 100 },
      }),
      expectation: TIMING_EXPECTATION,
    });
    expect(softenedThreshold.kind).toBe("inconclusive");
    if (softenedThreshold.kind === "inconclusive") {
      expect(softenedThreshold.reason).toContain("modified policy");
    }

    const withAcceptance = judgeTimingProof({
      report: buildReport({
        policy: {
          ...DEFAULT_REGRESSION_POLICY,
          accepted: [
            {
              laneId: TIMING_EXPECTATION.laneId,
              label: TIMING_EXPECTATION.label,
              baseline: "all",
              maxRatio: 1_000_000,
              reason: "test acceptance",
            },
          ],
        },
      }),
      expectation: TIMING_EXPECTATION,
    });
    expect(withAcceptance.kind).toBe("inconclusive");
  });
});

const EXPLAIN_EXPECTATION: SeedExplainExpectation = {
  testFile: "tests/perf/explain/identity-frontier-expansion.test.ts",
  mustFail: [
    {
      titleFragments: [
        "sqlite",
        "seeks the identity closure from the frontier",
      ],
      diagnostic: "required term SEARCH identity_seed_class",
    },
    {
      titleFragments: [
        "postgres",
        "visits at most FRONTIER_ROW_CEILING rows expanding the frontier",
      ],
      diagnostic: "visited rows exceeds ceiling 100",
    },
  ],
  mustPass: [
    ["sqlite", "reaches the target through an identity peer"],
    ["postgres", "reaches the target through an identity peer"],
  ],
};

function fullNameFrom(fragments: readonly string[]): string {
  return `identity frontier expansion (#396 shape) ${fragments.join(" ")}`;
}

function assertionResult(
  fragments: readonly string[],
  status: string,
  failureMessages?: readonly string[],
): VitestAssertionResult {
  return {
    fullName: fullNameFrom(fragments),
    status,
    ...(failureMessages === undefined ? {} : { failureMessages }),
  };
}

function vitestReport(
  assertionResults: readonly VitestAssertionResult[],
): VitestJsonReport {
  return {
    testResults: [
      {
        name: "tests/perf/explain/identity-frontier-expansion.test.ts",
        assertionResults,
      },
    ],
  };
}

const GOOD_EXPLAIN_REPORT: VitestJsonReport = vitestReport([
  assertionResult(
    ["sqlite", "reaches the target through an identity peer"],
    "passed",
  ),
  assertionResult(
    ["sqlite", "seeks the identity closure from the frontier"],
    "failed",
    [
      "Error: assertPlanShape: required term SEARCH identity_seed_class " +
        "USING INDEX sqlite_autoindex_typegraph_identity_closure_1 not found",
    ],
  ),
  assertionResult(
    ["postgres", "reaches the target through an identity peer"],
    "passed",
  ),
  assertionResult(
    [
      "postgres",
      "visits at most FRONTIER_ROW_CEILING rows expanding the frontier",
    ],
    "failed",
    ["Error: assertRowCeiling: 60050.98 visited rows exceeds ceiling 100"],
  ),
]);

describe("judgeExplainProof", () => {
  it("proves the explain half only when each declared test fails with its declared diagnostic", () => {
    const proven = judgeExplainProof({
      report: GOOD_EXPLAIN_REPORT,
      expectation: EXPLAIN_EXPECTATION,
    });
    expect(proven.kind).toBe("proven");

    const unrelatedFailure = judgeExplainProof({
      report: vitestReport([
        assertionResult(
          ["sqlite", "reaches the target through an identity peer"],
          "passed",
        ),
        assertionResult(
          ["sqlite", "seeks the identity closure from the frontier"],
          "failed",
          ["Error: Cannot find module '../../src/does-not-exist'"],
        ),
        assertionResult(
          ["postgres", "reaches the target through an identity peer"],
          "passed",
        ),
        assertionResult(
          [
            "postgres",
            "visits at most FRONTIER_ROW_CEILING rows expanding the frontier",
          ],
          "failed",
          [
            "Error: assertRowCeiling: 60050.98 visited rows exceeds ceiling 100",
          ],
        ),
      ]),
      expectation: EXPLAIN_EXPECTATION,
    });
    expect(unrelatedFailure.kind).toBe("inconclusive");
    if (unrelatedFailure.kind === "inconclusive") {
      expect(unrelatedFailure.reason).toContain("unrelated failure");
    }
  });

  it("reports the seed as passing undetected when a must-fail test passed", () => {
    const verdict = judgeExplainProof({
      report: vitestReport([
        assertionResult(
          ["sqlite", "reaches the target through an identity peer"],
          "passed",
        ),
        assertionResult(
          ["sqlite", "seeks the identity closure from the frontier"],
          "passed",
        ),
        assertionResult(
          ["postgres", "reaches the target through an identity peer"],
          "passed",
        ),
        assertionResult(
          [
            "postgres",
            "visits at most FRONTIER_ROW_CEILING rows expanding the frontier",
          ],
          "failed",
          [
            "Error: assertRowCeiling: 60050.98 visited rows exceeds ceiling 100",
          ],
        ),
      ]),
      expectation: EXPLAIN_EXPECTATION,
    });
    expect(verdict.kind).toBe("inconclusive");
    if (verdict.kind === "inconclusive") {
      expect(verdict.reason).toContain("passed undetected");
    }
  });

  it("refuses when a declared title is missing or matches twice", () => {
    const missing = judgeExplainProof({
      report: vitestReport([
        assertionResult(
          ["sqlite", "reaches the target through an identity peer"],
          "passed",
        ),
        assertionResult(
          ["postgres", "reaches the target through an identity peer"],
          "passed",
        ),
        assertionResult(
          [
            "postgres",
            "visits at most FRONTIER_ROW_CEILING rows expanding the frontier",
          ],
          "failed",
          [
            "Error: assertRowCeiling: 60050.98 visited rows exceeds ceiling 100",
          ],
        ),
      ]),
      expectation: EXPLAIN_EXPECTATION,
    });
    expect(missing.kind).toBe("inconclusive");

    const duplicated = judgeExplainProof({
      report: vitestReport([
        ...GOOD_EXPLAIN_REPORT.testResults[0]!.assertionResults,
        assertionResult(
          ["sqlite", "seeks the identity closure from the frontier"],
          "failed",
          ["Error: assertPlanShape: required term SEARCH identity_seed_class"],
        ),
      ]),
      expectation: EXPLAIN_EXPECTATION,
    });
    expect(duplicated.kind).toBe("inconclusive");
  });

  it("refuses when a must-pass case did not pass (invalid seed)", () => {
    const verdict = judgeExplainProof({
      report: vitestReport([
        assertionResult(
          ["sqlite", "reaches the target through an identity peer"],
          "failed",
          ['Error: expected ["target"], got []'],
        ),
        assertionResult(
          ["sqlite", "seeks the identity closure from the frontier"],
          "failed",
          [
            "Error: assertPlanShape: required term SEARCH identity_seed_class " +
              "not found",
          ],
        ),
        assertionResult(
          ["postgres", "reaches the target through an identity peer"],
          "passed",
        ),
        assertionResult(
          [
            "postgres",
            "visits at most FRONTIER_ROW_CEILING rows expanding the frontier",
          ],
          "failed",
          [
            "Error: assertRowCeiling: 60050.98 visited rows exceeds ceiling 100",
          ],
        ),
      ]),
      expectation: EXPLAIN_EXPECTATION,
    });
    expect(verdict.kind).toBe("invalid-seed");
  });
});

describe("parseVitestJsonReport", () => {
  it("parses a well-formed report", () => {
    const raw = JSON.stringify(GOOD_EXPLAIN_REPORT);
    expect(parseVitestJsonReport(raw)).toEqual(GOOD_EXPLAIN_REPORT);
  });

  it("throws on an unrecognized shape", () => {
    expect(() =>
      parseVitestJsonReport(JSON.stringify({ foo: "bar" })),
    ).toThrow();
    expect(() =>
      parseVitestJsonReport(JSON.stringify({ testResults: [{ name: "x" }] })),
    ).toThrow();
    expect(() =>
      parseVitestJsonReport(
        JSON.stringify({
          testResults: [
            { name: "x", assertionResults: [{ status: "passed" }] },
          ],
        }),
      ),
    ).toThrow();
  });
});

describe("combineProofVerdict / proofExitCode", () => {
  const proven: ProofHalfVerdict = { kind: "proven", evidence: "measured" };
  const inconclusive: ProofHalfVerdict = {
    kind: "inconclusive",
    reason: "n/a",
  };

  it("is proven only when both halves are proven", () => {
    expect(
      combineProofVerdict({ seedId: "s", timing: proven, explain: proven })
        .proven,
    ).toBe(true);
    expect(
      combineProofVerdict({
        seedId: "s",
        timing: proven,
        explain: inconclusive,
      }).proven,
    ).toBe(false);
    expect(
      combineProofVerdict({
        seedId: "s",
        timing: inconclusive,
        explain: proven,
      }).proven,
    ).toBe(false);
    expect(
      combineProofVerdict({ seedId: "s", timing: "skipped", explain: proven })
        .proven,
    ).toBe(false);
    expect(
      combineProofVerdict({ seedId: "s", timing: proven, explain: "skipped" })
        .proven,
    ).toBe(false);
  });

  it("maps a proven verdict to exit code 0, anything else to exit code 1", () => {
    expect(
      proofExitCode(
        combineProofVerdict({ seedId: "s", timing: proven, explain: proven }),
      ),
    ).toBe(0);
    expect(
      proofExitCode(
        combineProofVerdict({
          seedId: "s",
          timing: proven,
          explain: inconclusive,
        }),
      ),
    ).toBe(1);
  });
});
