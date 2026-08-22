import { type LaneComparison, type RegressionReport } from "../compare";
import { DEFAULT_REGRESSION_POLICY, type RegressionPolicy } from "../policy";
import {
  type ExplainFailureExpectation,
  type SeedExplainExpectation,
  type SeedTimingExpectation,
} from "./seeds";

/**
 * The testable core of the seeded-regression proof: turning a
 * `bench:regression` report and a `vitest --reporter=json` report into a
 * verdict, per the seed's own declared expectations. Neither judge ever
 * re-derives a severity or a diagnostic from anything but the input it is
 * handed — `judgeTimingProof` consumes `classification` (owned by
 * `policy.classifyRatio`), and `judgeExplainProof` consumes a test's own
 * `failureMessages` (owned by whatever assertion threw).
 */

export type ProofHalfVerdict =
  | Readonly<{ kind: "proven"; evidence: string }>
  | Readonly<{ kind: "inconclusive"; reason: string }>
  | Readonly<{ kind: "invalid-seed"; reason: string }>;

/** Every requested backend must prove the seed; one weak leg weakens the half. */
export function combineBackendTimingVerdicts(
  verdicts: readonly Readonly<{
    backend: string;
    verdict: ProofHalfVerdict;
  }>[],
): ProofHalfVerdict {
  const invalid = verdicts.find(
    (entry) => entry.verdict.kind === "invalid-seed",
  );
  if (invalid !== undefined && invalid.verdict.kind === "invalid-seed") {
    return {
      kind: "invalid-seed",
      reason: `${invalid.backend}: ${invalid.verdict.reason}`,
    };
  }
  const inconclusive = verdicts.find(
    (entry) => entry.verdict.kind === "inconclusive",
  );
  if (
    inconclusive !== undefined &&
    inconclusive.verdict.kind === "inconclusive"
  ) {
    return {
      kind: "inconclusive",
      reason: `${inconclusive.backend}: ${inconclusive.verdict.reason}`,
    };
  }
  if (verdicts.length === 0) {
    return { kind: "inconclusive", reason: "no backend reports were judged" };
  }
  return {
    kind: "proven",
    evidence: verdicts
      .map((entry) => {
        if (entry.verdict.kind !== "proven") {
          throw new Error("Unexpected non-proven backend timing verdict.");
        }
        return `${entry.backend}: ${entry.verdict.evidence}`;
      })
      .join("; "),
  };
}

function isDefaultPolicy(policy: RegressionPolicy): boolean {
  return (
    policy.flagRatio === DEFAULT_REGRESSION_POLICY.flagRatio &&
    policy.failRatio === DEFAULT_REGRESSION_POLICY.failRatio &&
    policy.minAbsoluteDeltaMs ===
      DEFAULT_REGRESSION_POLICY.minAbsoluteDeltaMs &&
    policy.accepted.length === 0
  );
}

function findLaneComparison(
  lanes: readonly LaneComparison[],
  laneId: string,
  baseline: SeedTimingExpectation["baseline"],
): LaneComparison | undefined {
  return lanes.find(
    (lane) => lane.laneId === laneId && lane.baseline === baseline,
  );
}

/**
 * Timing-half judge (I-PROOF-MATCHED). Rules, in order: (a) refuse a report
 * generated under a modified policy — an accepted regression or a widened
 * threshold could make the seed "pass" without the fix having anything to do
 * with it; (b) locate the lane comparison for `(laneId, baseline)` — absent,
 * or not `"compared"` (unrunnable/incomparable — an exit code alone is never
 * proof), is inconclusive; (c) locate the measurement for `label`; (d) the
 * observed classification must equal the seed's declared one exactly, never
 * "at least as severe" — a `"flagged"` result where the seed declares
 * `"failed"` is a real signal-strength gap, not evidence of the same defect.
 */
