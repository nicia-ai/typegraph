import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { writeJsonFile } from "../real/harness/process";
import { type LaneBackend } from "./lanes";
import { type BaselineId } from "./policy";
import {
  type LaneComparison,
  type MeasurementComparison,
  type RegressionReport,
} from "./compare";

/**
 * The single owner of the per-backend report layout decision: a
 * multi-backend run (`backendCount > 1`) nests each backend's report under
 * its own subdirectory named for the backend; a single-backend run writes
 * directly to `outputDir`. Shared by the local writer
 * (`regression-bench.ts`'s `main`) and the EC2 remote-artifact fetcher
 * (`regression/ec2/remote-scripts.ts`'s `remoteReportPaths`) so neither can
 * independently re-derive — and drift from — this layout.
 */
export function resolveBackendReportDir(
  outputDir: string,
  backendCount: number,
  backend: LaneBackend | undefined,
): string {
  if (backendCount > 1) {
    return path.join(outputDir, backend ?? "unknown");
  }
  return outputDir;
}

function formatOptionalMs(value: number | undefined): string {
  return value === undefined ? "—" : value.toFixed(3);
}

function formatOptionalRatio(value: number | undefined): string {
  if (value === undefined) return "—";
  return Number.isFinite(value) ? `${value.toFixed(2)}x` : "∞";
}

function renderLaneSection(lane: LaneComparison): readonly string[] {
  const lines: string[] = [`### ${lane.laneId} vs ${lane.baseline}`, ""];
  if (lane.kind === "incomparable") {
    lines.push(`**Incomparable:** ${lane.reason}`, "");
    return lines;
  }
  if (lane.kind === "unrunnable") {
    lines.push(`**Unrunnable:** ${lane.reason}`, "");
    return lines;
  }

  lines.push(
    "| Lane | Measurement | Baseline | baseline ms | candidate ms | ratio | classification |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const comparison of lane.comparisons) {
    lines.push(
      `| ${comparison.laneId} | ${comparison.label} | ${comparison.baseline} | ` +
        `${formatOptionalMs(comparison.baselineMs)} | ${formatOptionalMs(comparison.candidateMs)} | ` +
        `${formatOptionalRatio(comparison.ratio)} | ${comparison.classification} |`,
    );
  }
  lines.push("");
  return lines;
}

function collectAppliedAcceptances(
  lanes: readonly LaneComparison[],
): readonly MeasurementComparison[] {
  return lanes.flatMap((lane) =>
    lane.kind === "compared" ?
      lane.comparisons.filter(
        (comparison) => comparison.classification === "accepted",
      )
    : [],
  );
}

/**
 * Renders the markdown report: per-lane tables, the resolved SHA of every
 * worktree, the policy in force, and every applied acceptance with its
 * reason.
 */
