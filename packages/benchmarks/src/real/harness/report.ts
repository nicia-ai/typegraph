/**
 * `report.md` for one SNB run: a human-readable record of what was measured
 * (engine versions read from the running engines, where each ran, how it
 * loaded), the cross-engine parity verdict, and the latencies. Written next to
 * `results.json`/`summary.json`, which stay the machine-readable source.
 */
import { type EngineRuntimeVersion } from "../engines/types";
import { type LatencyStats } from "./stats";

export type ReportEngine = Readonly<{
  name: string;
  versions: readonly EngineRuntimeVersion[];
  target: string;
  loadPath: string;
  loadMs: number;
  unsupported: Readonly<Partial<Record<string, string>>>;
}>;

export type ReportQueryRow = Readonly<{
  queryId: string;
  /** Per engine that ran the query. */
  results: readonly Readonly<{ engine: string; stats: LatencyStats }>[];
  comparable: boolean;
  parityReason: string | undefined;
}>;

export type SnbReportInput = Readonly<{
  profile: string;
  generatedAt: string;
  typegraphVersion: string;
  gitSha: string;
  gitRefName: string | undefined;
  datasetRoot: string;
  requestsPerQuery: number;
  warmupRequests: number;
  seed: number;
  host: string;
  command: string;
  /** Engines requested but not run because the doctor found them unrunnable. */
  skippedEngines: readonly string[];
  engines: readonly ReportEngine[];
  failures: readonly Readonly<{ engine: string; error: string }>[];
  queries: readonly ReportQueryRow[];
}>;

/** A parity mismatch counts only when at least two engines ran the query. */
function isParityFailure(row: ReportQueryRow): boolean {
  return row.results.length >= 2 && !row.comparable;
}

/** Table cells cannot hold a raw pipe or newline. */
function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
}

function formatVersions(versions: readonly EngineRuntimeVersion[]): string {
  return versions
    .map(
      (version) =>
        `${version.component} ${version.version}${version.detail === undefined || version.detail === "" ? "" : ` (${version.detail})`}`,
    )
    .join("; ");
}

/** Milliseconds below ten seconds (smoke-scale loads), seconds above. */
function formatLoadTime(ms: number): string {
  return ms < 10_000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function formatLatency(stats: LatencyStats): string {
  const noisy = stats.noisy ? " (noisy)" : "";
  return `${stats.medianMs.toFixed(2)} / ${stats.p95Ms.toFixed(2)}${noisy}`;
}

/** The one-line outcome: what a reader must know before trusting a number. */
export function reportVerdict(input: SnbReportInput): string {
  const mismatches = input.queries.filter((row) => isParityFailure(row));
  const problems = [
    ...(mismatches.length > 0 ?
      [`parity FAILED on ${mismatches.map((row) => row.queryId).join(", ")}`]
    : []),
    ...(input.failures.length > 0 ?
      [
        `engine failures: ${input.failures.map((failure) => failure.engine).join(", ")}`,
      ]
    : []),
    ...(input.skippedEngines.length > 0 ?
      [`not run (doctor): ${input.skippedEngines.join(", ")}`]
    : []),
  ];
  return problems.length === 0 ?
      `parity OK across ${input.engines.length} engines`
    : problems.join("; ");
}

export function renderSnbReport(input: SnbReportInput): string {
  const engineNames = input.engines.map((engine) => engine.name);
  const lines: string[] = [
    `# LDBC SNB comparison: ${input.profile}`,
    "",
    `- Verdict: ${reportVerdict(input)}`,
    `- Generated: ${input.generatedAt}`,
    `- TypeGraph: ${input.typegraphVersion} at \`${input.gitSha}\`${input.gitRefName === undefined ? "" : ` (${input.gitRefName})`}`,
    `- Dataset: \`${input.datasetRoot}\``,
    `- Requests: ${input.requestsPerQuery} measured per query after ${input.warmupRequests} warm-up, seed ${input.seed}`,
    `- Host: ${input.host}`,
    `- Command: \`${input.command}\``,
    "",
    "## Engines",
    "",
    "Versions are read from each running engine, not taken from the pins. Load times are comparable only between engines and runs that used the same load path.",
    "",
    "| Engine | Versions | Target | Load path | Load time |",
    "| --- | --- | --- | --- | --- |",
    ...input.engines.map(
      (engine) =>
        `| ${cell(engine.name)} | ${cell(formatVersions(engine.versions))} | ${cell(engine.target)} | ${cell(engine.loadPath)} | ${formatLoadTime(engine.loadMs)} |`,
    ),
    "",
    "## Parity",
    "",
    "| Query | Engines that ran it | Comparable |",
    "| --- | --- | --- |",
    ...input.queries.map((row) => {
      const status =
        row.results.length === 0 ? "no engine ran it"
        : row.results.length === 1 ? "only one engine ran it"
        : row.comparable ? "yes"
        : `**no** (${row.parityReason ?? "parity mismatch"})`;
      return `| ${row.queryId} | ${row.results.length} | ${cell(status)} |`;
    }),
    "",
    "## Latency (p50 / p95 ms)",
    "",
    `| Query | ${engineNames.map((name) => cell(name)).join(" | ")} |`,
    `| --- | ${engineNames.map(() => "---").join(" | ")} |`,
    ...input.queries.map((row) => {
      const cells = input.engines.map((engine) => {
        const result = row.results.find(
          (entry) => entry.engine === engine.name,
        );
        if (result !== undefined) return formatLatency(result.stats);
        return engine.unsupported[row.queryId] === undefined ?
            "n/a"
          : "unsupported";
      });
      return `| ${row.queryId} | ${cells.join(" | ")} |`;
    }),
  ];

  const gaps = input.engines.flatMap((engine) =>
    Object.entries(engine.unsupported).map(
      ([queryId, reason]) => `- ${engine.name} / ${queryId}: ${reason ?? ""}`,
    ),
  );
  if (gaps.length > 0) {
    lines.push("", "## Capability gaps (declared unsupported)", "", ...gaps);
  }
  if (input.failures.length > 0) {
    lines.push(
      "",
      "## Engine failures",
      "",
      ...input.failures.map(
        (failure) => `- ${failure.engine}: ${cell(failure.error)}`,
      ),
    );
  }
  if (input.skippedEngines.length > 0) {
    lines.push(
      "",
      "## Not run",
      "",
      `The doctor found these requested engines unrunnable (see \`competitor-doctor.json\`): ${input.skippedEngines.join(", ")}.`,
    );
  }
  return `${lines.join("\n")}\n`;
}