export function judgeTimingProof(
  input: Readonly<{
    report: RegressionReport;
    expectation: SeedTimingExpectation;
  }>,
): ProofHalfVerdict {
  const { report, expectation } = input;

  if (!isDefaultPolicy(report.policy)) {
    return {
      kind: "inconclusive",
      reason: "proof ran under a modified policy",
    };
  }

  const lane = findLaneComparison(
    report.lanes,
    expectation.laneId,
    expectation.baseline,
  );
  if (lane === undefined) {
    return {
      kind: "inconclusive",
      reason:
        `no lane comparison for lane "${expectation.laneId}" against ` +
        `baseline "${expectation.baseline}"`,
    };
  }
  if (lane.kind !== "compared") {
    return {
      kind: "inconclusive",
      reason:
        `lane "${expectation.laneId}" (${expectation.baseline}) produced no ` +
        `comparison — kind "${lane.kind}": ${lane.reason}`,
    };
  }

  const comparison = lane.comparisons.find(
    (candidate) => candidate.label === expectation.label,
  );
  if (comparison === undefined) {
    const observedLabels = lane.comparisons.map((candidate) => candidate.label);
    return {
      kind: "inconclusive",
      reason:
        `no comparison for label "${expectation.label}" on lane ` +
        `"${expectation.laneId}" (${expectation.baseline}); observed labels: ` +
        `${observedLabels.length === 0 ? "(none)" : observedLabels.join(", ")}`,
    };
  }

  if (comparison.classification !== expectation.classification) {
    return {
      kind: "inconclusive",
      reason:
        `expected classification "${expectation.classification}" for ` +
        `"${expectation.laneId}"/"${expectation.label}" (${expectation.baseline}), ` +
        `observed "${comparison.classification}" ` +
        `(ratio ${comparison.ratio === undefined ? "—" : comparison.ratio.toFixed(2)})`,
    };
  }

  return {
    kind: "proven",
    evidence:
      `${comparison.baselineMs === undefined ? "—" : comparison.baselineMs.toFixed(3)}ms -> ` +
      `${comparison.candidateMs === undefined ? "—" : comparison.candidateMs.toFixed(3)}ms ` +
      `(${comparison.ratio === undefined ? "—" : `${comparison.ratio.toFixed(2)}x`}, ` +
      `${comparison.classification})`,
  };
}

export type VitestAssertionResult = Readonly<{
  fullName: string;
  status: string;
  failureMessages?: readonly string[];
}>;

