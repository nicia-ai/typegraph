/**
 * Regression classification policy: thresholds, accepted-regression
 * overrides, and the single decision function (`classifyRatio`) every
 * comparison in `compare.ts` routes through. No caller re-derives
 * flag/fail/accept from the raw thresholds — see AGENTS.md's "one
 * predicate, one owner" rule.
 */

export type BaselineId = "tag" | "base" | "feature";

export type AcceptedRegression = Readonly<{
  laneId: string;
  /** Exact history measurement label; no globs. */
  label: string;
  baseline: BaselineId | "all";
  /** Ceiling this acceptance covers; a ratio above it is not absorbed. */
  maxRatio: number;
  reason: string;
  issue?: string;
}>;

export type RegressionPolicy = Readonly<{
  flagRatio: number;
  failRatio: number;
  minAbsoluteDeltaMs: number;
  accepted: readonly AcceptedRegression[];
}>;

export const DEFAULT_REGRESSION_POLICY: RegressionPolicy = {
  flagRatio: 1.2,
  failRatio: 2.0,
  minAbsoluteDeltaMs: 0.5,
  accepted: [],
};

export type Classification =
  | "ok"
  | "improved"
  | "below-noise-floor"
  | "accepted"
  | "flagged"
  | "failed"
  | "missing-baseline"
  | "missing-candidate";

export type ClassifyRatioInput = Readonly<{
  laneId: string;
  label: string;
  baseline: BaselineId;
  baselineMs: number;
  candidateMs: number;
}>;

export type ClassifyRatioResult = Readonly<{
  classification: Classification;
  ratio: number;
  deltaMs: number;
  note?: string;
}>;

function computeRatio(baselineMs: number, candidateMs: number): number {
  if (baselineMs === 0) {
    return candidateMs === 0 ? 1 : Number.POSITIVE_INFINITY;
  }
  return candidateMs / baselineMs;
}

function findApplicableAcceptance(
  accepted: readonly AcceptedRegression[],
  laneId: string,
  label: string,
  baseline: BaselineId,
): AcceptedRegression | undefined {
  return accepted.find(
    (acceptance) =>
      acceptance.laneId === laneId &&
      acceptance.label === label &&
      (acceptance.baseline === baseline || acceptance.baseline === "all"),
  );
}

function classifySeverity(
  ratio: number,
  policy: RegressionPolicy,
): "ok" | "flagged" | "failed" {
  if (ratio >= policy.failRatio) return "failed";
  if (ratio >= policy.flagRatio) return "flagged";
  return "ok";
}

/**
 * The single owner of the flag/fail/accept decision for one (lane, label,
 * baseline) measurement pair. No other module may re-derive this from
 * `policy.flagRatio` / `policy.failRatio` directly.
 */
export function classifyRatio(
  input: ClassifyRatioInput,
  policy: RegressionPolicy,
): ClassifyRatioResult {
  const { laneId, label, baseline, baselineMs, candidateMs } = input;
  const deltaMs = candidateMs - baselineMs;
  const ratio = computeRatio(baselineMs, candidateMs);

  // I2: the noise floor gates on the absolute delta, never on the baseline
  // magnitude. The #396 regression was 0.0082ms -> 564ms: a tiny baseline
  // must never suppress a real regression.
  if (Math.abs(deltaMs) < policy.minAbsoluteDeltaMs) {
    return { classification: "below-noise-floor", ratio, deltaMs };
  }

  if (ratio < 1) {
    return { classification: "improved", ratio, deltaMs };
  }

  const acceptance = findApplicableAcceptance(
    policy.accepted,
    laneId,
    label,
    baseline,
  );

  if (acceptance !== undefined && ratio <= acceptance.maxRatio) {
    return {
      classification: "accepted",
      ratio,
      deltaMs,
      note: acceptance.reason,
    };
  }

  const severity = classifySeverity(ratio, policy);
  if (acceptance !== undefined) {
    // I3: an acceptance above its own ceiling is refused, not silently
    // absorbed — re-classify at normal severity and name the exceeded ceiling.
    return {
      classification: severity,
      ratio,
      deltaMs,
      note: `exceeds accepted ceiling of ${acceptance.maxRatio}x (${acceptance.reason})`,
    };
  }
  return { classification: severity, ratio, deltaMs };
}

export type ObservedMeasurement = Readonly<{
  laneId: string;
  label: string;
  baseline: BaselineId;
}>;

/**
 * Accepted regressions that matched no observed (lane, label, baseline)
 * triple in this run. A stale acceptance is a hard failure (I3) — never
 * silently absorbed by going unnoticed.
 */
export function findStaleAcceptances(
  policy: RegressionPolicy,
  observed: readonly ObservedMeasurement[],
): readonly AcceptedRegression[] {
  return policy.accepted.filter(
    (acceptance) =>
      !observed.some(
        (entry) =>
          entry.laneId === acceptance.laneId &&
          entry.label === acceptance.label &&
          (acceptance.baseline === "all" ||
            acceptance.baseline === entry.baseline),
      ),
  );
}
