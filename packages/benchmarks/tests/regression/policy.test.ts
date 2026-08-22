import { describe, expect, it } from "vitest";

import {
  classifyRatio,
  DEFAULT_REGRESSION_POLICY,
  findStaleAcceptances,
  type AcceptedRegression,
  type RegressionPolicy,
} from "../../src/regression/policy";

const BASE_INPUT = {
  laneId: "perf",
  label: "forward-traversal",
  baseline: "base" as const,
};

describe("classifyRatio", () => {
  it("flags at exactly 20% median regression", () => {
    const result = classifyRatio(
      { ...BASE_INPUT, baselineMs: 100, candidateMs: 120 },
      DEFAULT_REGRESSION_POLICY,
    );
    expect(result.classification).toBe("flagged");
  });

  it("hard-fails at exactly 2x", () => {
    const result = classifyRatio(
      { ...BASE_INPUT, baselineMs: 100, candidateMs: 200 },
      DEFAULT_REGRESSION_POLICY,
    );
    expect(result.classification).toBe("failed");
  });

  it("flags the #396 shape (0.0082ms -> 564ms) despite a sub-floor baseline", () => {
    const result = classifyRatio(
      { ...BASE_INPUT, baselineMs: 0.0082, candidateMs: 564 },
      DEFAULT_REGRESSION_POLICY,
    );
    expect(result.classification).toBe("failed");
  });

  it("suppresses a sub-floor jitter delta (0.008 -> 0.011ms)", () => {
    const result = classifyRatio(
      { ...BASE_INPUT, baselineMs: 0.008, candidateMs: 0.011 },
      DEFAULT_REGRESSION_POLICY,
    );
    expect(result.classification).toBe("below-noise-floor");
  });

  it("classifies improvements as improved, not flagged", () => {
    const result = classifyRatio(
      { ...BASE_INPUT, baselineMs: 100, candidateMs: 50 },
      DEFAULT_REGRESSION_POLICY,
    );
    expect(result.classification).toBe("improved");
  });

  it("inverts ratio polarity for higher-is-better measurements", () => {
    const semantics = {
      direction: "higher-is-better" as const,
      minAbsoluteDelta: 0.01,
      unit: "recall" as const,
    };
    const improved = classifyRatio(
      {
        ...BASE_INPUT,
        baselineMs: 0.5,
        candidateMs: 0.8,
        semantics,
      },
      DEFAULT_REGRESSION_POLICY,
    );
    const regressed = classifyRatio(
      {
        ...BASE_INPUT,
        baselineMs: 0.8,
        candidateMs: 0.4,
        semantics,
      },
      DEFAULT_REGRESSION_POLICY,
    );
    expect(improved.classification).toBe("improved");
    expect(regressed.classification).toBe("failed");
  });

  it("refuses an acceptance whose observed ratio exceeds maxRatio", () => {
    const acceptance: AcceptedRegression = {
      laneId: BASE_INPUT.laneId,
      label: BASE_INPUT.label,
      baseline: "base",
      maxRatio: 1.5,
      reason: "known slow leg pending #123",
    };
    const policy: RegressionPolicy = {
      ...DEFAULT_REGRESSION_POLICY,
      accepted: [acceptance],
    };
    const result = classifyRatio(
      { ...BASE_INPUT, baselineMs: 100, candidateMs: 250 },
      policy,
    );
    expect(result.classification).not.toBe("accepted");
    expect(result.classification).toBe("failed");
    expect(result.note).toContain("exceeds accepted ceiling");
  });

  it("accepted regression carries its reason into the comparison note", () => {
    const acceptance: AcceptedRegression = {
      laneId: BASE_INPUT.laneId,
      label: BASE_INPUT.label,
      baseline: "base",
      maxRatio: 1.5,
      reason: "known slow leg pending #123",
    };
    const policy: RegressionPolicy = {
      ...DEFAULT_REGRESSION_POLICY,
      accepted: [acceptance],
    };
    const result = classifyRatio(
      { ...BASE_INPUT, baselineMs: 100, candidateMs: 130 },
      policy,
    );
    expect(result.classification).toBe("accepted");
    expect(result.note).toBe(acceptance.reason);
  });
});

describe("findStaleAcceptances", () => {
  it("reports an acceptance that matched nothing as stale", () => {
    const acceptance: AcceptedRegression = {
      laneId: BASE_INPUT.laneId,
      label: BASE_INPUT.label,
      baseline: "base",
      maxRatio: 1.5,
      reason: "known slow leg pending #123",
    };
    const policy: RegressionPolicy = {
      ...DEFAULT_REGRESSION_POLICY,
      accepted: [acceptance],
    };
    const stale = findStaleAcceptances(policy, []);
    expect(stale).toEqual([acceptance]);
  });

  it("does not report an acceptance that matched an observed measurement as stale", () => {
    const acceptance: AcceptedRegression = {
      laneId: BASE_INPUT.laneId,
      label: BASE_INPUT.label,
      baseline: "base",
      maxRatio: 1.5,
      reason: "known slow leg pending #123",
    };
    const policy: RegressionPolicy = {
      ...DEFAULT_REGRESSION_POLICY,
      accepted: [acceptance],
    };
    const stale = findStaleAcceptances(policy, [
      { laneId: BASE_INPUT.laneId, label: BASE_INPUT.label, baseline: "base" },
    ]);
    expect(stale).toEqual([]);
  });
});
