import { type LaneBackend, type RegressionLane } from "./lanes";
import {
  classifyRatio,
  findStaleAcceptances,
  type AcceptedRegression,
  type BaselineId,
  type Classification,
  type RegressionPolicy,
} from "./policy";
import { type LaneMeasurements } from "./history-extract";
import { type MeasurementSemantics } from "./policy";
import { type LaneRunOutcome } from "./run-lane";

export type MeasurementComparison = Readonly<{
  laneId: string;
  label: string;
  baseline: BaselineId;
  baselineMs: number | undefined;
  candidateMs: number | undefined;
  ratio: number | undefined;
  deltaMs: number | undefined;
  classification: Classification;
  note?: string;
  unit?: MeasurementSemantics["unit"];
  direction?: MeasurementSemantics["direction"];
}>;

export type LaneComparison =
  | Readonly<{
      kind: "compared";
      laneId: string;
      baseline: BaselineId;
      comparisons: readonly MeasurementComparison[];
    }>
  | Readonly<{
      // I10: baseline and candidate signatures disagree — comparing e.g. a
      // 15-sample median against a 20-sample median is not evidence.
      kind: "incomparable";
      laneId: string;
      baseline: BaselineId;
      reason: string;
    }>
  | Readonly<{
      // I8/I9: the lane's script was unavailable, or the run failed/timed
      // out. Either way, "no comparison" is reported, never treated as ok.
      kind: "unrunnable";
      laneId: string;
      baseline: BaselineId;
      reason: string;
    }>;

export type RegressionReport = Readonly<{
  generatedAt: string;
  candidate: Readonly<{ ref: string; sha: string; path: string }>;
  baselines: readonly Readonly<{ id: BaselineId; ref: string; sha: string }>[];
  backends: readonly LaneBackend[];
  policy: RegressionPolicy;
  lanes: readonly LaneComparison[];
  staleAcceptances: readonly AcceptedRegression[];
  hardFailures: readonly MeasurementComparison[];
  flags: readonly MeasurementComparison[];
}>;

export type CompareRunInput = Readonly<{
  candidate: readonly LaneRunOutcome[];
  baselines: readonly LaneRunOutcome[];
  policy: RegressionPolicy;
  candidateRef: Readonly<{ ref: string; sha: string; path: string }>;
  baselineRefs: readonly Readonly<{
    id: BaselineId;
    ref: string;
    sha: string;
  }>[];
  backends: readonly LaneBackend[];
}>;

function describeUnrunnable(outcome: LaneRunOutcome): string {
  switch (outcome.kind) {
    case "unavailable":
      return `Lane unavailable: ${outcome.reason}`;
    case "failed":
      return `Lane run failed: ${outcome.reason}`;
    case "measured":
      // Unreachable: callers only pass non-"measured" outcomes here.
      throw new Error("describeUnrunnable called with a measured outcome.");
  }
}

function findSignatureDifference(
  baselineSignature: Readonly<Record<string, string | number>>,
  candidateSignature: Readonly<Record<string, string | number>>,
): string | undefined {
  const allKeys = [
    ...new Set([
      ...Object.keys(baselineSignature),
      ...Object.keys(candidateSignature),
    ]),
  ].sort();
  for (const key of allKeys) {
    if (!(key in baselineSignature)) {
      return `Signature key "${key}" is missing from the baseline.`;
    }
    if (!(key in candidateSignature)) {
      return `Signature key "${key}" is missing from the candidate.`;
    }
    if (baselineSignature[key] !== candidateSignature[key]) {
      return (
        `Signature key "${key}" differs between baseline ` +
        `(${String(baselineSignature[key])}) and candidate (${String(candidateSignature[key])}).`
      );
    }
  }
  return undefined;
}

function compareLabels(
  laneId: string,
  baseline: BaselineId,
  baselineMeasurements: LaneMeasurements,
  candidateMeasurements: LaneMeasurements,
  policy: RegressionPolicy,
  measurementSemantics: RegressionLane["measurementSemantics"],
): readonly MeasurementComparison[] {
  const labels = new Set([
    ...baselineMeasurements.keys(),
    ...candidateMeasurements.keys(),
  ]);
  const comparisons: MeasurementComparison[] = [];
  for (const label of labels) {
    const baselineMs = baselineMeasurements.get(label);
    const candidateMs = candidateMeasurements.get(label);

    if (baselineMs === undefined) {
      // I11: present only in the candidate — informational, ok-severity.
      comparisons.push({
        laneId,
        label,
        baseline,
        baselineMs: undefined,
        candidateMs,
        ratio: undefined,
        deltaMs: undefined,
        classification: "missing-baseline",
      });
      continue;
    }
    if (candidateMs === undefined) {
      // I11: present only in the baseline — counts as a flag.
      comparisons.push({
        laneId,
        label,
        baseline,
        baselineMs,
        candidateMs: undefined,
        ratio: undefined,
        deltaMs: undefined,
        classification: "missing-candidate",
      });
      continue;
    }

    const semantics = measurementSemantics?.[label];
    const { classification, ratio, deltaMs, note } = classifyRatio(
      {
        laneId,
        label,
        baseline,
        baselineMs,
        candidateMs,
        ...(semantics === undefined ? {} : { semantics }),
      },
      policy,
    );
    comparisons.push({
      laneId,
      label,
      baseline,
      baselineMs,
      candidateMs,
      ratio,
      deltaMs,
      classification,
      ...(semantics === undefined ?
        {}
      : { unit: semantics.unit, direction: semantics.direction }),
      ...(note === undefined ? {} : { note }),
    });
  }
  return comparisons;
}

