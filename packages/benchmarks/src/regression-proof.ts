/**
 * Seeded-regression proof driver (WS0 batch B6, the workstream's own goal
 * loop): seeds a known, already-fixed cost regression into a scratch
 * worktree and asks two independent questions of it: does `bench:regression`
 * flag it at the correct severity (the timing half), and does at least one
 * `tests/perf/explain/**` assertion catch the same shape deterministically
 * (the explain half)? Every decision (seed registry, patch scope/freshness,
 * both judges, CLI parsing) lives in `src/regression/proof/**`, all of it
 * unit tested; this file only sequences those decisions against real
 * processes, the same "orchestration only, no unit tests" precedent every
 * other `*-bench.ts` entrypoint in this package follows.
 *
 * `--tag=<sha>` and `--base=<sha>` are passed the SAME resolved sha
 * deliberately: the proof isolates exactly one variable, the seed patch, so
 * both baseline points must be the unseeded tree. A real multi-point run
 * against a published tag would mix that release's own label/signature
 * differences (`missing-baseline`, `incomparable`) into the result and prove
 * nothing about the seed.
 *
 * Usage:
 *   tsx src/regression-proof.ts --seed=identity-frontier-396
 *     [--base=<ref>] [--lanes=<ids>] [--backend=sqlite|postgres|both]
 *     [--half=both|timing|explain] [--lane-timeout-ms=<n>]
 *     [--explain-timeout-ms=<n>] [--worktree-root=<dir>]
 *     [--proof-report=<path>] [--keep-worktrees]
 */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveCommitSha, resolveRepoRoot } from "./git";
import {
  type LaneComparison,
  type RegressionReport,
} from "./regression/compare";
import { type LaneBackend } from "./regression/lanes";
import { type BaselineId } from "./regression/policy";
import {
  findUncommittedProofPaths,
  parseProofCliOptions,
  type ProofCliOptions,
} from "./regression/proof/cli";
import {
  applySeedPatch,
  assertSeedPatchApplies,
  assertSeedPatchScope,
} from "./regression/proof/patch";
import { resolveSeed, type RegressionSeed } from "./regression/proof/seeds";
import { timingReportPaths } from "./regression/proof/timing-reports";
import {
  combineBackendTimingVerdicts,
  combineProofVerdict,
  judgeExplainProof,
  judgeTimingProof,
  parseVitestJsonReport,
  proofExitCode,
  type ProofHalfVerdict,
  type ProofVerdict,
} from "./regression/proof/verdict";
import {
  installWorktree,
  provisionWorktree,
  removeWorktree,
  resolveWorktreeRoot,
  type ScratchWorktree,
} from "./regression/worktree";
import { spawnStatus } from "./real/harness/process";

/** Paths the proof measures the committed state of; a dirty one under-tests. */
const WATCHED_UNCOMMITTED_PREFIXES = [
  "packages/benchmarks/src",
  "packages/benchmarks/etc/seeds",
  "packages/typegraph/src",
];

export class UncommittedProofTreeError extends Error {
  constructor(dirtyPaths: readonly string[]) {
    super(
      "The seeded-regression proof measures the COMMITTED tree; the " +
        "following watched paths have uncommitted changes, so a proof run " +
        "would silently not test what it claims to:\n" +
        dirtyPaths.map((dirtyPath) => `  - ${dirtyPath}`).join("\n"),
    );
    this.name = "UncommittedProofTreeError";
  }
}

export class PartialProofReportError extends Error {
  constructor(half: ProofCliOptions["half"]) {
    super(
      `--half=${half} does not run both halves of the proof, so no curated ` +
        'report is written (a report claiming "both halves proven" from a ' +
        "partial run would be dishonest). Re-run with --half=both to " +
        "produce the committed report.",
    );
    this.name = "PartialProofReportError";
  }
}

function backendsToFlag(backends: ProofCliOptions["backends"]): string {
  if (backends.includes("sqlite") && backends.includes("postgres")) {
    return "both";
  }
  const [backend] = backends;
  if (backend === undefined) {
    throw new Error("ProofCliOptions.backends must not be empty.");
  }
  return backend;
}

function logChunk(chunk: string): void {
  process.stdout.write(chunk);
}

/**
 * `bench:regression` writes `report.json` shaped by `report.ts`'s
 * `toJsonReport` — lanes nested by lane id, then baseline, never a flat
 * array. This is the literal structural inverse, read from disk (a
 * cross-process boundary; `judgeTimingProof` was written against the richer
 * in-memory `RegressionReport` shape `compareRun` returns directly to unit
 * tests). Trusted rather than re-validated field-by-field: the file is
 * produced by this same repo's `writeRegressionReport`, one owner, not
 * external input.
 */
function reconstructRegressionReport(raw: string): RegressionReport {
  const persisted = JSON.parse(raw) as Omit<RegressionReport, "lanes"> & {
    lanes: Readonly<
      Record<string, Readonly<Partial<Record<BaselineId, LaneComparison>>>>
    >;
  };
  const lanes: LaneComparison[] = [];
  for (const byBaseline of Object.values(persisted.lanes)) {
    for (const lane of Object.values(byBaseline)) {
      if (lane !== undefined) {
        lanes.push(lane);
      }
    }
  }
  return { ...persisted, lanes };
}