export function renderMarkdownReport(report: RegressionReport): string {
  const lines: string[] = [];
  lines.push("# Performance regression report", "");
  lines.push(`Generated: ${report.generatedAt}`, "");
  lines.push(`Backends: ${report.backends.join(", ")}`, "");

  lines.push("## Worktrees", "");
  lines.push("| Point | Ref | SHA |", "| --- | --- | --- |");
  lines.push(
    `| candidate | ${report.candidate.ref} | ${report.candidate.sha} |`,
  );
  for (const baseline of report.baselines) {
    lines.push(`| ${baseline.id} | ${baseline.ref} | ${baseline.sha} |`);
  }
  lines.push("");

  lines.push("## Policy", "");
  lines.push(`- flagRatio: ${report.policy.flagRatio}`);
  lines.push(`- failRatio: ${report.policy.failRatio}`);
  lines.push(`- minAbsoluteDeltaMs: ${report.policy.minAbsoluteDeltaMs}`);
  lines.push("");
  if (report.policy.accepted.length > 0) {
    lines.push("### Configured acceptances", "");
    for (const acceptance of report.policy.accepted) {
      lines.push(
        `- ${acceptance.laneId} / ${acceptance.label} (${acceptance.baseline}, ` +
          `max ${acceptance.maxRatio}x): ${acceptance.reason}` +
          `${acceptance.issue === undefined ? "" : ` (${acceptance.issue})`}`,
      );
    }
    lines.push("");
  }

  lines.push("## Lanes", "");
  for (const lane of report.lanes) {
    lines.push(...renderLaneSection(lane));
  }

  const appliedAcceptances = collectAppliedAcceptances(report.lanes);
  lines.push("## Applied acceptances", "");
  if (appliedAcceptances.length === 0) {
    lines.push("None.", "");
  } else {
    for (const comparison of appliedAcceptances) {
      lines.push(
        `- ${comparison.laneId} / ${comparison.label} (${comparison.baseline}): ${comparison.note ?? ""}`,
      );
    }
    lines.push("");
  }

  if (report.staleAcceptances.length > 0) {
    lines.push("## Stale acceptances", "");
    for (const acceptance of report.staleAcceptances) {
      lines.push(
        `- ${acceptance.laneId} / ${acceptance.label} (${acceptance.baseline}): ` +
          "no observed run matched this acceptance.",
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

type JsonLaneComparison = LaneComparison;

type JsonRegressionReport = Readonly<{
  generatedAt: string;
  candidate: RegressionReport["candidate"];
  baselines: RegressionReport["baselines"];
  backends: RegressionReport["backends"];
  policy: RegressionReport["policy"];
  lanes: Readonly<
    Record<string, Readonly<Partial<Record<BaselineId, JsonLaneComparison>>>>
  >;
  staleAcceptances: RegressionReport["staleAcceptances"];
  hardFailures: RegressionReport["hardFailures"];
  flags: RegressionReport["flags"];
}>;

/**
 * JSON is nested by lane id, then baseline (I6) — never flattened into a
 * joined string key such as `"perf:tag"`.
 */
function toJsonReport(report: RegressionReport): JsonRegressionReport {
  const lanes: Record<string, Partial<Record<BaselineId, LaneComparison>>> = {};
  for (const lane of report.lanes) {
    lanes[lane.laneId] ??= {};
    lanes[lane.laneId]![lane.baseline] = lane;
  }
  return {
    generatedAt: report.generatedAt,
    candidate: report.candidate,
    baselines: report.baselines,
    backends: report.backends,
    policy: report.policy,
    lanes,
    staleAcceptances: report.staleAcceptances,
    hardFailures: report.hardFailures,
    flags: report.flags,
  };
}

export type RegressionReportPaths = Readonly<{
  markdownPath: string;
  jsonPath: string;
}>;

export async function writeRegressionReport(
  outputDir: string,
  report: RegressionReport,
): Promise<RegressionReportPaths> {
  await mkdir(outputDir, { recursive: true });
  const markdownPath = path.join(outputDir, "report.md");
  const jsonPath = path.join(outputDir, "report.json");
  await writeFile(markdownPath, renderMarkdownReport(report), "utf-8");
  await writeJsonFile(jsonPath, toJsonReport(report));
  return { markdownPath, jsonPath };
}

/**
 * Writes one backend's already-rendered report text (fetched verbatim from
 * a remote run rather than assembled from a `RegressionReport`) to its
 * resolved per-backend directory. Routes through `resolveBackendReportDir`
 * so the EC2 collector's local write can never independently re-derive —
 * and drift from — the same layout decision `writeRegressionReport` and
 * `remoteReportPaths` use.
 */
export async function writeFetchedBackendReport(
  outputDir: string,
  backendCount: number,
  backend: LaneBackend,
  markdown: string,
  json: string,
): Promise<RegressionReportPaths> {
  const backendDir = resolveBackendReportDir(outputDir, backendCount, backend);
  await mkdir(backendDir, { recursive: true });
  const markdownPath = path.join(backendDir, "report.md");
  const jsonPath = path.join(backendDir, "report.json");
  await writeFile(markdownPath, markdown, "utf-8");
  await writeFile(jsonPath, json, "utf-8");
  return { markdownPath, jsonPath };
}
