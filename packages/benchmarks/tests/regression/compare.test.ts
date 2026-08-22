import { describe, expect, it } from "vitest";

import {
  compareRun,
  reportExitCode,
  type LaneComparison,
} from "../../src/regression/compare";
import { type ExtractedRun } from "../../src/regression/history-extract";
import {
  DEFAULT_REGRESSION_POLICY,
  type MeasurementSemantics,
} from "../../src/regression/policy";
import { type LaneRunOutcome } from "../../src/regression/run-lane";

const CANDIDATE_REF = { ref: "HEAD", sha: "cand123", path: "/tmp/candidate" };
const BASELINE_REFS = [{ id: "base" as const, ref: "main", sha: "base123" }];
const BACKENDS = ["sqlite" as const];

function measuredOutcome(
  refId: string,
  measurements: Readonly<Record<string, number>>,
  signature: Readonly<Record<string, string | number>> = {
    backend: "sqlite",
    sampleIterations: 15,
  },
  measurementSemantics?: Readonly<Record<string, MeasurementSemantics>>,
): LaneRunOutcome {
  const run: ExtractedRun = {
    measurements: new Map(Object.entries(measurements)),
    signature,
  };
  return {
    kind: "measured",
    laneId: "perf",
    refId,
    sha: `${refId}-sha`,
    run,
    ...(measurementSemantics === undefined ? {} : { measurementSemantics }),
    durationMs: 1000,
  };
}

function findLane(
  lanes: readonly LaneComparison[],
  baseline: "tag" | "base" | "feature",
): LaneComparison {
  const lane = lanes.find((candidate) => candidate.baseline === baseline);
  if (lane === undefined) {
    throw new Error(`No lane comparison for baseline "${baseline}"`);
  }
  return lane;
}