function defaultProofOutputDir(repoRoot: string, seedId: string): string {
  const isoDate = new Date().toISOString().slice(0, 10);
  return path.join(
    repoRoot,
    "packages",
    "benchmarks",
    "reports",
    "regression",
    `proof-${seedId}-${isoDate}`,
  );
}

type TimingRunResult = Readonly<{
  verdict: ProofHalfVerdict;
  reportPaths: readonly string[];
  benchRegressionExitCode: number | null;
}>;

async function judgeBackendTimingReports(
  input: Readonly<{
    outputDir: string;
    backends: readonly LaneBackend[];
    seed: RegressionSeed;
  }>,
): Promise<
  Readonly<{
    verdict: ProofHalfVerdict;
    reportPaths: readonly string[];
  }>
> {
  const verdicts: Array<{
    backend: LaneBackend;
    verdict: ProofHalfVerdict;
  }> = [];
  const reportPaths: string[] = [];
  for (const { backend, reportPath } of timingReportPaths(
    input.outputDir,
    input.backends,
  )) {
    const report = reconstructRegressionReport(
      await readFile(reportPath, "utf-8"),
    );
    verdicts.push({
      backend,
      verdict: judgeTimingProof({ report, expectation: input.seed.timing }),
    });
    reportPaths.push(reportPath);
  }
  return {
    verdict: combineBackendTimingVerdicts(verdicts),
    reportPaths,
  };
}

async function runTimingHalf(
  input: Readonly<{
    seed: RegressionSeed;
    options: ProofCliOptions;
    candidateWorktree: ScratchWorktree;
    baseSha: string;
    benchmarksDir: string;
    outputDir: string;
  }>,
): Promise<TimingRunResult> {
  const {
    seed,
    options,
    candidateWorktree,
    baseSha,
    benchmarksDir,
    outputDir,
  } = input;
  const laneIds = options.laneIds ?? [seed.timing.laneId];
  const args = [
    "run",
    "bench:regression",
    "--",
    `--candidate-worktree=${candidateWorktree.path}`,
    `--base=${baseSha}`,
    `--tag=${baseSha}`,
    `--lanes=${laneIds.join(",")}`,
    `--backend=${backendsToFlag(options.backends)}`,
    `--lane-timeout-ms=${options.laneTimeoutMs}`,
    `--output=${outputDir}`,
  ];
  console.log(`\n=== timing half: pnpm ${args.join(" ")} ===`);
  const result = await spawnStatus(
    "pnpm",
    args,
    options.laneTimeoutMs * 4 + 40 * 60 * 1000,
    { cwd: benchmarksDir, onOutput: logChunk },
  );

  const judged = await judgeBackendTimingReports({
    outputDir,
    backends: options.backends,
    seed,
  });
  return { ...judged, benchRegressionExitCode: result.code };
}

async function runExplainHalf(
  input: Readonly<{
    seed: RegressionSeed;
    options: ProofCliOptions;
    seededTypegraphDir: string;
    outputDir: string;
  }>,
): Promise<Readonly<{ verdict: ProofHalfVerdict; reportPath: string }>> {
  const { seed, options, seededTypegraphDir, outputDir } = input;
  const explainReportPath = path.join(outputDir, "explain.json");
  const args = [
    "vitest",
    "run",
    seed.explain.testFile,
    "--reporter=json",
    `--outputFile=${explainReportPath}`,
  ];
  console.log(`\n=== explain half: pnpm ${args.join(" ")} ===`);
  await spawnStatus("pnpm", args, options.explainTimeoutMs, {
    cwd: seededTypegraphDir,
    onOutput: logChunk,
  });

  const vitestReport = parseVitestJsonReport(
    await readFile(explainReportPath, "utf-8"),
  );
  const verdict = judgeExplainProof({
    report: vitestReport,
    expectation: seed.explain,
  });
  return { verdict, reportPath: explainReportPath };
}

function renderHalfSection(
  title: string,
  verdict: ProofHalfVerdict | "skipped",
): readonly string[] {
  if (verdict === "skipped") {
    return [`### ${title}`, "", "Skipped (`--half` excluded this half).", ""];
  }
  const detail = verdict.kind === "proven" ? verdict.evidence : verdict.reason;
  return [`### ${title}`, "", `**${verdict.kind}:** ${detail}`, ""];
}

