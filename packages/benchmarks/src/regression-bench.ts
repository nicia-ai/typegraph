/**
 * Regression-mode entrypoint: provisions scratch worktrees for the last
 * published tag, the PR base, an optional feature baseline, and the
 * candidate; runs the selected lanes on each; diffs medians per the
 * threshold policy; writes a markdown + JSON report.
 *
 * Orchestration only — every decision (classification, comparability,
 * exit code) is owned by `regression/compare.ts` and `regression/policy.ts`.
 *
 * Usage:
 *   tsx src/regression-bench.ts [--candidate=<ref>|--candidate-worktree=<path>]
 *     [--base=<ref>] [--tag=<ref>] [--feature-baseline=<ref>] [--lanes=a,b]
 *     [--backend=sqlite|postgres|both] [--worktree-root=<dir>] [--output=<dir>]
 *     [--lane-timeout-ms=<n>] [--skip-install] [--keep-worktrees]
 */
import path from "node:path";

import { resolveGitRefName, resolveRepoRoot } from "./git";
import {
  resolveBaselinePlans,
  resolveCandidateShaForBaseline,
} from "./regression/baseline-plan";
import {
  parseRegressionCliOptions,
  type RegressionCliOptions,
} from "./regression/cli";
import {
  compareRun,
  reportExitCode,
  type RegressionReport,
} from "./regression/compare";
import {
  type LaneBackend,
  resolveLanes,
  type RegressionLane,
} from "./regression/lanes";
import {
  type BaselineId,
  DEFAULT_REGRESSION_POLICY,
} from "./regression/policy";
import { writeRegressionReport } from "./regression/report";
import { runLane, type LaneRunOutcome } from "./regression/run-lane";
import {
  installWorktree,
  provisionWorktree,
  removeWorktree,
  resolveWorktreeRoot,
  type ScratchWorktree,
} from "./regression/worktree";
import { getPostgresUrl } from "./config";

async function resolveCandidateWorktree(
  options: RegressionCliOptions,
  repoRoot: string,
  worktreeRoot: string,
): Promise<ScratchWorktree> {
  if (options.candidateRef !== undefined) {
    return provisionWorktree({
      id: "candidate",
      ref: options.candidateRef,
      repoRoot,
      worktreeRoot,
    });
  }
  const candidatePath = options.candidateWorktree ?? repoRoot;
  return {
    id: "candidate",
    ref: resolveGitRefName() ?? "HEAD",
    sha: resolveCandidateShaForBaseline(options, repoRoot),
    path: candidatePath,
    provisioned: false,
  };
}

function defaultOutputDir(repoRoot: string, candidateSha: string): string {
  const isoDate = new Date().toISOString().slice(0, 10);
  return path.join(
    repoRoot,
    "packages",
    "benchmarks",
    "reports",
    "regression",
    `${isoDate}-${candidateSha.slice(0, 7)}`,
  );
}

function printLaneSummary(report: RegressionReport): void {
  for (const lane of report.lanes) {
    if (lane.kind !== "compared") {
      console.log(
        `  [${lane.laneId} vs ${lane.baseline}] ${lane.kind}: ${lane.reason}`,
      );
      continue;
    }
    for (const comparison of lane.comparisons) {
      const ratioText =
        comparison.ratio === undefined ?
          "—"
        : `${comparison.ratio.toFixed(2)}x`;
      console.log(
        `  [${lane.laneId} vs ${lane.baseline}] ${comparison.label}: ` +
          `${comparison.baselineMs?.toFixed(3) ?? "—"}ms -> ${comparison.candidateMs?.toFixed(3) ?? "—"}ms ` +
          `(${ratioText}, ${comparison.classification})`,
      );
    }
  }
}