describe("compareRun", () => {
  it("marks a lane incomparable when sampleIterations differ", () => {
    const candidate = [
      measuredOutcome(
        "candidate",
        { "forward-traversal": 10 },
        {
          backend: "sqlite",
          sampleIterations: 20,
        },
      ),
    ];
    const baselines = [
      measuredOutcome(
        "base",
        { "forward-traversal": 9 },
        {
          backend: "sqlite",
          sampleIterations: 15,
        },
      ),
    ];

    const report = compareRun({
      candidate,
      baselines,
      policy: DEFAULT_REGRESSION_POLICY,
      candidateRef: CANDIDATE_REF,
      baselineRefs: BASELINE_REFS,
      backends: BACKENDS,
    });

    const lane = findLane(report.lanes, "base");
    expect(lane.kind).toBe("incomparable");
    if (lane.kind === "incomparable") {
      expect(lane.reason).toContain("sampleIterations");
    }
    // An incomparable lane is exactly as untrustworthy as an unrunnable
    // one (I8/I9/I10 are all "no comparison happened") — it must never
    // read as a clean 0, or a genuine signature drift (e.g. a future
    // change to SAMPLE_ITERATIONS) silently reports "no regression" for
    // every lane it touches.
    expect(reportExitCode(report)).toBe(2);
  });

  it("marks a lane incomparable when either signature is missing a key", () => {
    const report = compareRun({
      candidate: [
        measuredOutcome("candidate", { label: 10 }, { backend: "sqlite" }),
      ],
      baselines: [
        measuredOutcome(
          "base",
          { label: 10 },
          {
            backend: "sqlite",
            sampleIterations: 15,
          },
        ),
      ],
      policy: DEFAULT_REGRESSION_POLICY,
      candidateRef: CANDIDATE_REF,
      baselineRefs: BASELINE_REFS,
      backends: BACKENDS,
    });

    const lane = findLane(report.lanes, "base");
    expect(lane.kind).toBe("incomparable");
    if (lane.kind === "incomparable") {
      expect(lane.reason).toContain("missing from the candidate");
    }
  });

  it("treats higher recall as an improvement and lower recall as a regression", () => {
    const recallSemantics = {
      "vector:ann-recall": {
        direction: "higher-is-better" as const,
        minAbsoluteDelta: 0.01,
        unit: "recall" as const,
      },
    };
    const improved = compareRun({
      candidate: [
        measuredOutcome(
          "candidate",
          { "vector:ann-recall": 0.9 },
          undefined,
          recallSemantics,
        ),
      ],
      baselines: [measuredOutcome("base", { "vector:ann-recall": 0.7 })],
      policy: DEFAULT_REGRESSION_POLICY,
      candidateRef: CANDIDATE_REF,
      baselineRefs: BASELINE_REFS,
      backends: BACKENDS,
    });
    const regressed = compareRun({
      candidate: [
        measuredOutcome(
          "candidate",
          { "vector:ann-recall": 0.4 },
          undefined,
          recallSemantics,
        ),
      ],
      baselines: [measuredOutcome("base", { "vector:ann-recall": 0.8 })],
      policy: DEFAULT_REGRESSION_POLICY,
      candidateRef: CANDIDATE_REF,
      baselineRefs: BASELINE_REFS,
      backends: BACKENDS,
    });

    const improvedLane = findLane(improved.lanes, "base");
    const regressedLane = findLane(regressed.lanes, "base");
    expect(improvedLane.kind).toBe("compared");
    expect(regressedLane.kind).toBe("compared");
    if (improvedLane.kind === "compared") {
      expect(improvedLane.comparisons[0]?.classification).toBe("improved");
    }
    if (regressedLane.kind === "compared") {
      expect(regressedLane.comparisons[0]?.classification).toBe("failed");
    }
  });

  it("reports a baseline-only label as missing-candidate", () => {
    const candidate = [measuredOutcome("candidate", { "shared-label": 10 })];
    const baselines = [
      measuredOutcome("base", { "shared-label": 10, "baseline-only": 5 }),
    ];

    const report = compareRun({
      candidate,
      baselines,
      policy: DEFAULT_REGRESSION_POLICY,
      candidateRef: CANDIDATE_REF,
      baselineRefs: BASELINE_REFS,
      backends: BACKENDS,
    });

    const lane = findLane(report.lanes, "base");
    expect(lane.kind).toBe("compared");
    if (lane.kind === "compared") {
      const comparison = lane.comparisons.find(
        (c) => c.label === "baseline-only",
      );
      expect(comparison?.classification).toBe("missing-candidate");
    }
    expect(report.flags.some((flag) => flag.label === "baseline-only")).toBe(
      true,
    );
  });

  it("reports a candidate-only label as missing-baseline without flagging", () => {
    const candidate = [
      measuredOutcome("candidate", { "shared-label": 10, "candidate-only": 5 }),
    ];
    const baselines = [measuredOutcome("base", { "shared-label": 10 })];

    const report = compareRun({
      candidate,
      baselines,
      policy: DEFAULT_REGRESSION_POLICY,
      candidateRef: CANDIDATE_REF,
      baselineRefs: BASELINE_REFS,
      backends: BACKENDS,
    });

    const lane = findLane(report.lanes, "base");
    expect(lane.kind).toBe("compared");
    if (lane.kind === "compared") {
      const comparison = lane.comparisons.find(
        (c) => c.label === "candidate-only",
      );
      expect(comparison?.classification).toBe("missing-baseline");
    }
    expect(report.flags.some((flag) => flag.label === "candidate-only")).toBe(
      false,
    );
    expect(
      report.hardFailures.some((flag) => flag.label === "candidate-only"),
    ).toBe(false);
  });

  it("a failed lane run is a hard failure", () => {
    const candidate = [
      measuredOutcome("candidate", { "forward-traversal": 10 }),
    ];
    const baselines: LaneRunOutcome[] = [
      {
        kind: "failed",
        laneId: "perf",
        refId: "base",
        sha: "base-sha",
        reason: "exited with code 1",
        exitCode: 1,
        timedOut: false,
      },
    ];

    const report = compareRun({
      candidate,
      baselines,
      policy: DEFAULT_REGRESSION_POLICY,
      candidateRef: CANDIDATE_REF,
      baselineRefs: BASELINE_REFS,
      backends: BACKENDS,
    });

    const lane = findLane(report.lanes, "base");
    expect(lane.kind).toBe("unrunnable");
    expect(reportExitCode(report)).toBe(2);
  });

  it("a timed-out lane run is a hard failure", () => {
    const candidate = [
      measuredOutcome("candidate", { "forward-traversal": 10 }),
    ];
    const baselines: LaneRunOutcome[] = [
      {
        kind: "failed",
        laneId: "perf",
        refId: "base",
        sha: "base-sha",
        reason: "timed out after 900000ms",
        exitCode: null,
        timedOut: true,
      },
    ];

    const report = compareRun({
      candidate,
      baselines,
      policy: DEFAULT_REGRESSION_POLICY,
      candidateRef: CANDIDATE_REF,
      baselineRefs: BASELINE_REFS,
      backends: BACKENDS,
    });

    const lane = findLane(report.lanes, "base");
    expect(lane.kind).toBe("unrunnable");
    expect(reportExitCode(report)).toBe(2);
  });

  it("an unavailable lane is reported, never treated as no-regression", () => {
    const candidate = [
      measuredOutcome("candidate", { "forward-traversal": 10 }),
    ];
    const baselines: LaneRunOutcome[] = [
      {
        kind: "unavailable",
        laneId: "perf",
        refId: "base",
        sha: "base-sha",
        reason: 'Script "perf" is absent from the worktree package.json.',
      },
    ];

    const report = compareRun({
      candidate,
      baselines,
      policy: DEFAULT_REGRESSION_POLICY,
      candidateRef: CANDIDATE_REF,
      baselineRefs: BASELINE_REFS,
      backends: BACKENDS,
    });

    const lane = findLane(report.lanes, "base");
    expect(lane.kind).toBe("unrunnable");
    if (lane.kind === "unrunnable") {
      expect(lane.reason).toContain("absent");
    }
    // Never silently "compared" with a fabricated ratio of 1 (ok).
    expect(lane.kind).not.toBe("compared");
  });

  it("exit code is 2 for hard failure, 1 for flag, 0 for clean", () => {
    const cleanReport = compareRun({
      candidate: [measuredOutcome("candidate", { label: 100 })],
      baselines: [measuredOutcome("base", { label: 100 })],
      policy: DEFAULT_REGRESSION_POLICY,
      candidateRef: CANDIDATE_REF,
      baselineRefs: BASELINE_REFS,
      backends: BACKENDS,
    });
    expect(reportExitCode(cleanReport)).toBe(0);

    const flaggedReport = compareRun({
      candidate: [measuredOutcome("candidate", { label: 130 })],
      baselines: [measuredOutcome("base", { label: 100 })],
      policy: DEFAULT_REGRESSION_POLICY,
      candidateRef: CANDIDATE_REF,
      baselineRefs: BASELINE_REFS,
      backends: BACKENDS,
    });
    expect(reportExitCode(flaggedReport)).toBe(1);

    const failedReport = compareRun({
      candidate: [measuredOutcome("candidate", { label: 300 })],
      baselines: [measuredOutcome("base", { label: 100 })],
      policy: DEFAULT_REGRESSION_POLICY,
      candidateRef: CANDIDATE_REF,
      baselineRefs: BASELINE_REFS,
      backends: BACKENDS,
    });
    expect(reportExitCode(failedReport)).toBe(2);
  });
});