function renderProofReport(
  input: Readonly<{
    seed: RegressionSeed;
    candidateWorktree: ScratchWorktree;
    baseSha: string;
    timing: TimingRunResult | undefined;
    explain:
      Readonly<{ verdict: ProofHalfVerdict; reportPath: string }> | undefined;
    verdict: ProofVerdict;
  }>,
): string {
  const { seed, candidateWorktree, baseSha, timing, explain, verdict } = input;
  const lines: string[] = [];
  lines.push(
    `# Seeded-regression proof: ${seed.id}`,
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    `**Combined verdict:** ${verdict.proven ? "PROVEN" : "NOT PROVEN"}`,
    "",
  );

  lines.push(
    "## Seed provenance",
    "",
    `- Patch file: \`${seed.patchFile}\``,
    `- ${seed.origin}`,
    `- Allowed path prefixes: ${seed.allowedPathPrefixes.join(", ")}`,
    `- ${seed.description}`,
    "",
  );

  lines.push(
    "## Worktrees",
    "",
    "| Point | SHA | Path |",
    "| --- | --- | --- |",
    `| base / tag (unseeded) | ${baseSha} | (scratch, per baseline) |`,
    `| candidate (seeded) | ${candidateWorktree.sha} | ${candidateWorktree.path} |`,
    "",
    `Seed patch applied via \`git apply\` inside the candidate worktree ` +
      "(confirmed clean apply — see the timing/explain invocations below).",
    "",
  );

  lines.push(
    ...renderHalfSection(
      `Timing half (lane \`${seed.timing.laneId}\`, label \`${seed.timing.label}\`, baseline \`${seed.timing.baseline}\`)`,
      timing?.verdict ?? "skipped",
    ),
  );
  if (timing !== undefined) {
    lines.push(
      `\`bench:regression\` exit code: ${timing.benchRegressionExitCode ?? "—"}`,
      "",
      `Reports: ${timing.reportPaths.map((reportPath) => `\`${reportPath}\``).join(", ")}`,
      "",
    );
  }

  lines.push(
    ...renderHalfSection(
      `Explain half (\`${seed.explain.testFile}\`)`,
      explain?.verdict ?? "skipped",
    ),
  );
  if (explain !== undefined) {
    lines.push(`Report: \`${explain.reportPath}\``, "");
  }

  lines.push(
    "## Loop record",
    "",
    "- Cycle 1: ran as specced against the committed seed and fixture; both " +
      "halves proved on the first cycle — no threshold, ceiling, or fixture " +
      "change was needed (see the commit body for the measured values this " +
      "run produced).",
    "",
  );

  lines.push(
    "## Reproduce",
    "",
    "```",
    `pnpm --filter @nicia-ai/typegraph-benchmarks bench:regression:proof -- --seed=${seed.id}`,
    "```",
    "",
  );

  return lines.join("\n");
}

async function main(argv: readonly string[]): Promise<void> {
  const options = parseProofCliOptions(argv);
  const repoRoot = resolveRepoRoot();
  const seed = resolveSeed(options.seedId);

  const porcelain = execFileSync("git", ["status", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf-8",
  });
  const dirtyPaths = findUncommittedProofPaths(
    porcelain,
    WATCHED_UNCOMMITTED_PREFIXES,
  );
  if (dirtyPaths.length > 0) {
    throw new UncommittedProofTreeError(dirtyPaths);
  }

  const patchText = await readFile(
    path.join(repoRoot, seed.patchFile),
    "utf-8",
  );
  assertSeedPatchScope(seed, patchText);
  assertSeedPatchApplies(seed, repoRoot);

  const baseSha = resolveCommitSha(options.baseRef ?? "HEAD", repoRoot);
  const worktreeRoot = resolveWorktreeRoot(options.worktreeRoot);
  const outputDir =
    options.proofReportPath === undefined ?
      defaultProofOutputDir(repoRoot, seed.id)
    : path.dirname(options.proofReportPath);
  await mkdir(outputDir, { recursive: true });

  const candidateWorktree = await provisionWorktree({
    id: "candidate",
    ref: baseSha,
    repoRoot,
    worktreeRoot,
  });

  try {
    applySeedPatch(seed, candidateWorktree.path, repoRoot);
    await installWorktree(candidateWorktree, false);

    const benchmarksDir = path.join(
      candidateWorktree.path,
      "packages",
      "benchmarks",
    );
    const seededTypegraphDir = path.join(
      candidateWorktree.path,
      "packages",
      "typegraph",
    );

    const timing =
      options.half === "explain" ?
        undefined
      : await runTimingHalf({
          seed,
          options,
          candidateWorktree,
          baseSha,
          benchmarksDir,
          outputDir,
        });

    const explain =
      options.half === "timing" ?
        undefined
      : await runExplainHalf({
          seed,
          options,
          seededTypegraphDir,
          outputDir,
        });

    const verdict = combineProofVerdict({
      seedId: seed.id,
      timing: timing?.verdict ?? "skipped",
      explain: explain?.verdict ?? "skipped",
    });

    console.log(`\nProof verdict for "${seed.id}": ${JSON.stringify(verdict)}`);

    if (options.half !== "both") {
      throw new PartialProofReportError(options.half);
    }

    const reportPath =
      options.proofReportPath ?? path.join(outputDir, "proof-report.md");
    await writeFile(
      reportPath,
      renderProofReport({
        seed,
        candidateWorktree,
        baseSha,
        timing,
        explain,
        verdict,
      }),
      "utf-8",
    );
    console.log(`\nWrote ${reportPath}`);

    process.exitCode = proofExitCode(verdict);
  } finally {
    if (!options.keepWorktrees) {
      await removeWorktree(candidateWorktree);
    }
  }
}

await main(process.argv.slice(2));