export type VitestJsonReport = Readonly<{
  testResults: readonly Readonly<{
    name: string;
    assertionResults: readonly VitestAssertionResult[];
  }>[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAssertionResult(
  raw: unknown,
  path: string,
): VitestAssertionResult {
  if (
    !isRecord(raw) ||
    typeof raw["fullName"] !== "string" ||
    typeof raw["status"] !== "string"
  ) {
    throw new Error(
      `Unrecognized vitest JSON report shape at ${path}: expected an object ` +
        'with string "fullName" and "status" fields.',
    );
  }
  const rawFailureMessages = raw["failureMessages"];
  return {
    fullName: raw["fullName"],
    status: raw["status"],
    ...(Array.isArray(rawFailureMessages) ?
      { failureMessages: rawFailureMessages.map((message) => String(message)) }
    : {}),
  };
}

function parseTestResult(
  raw: unknown,
  index: number,
): VitestJsonReport["testResults"][number] {
  if (
    !isRecord(raw) ||
    typeof raw["name"] !== "string" ||
    !Array.isArray(raw["assertionResults"])
  ) {
    throw new Error(
      `Unrecognized vitest JSON report shape at testResults[${index}]: ` +
        'expected an object with a string "name" and an array ' +
        '"assertionResults" field.',
    );
  }
  return {
    name: raw["name"],
    assertionResults: raw["assertionResults"].map(
      (assertionRaw, assertionIndex) =>
        parseAssertionResult(
          assertionRaw,
          `testResults[${index}].assertionResults[${assertionIndex}]`,
        ),
    ),
  };
}

/**
 * Parses a vitest `--reporter=json` output file. Throws on any shape that
 * does not carry a `testResults` array of `{ name, assertionResults }`
 * entries — never casts and hopes, since {@link judgeExplainProof} trusts
 * every field this returns without re-checking it.
 */
export function parseVitestJsonReport(raw: string): VitestJsonReport {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !Array.isArray(parsed["testResults"])) {
    throw new Error(
      "Unrecognized vitest JSON report shape: expected a top-level object " +
        'with a "testResults" array.',
    );
  }
  return {
    testResults: parsed["testResults"].map((testResultRaw, index) =>
      parseTestResult(testResultRaw, index),
    ),
  };
}

function matchesAllFragments(
  assertion: VitestAssertionResult,
  fragments: readonly string[],
): boolean {
  return fragments.every((fragment) => assertion.fullName.includes(fragment));
}

function findExactlyOne(
  assertions: readonly VitestAssertionResult[],
  fragments: readonly string[],
): readonly VitestAssertionResult[] {
  return assertions.filter((assertion) =>
    matchesAllFragments(assertion, fragments),
  );
}

function judgeMustPass(
  assertions: readonly VitestAssertionResult[],
  mustPass: readonly (readonly string[])[],
): ProofHalfVerdict | undefined {
  for (const fragments of mustPass) {
    const matches = findExactlyOne(assertions, fragments);
    if (matches.length !== 1) {
      return {
        kind: "invalid-seed",
        reason:
          `must-pass case [${fragments.join(", ")}] matched ${matches.length} ` +
          "tests, expected exactly one — a suite that did not run is not a " +
          "cost regression",
      };
    }
    const [match] = matches;
    if (match!.status !== "passed") {
      return {
        kind: "invalid-seed",
        reason:
          `must-pass case [${fragments.join(", ")}] did not pass (status: ` +
          `"${match!.status}") — the seed breaks semantics, not just cost`,
      };
    }
  }
  return undefined;
}

function judgeMustFail(
  assertions: readonly VitestAssertionResult[],
  mustFail: readonly ExplainFailureExpectation[],
): ProofHalfVerdict | undefined {
  for (const expectation of mustFail) {
    const matches = findExactlyOne(assertions, expectation.titleFragments);
    if (matches.length !== 1) {
      return {
        kind: "inconclusive",
        reason:
          `must-fail case [${expectation.titleFragments.join(", ")}] matched ` +
          `${matches.length} tests, expected exactly one — ambiguity is not ` +
          "evidence",
      };
    }
    const [match] = matches;
    if (match!.status === "passed") {
      return {
        kind: "inconclusive",
        reason:
          `the seed passed undetected: [${expectation.titleFragments.join(", ")}] ` +
          `passed instead of failing with "${expectation.diagnostic}"`,
      };
    }
    if (match!.status !== "failed") {
      return {
        kind: "inconclusive",
        reason:
          `must-fail case [${expectation.titleFragments.join(", ")}] reported ` +
          `status "${match!.status}", neither passed nor failed`,
      };
    }
    const failureMessages = match!.failureMessages ?? [];
    const diagnosticFound = failureMessages.some((message) =>
      message.includes(expectation.diagnostic),
    );
    if (!diagnosticFound) {
      return {
        kind: "inconclusive",
        reason:
          `must-fail case [${expectation.titleFragments.join(", ")}] failed, ` +
          `but no failure message contained the declared diagnostic ` +
          `"${expectation.diagnostic}" — could be an unrelated failure ` +
          "(import error, timeout)",
      };
    }
  }
  return undefined;
}

/**
 * Explain-half judge (I-PROOF-DIAGNOSTIC, I-SEED-SEMANTICS). Every
 * `mustPass` case must still pass (the seed is a cost regression, never a
 * semantic break); every `mustFail` case must fail, unambiguously, with a
 * message containing its own declared diagnostic — a red test proves
 * nothing on its own; the message is what proves the test went red for the
 * declared reason.
 */
export function judgeExplainProof(
  input: Readonly<{
    report: VitestJsonReport;
    expectation: SeedExplainExpectation;
  }>,
): ProofHalfVerdict {
  const { report, expectation } = input;
  const assertions = report.testResults.flatMap(
    (testResult) => testResult.assertionResults,
  );

  const mustPassVerdict = judgeMustPass(assertions, expectation.mustPass);
  if (mustPassVerdict !== undefined) {
    return mustPassVerdict;
  }

  const mustFailVerdict = judgeMustFail(assertions, expectation.mustFail);
  if (mustFailVerdict !== undefined) {
    return mustFailVerdict;
  }

  return {
    kind: "proven",
    evidence:
      `${expectation.mustFail.length} must-fail case(s) failed with their ` +
      `declared diagnostics; ${expectation.mustPass.length} must-pass ` +
      "case(s) still passed",
  };
}

export type ProofVerdict = Readonly<{
  seedId: string;
  timing: ProofHalfVerdict | "skipped";
  explain: ProofHalfVerdict | "skipped";
  proven: boolean;
}>;

/**
 * `proven` only when both halves ran and both proved (I-PROOF-MATCHED,
 * I-PROOF-DIAGNOSTIC) — a `"skipped"` half (a `--half=timing`/`--half=explain`
 * partial run) can never make the combined verdict `proven`, since a proof
 * that only checked one half proved only one half.
 */
export function combineProofVerdict(
  input: Readonly<{
    seedId: string;
    timing: ProofHalfVerdict | "skipped";
    explain: ProofHalfVerdict | "skipped";
  }>,
): ProofVerdict {
  const { seedId, timing, explain } = input;
  const proven =
    timing !== "skipped" &&
    timing.kind === "proven" &&
    explain !== "skipped" &&
    explain.kind === "proven";
  return { seedId, timing, explain, proven };
}

export function proofExitCode(verdict: ProofVerdict): 0 | 1 {
  return verdict.proven ? 0 : 1;
}