function buildLaneComparison(
  laneId: string,
  baseline: BaselineId,
  candidateOutcome: LaneRunOutcome | undefined,
  baselineOutcome: LaneRunOutcome | undefined,
  policy: RegressionPolicy,
): LaneComparison {
  if (candidateOutcome === undefined) {
    return {
      kind: "unrunnable",
      laneId,
      baseline,
      reason: `No candidate result for lane "${laneId}".`,
    };
  }
  if (baselineOutcome === undefined) {
    return {
      kind: "unrunnable",
      laneId,
      baseline,
      reason: `No "${baseline}" baseline result for lane "${laneId}".`,
    };
  }
  if (candidateOutcome.kind !== "measured") {
    return {
      kind: "unrunnable",
      laneId,
      baseline,
      reason: describeUnrunnable(candidateOutcome),
    };
  }
  if (baselineOutcome.kind !== "measured") {
    return {
      kind: "unrunnable",
      laneId,
      baseline,
      reason: describeUnrunnable(baselineOutcome),
    };
  }

  const signatureDifference = findSignatureDifference(
    baselineOutcome.run.signature,
    candidateOutcome.run.signature,
  );
  if (signatureDifference !== undefined) {
    return {
      kind: "incomparable",
      laneId,
      baseline,
      reason: signatureDifference,
    };
  }

  return {
    kind: "compared",
    laneId,
    baseline,
    comparisons: compareLabels(
      laneId,
      baseline,
      baselineOutcome.run.measurements,
      candidateOutcome.run.measurements,
      policy,
      candidateOutcome.measurementSemantics,
    ),
  };
}

/**
 * Baseline x candidate -> report. The single owner of how run outcomes
 * become comparisons; `reportExitCode` is the single owner of turning a
 * report into an exit code.
 */
export function compareRun(input: CompareRunInput): RegressionReport {
  const { candidate, baselines, policy, candidateRef, baselineRefs, backends } =
    input;

  const laneIds = [
    ...new Set([...candidate, ...baselines].map((outcome) => outcome.laneId)),
  ];

  const lanes: LaneComparison[] = [];
  for (const laneId of laneIds) {
    const candidateOutcome = candidate.find(
      (outcome) => outcome.laneId === laneId,
    );
    for (const baselineMeta of baselineRefs) {
      const baselineOutcome = baselines.find(
        (outcome) =>
          outcome.laneId === laneId && outcome.refId === baselineMeta.id,
      );
      lanes.push(
        buildLaneComparison(
          laneId,
          baselineMeta.id,
          candidateOutcome,
          baselineOutcome,
          policy,
        ),
      );
    }
  }

  const allComparisons = lanes.flatMap((lane) =>
    lane.kind === "compared" ? lane.comparisons : [],
  );
  const hardFailures = allComparisons.filter(
    (comparison) => comparison.classification === "failed",
  );
  const flags = allComparisons.filter(
    (comparison) =>
      comparison.classification === "flagged" ||
      comparison.classification === "missing-candidate",
  );

  const observed = allComparisons.map((comparison) => ({
    laneId: comparison.laneId,
    label: comparison.label,
    baseline: comparison.baseline,
  }));
  const staleAcceptances = findStaleAcceptances(policy, observed);

  return {
    generatedAt: new Date().toISOString(),
    candidate: candidateRef,
    baselines: baselineRefs,
    backends,
    policy,
    lanes,
    staleAcceptances,
    hardFailures,
    flags,
  };
}

/**
 * The single owner of the report -> exit code decision (I12):
 * 2 on a hard failure, a stale acceptance, or a lane that produced no
 * trustworthy comparison at all (unrunnable *or* incomparable — I8/I9/I10
 * are the same "no comparison happened" state under different causes, and
 * none of them may silently read as ok); 1 on a flag with no hard failure;
 * 0 otherwise.
 */
export function reportExitCode(report: RegressionReport): 0 | 1 | 2 {
  const hasUnverifiableLane = report.lanes.some(
    (lane) => lane.kind === "unrunnable" || lane.kind === "incomparable",
  );
  if (
    report.hardFailures.length > 0 ||
    report.staleAcceptances.length > 0 ||
    hasUnverifiableLane
  ) {
    return 2;
  }
  if (report.flags.length > 0) {
    return 1;
  }
  return 0;
}