async function runBackendReport(
  input: Readonly<{
    backend: LaneBackend;
    lanes: readonly RegressionLane[];
    candidateWorktree: ScratchWorktree;
    baselineWorktrees: ReadonlyMap<BaselineId, ScratchWorktree>;
    laneTimeoutMs: number;
    postgresUrl: string | undefined;
    logDir: string;
  }>,
): Promise<RegressionReport> {
  const {
    backend,
    lanes,
    candidateWorktree,
    baselineWorktrees,
    laneTimeoutMs,
    postgresUrl,
    logDir,
  } = input;

  const candidateOutcomes: LaneRunOutcome[] = [];
  for (const lane of lanes) {
    candidateOutcomes.push(
      await runLane({
        lane,
        backend,
        worktree: candidateWorktree,
        timeoutMs: laneTimeoutMs,
        postgresUrl,
        logDir,
      }),
    );
  }

  const baselineOutcomes: LaneRunOutcome[] = [];
  for (const worktree of baselineWorktrees.values()) {
    for (const lane of lanes) {
      baselineOutcomes.push(
        await runLane({
          lane,
          backend,
          worktree,
          timeoutMs: laneTimeoutMs,
          postgresUrl,
          logDir,
        }),
      );
    }
  }

  return compareRun({
    candidate: candidateOutcomes,
    baselines: baselineOutcomes,
    policy: DEFAULT_REGRESSION_POLICY,
    candidateRef: {
      ref: candidateWorktree.ref,
      sha: candidateWorktree.sha,
      path: candidateWorktree.path,
    },
    baselineRefs: [...baselineWorktrees.entries()].map(([id, worktree]) => ({
      id,
      ref: worktree.ref,
      sha: worktree.sha,
    })),
    backends: [backend],
  });
}

async function main(argv: readonly string[]): Promise<void> {
  const options = parseRegressionCliOptions(argv);
  const repoRoot = resolveRepoRoot();
  const lanes = resolveLanes(options.laneIds);
  const worktreeRoot = resolveWorktreeRoot(options.worktreeRoot);
  const postgresUrl =
    options.backends.includes("postgres") ? getPostgresUrl() : undefined;

  const baselinePlans = resolveBaselinePlans(options, repoRoot);
  const cleanupTargets: ScratchWorktree[] = [];

  try {
    const baselineWorktrees = new Map<BaselineId, ScratchWorktree>();
    for (const plan of baselinePlans) {
      const worktree = await provisionWorktree({
        id: plan.id,
        ref: plan.ref,
        repoRoot,
        worktreeRoot,
      });
      await installWorktree(worktree, options.skipInstall);
      baselineWorktrees.set(plan.id, worktree);
      cleanupTargets.push(worktree);
    }

    const candidateWorktree = await resolveCandidateWorktree(
      options,
      repoRoot,
      worktreeRoot,
    );
    if (candidateWorktree.provisioned) {
      cleanupTargets.push(candidateWorktree);
    }
    await installWorktree(candidateWorktree, options.skipInstall);

    const logDir = path.join(
      repoRoot,
      "packages",
      "benchmarks",
      "reports",
      "regression",
      "logs",
    );

    const reports: RegressionReport[] = [];
    for (const backend of options.backends) {
      reports.push(
        await runBackendReport({
          backend,
          lanes,
          candidateWorktree,
          baselineWorktrees,
          laneTimeoutMs: options.laneTimeoutMs,
          postgresUrl,
          logDir,
        }),
      );
    }

    const [firstReport] = reports;
    if (firstReport === undefined) {
      throw new Error("No backends were selected; nothing to report.");
    }

    const outputDir =
      options.outputDir ??
      defaultOutputDir(repoRoot, firstReport.candidate.sha);

    let worstExitCode: 0 | 1 | 2 = 0;
    for (const report of reports) {
      const [backend] = report.backends;
      const perBackendDir =
        reports.length > 1 ?
          path.join(outputDir, backend ?? "unknown")
        : outputDir;
      const written = await writeRegressionReport(perBackendDir, report);
      console.log(`\n=== ${report.backends.join(", ")} ===`);
      printLaneSummary(report);
      console.log(`\nWrote ${written.markdownPath}\nWrote ${written.jsonPath}`);
      const exitCode = reportExitCode(report);
      worstExitCode = exitCode > worstExitCode ? exitCode : worstExitCode;
    }

    process.exitCode = worstExitCode;
  } finally {
    if (!options.keepWorktrees) {
      for (const worktree of cleanupTargets) {
        await removeWorktree(worktree);
      }
    }
  }
}

await main(process.argv.slice(2));
