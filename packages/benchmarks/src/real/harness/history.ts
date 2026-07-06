import { appendHistoryLine } from "../../history";
import { resolveGitRefName, resolveGitSha } from "../../git";
import { type LatencyStats } from "./stats";

/**
 * One JSONL line per (lane, engine) run, appended to the same
 * `packages/benchmarks/reports/history.jsonl` the original synthetic perf
 * suite writes to (docs/design/benchmark-program-plan.md, harness
 * requirement 5). Query labels are namespaced `snb:IS1`..`snb:IS7` so a
 * `grep`/`jq` over the file can separate lanes.
 */
type LaneHistoryEntry = Readonly<{
  timestamp: string;
  gitSha: string;
  gitRefName: string | undefined;
  lane: string;
  engine: string;
  profile: string;
  requestsPerQuery: number;
  loadMs: number;
  queries: Readonly<
    Record<
      string,
      Readonly<{
        medianMs: number;
        p95Ms: number;
        p99Ms: number;
        cvPercent: number;
        noisy: boolean;
        comparable: boolean;
      }>
    >
  >;
}>;

export type WriteLaneHistoryInput = Readonly<{
  lane: string;
  engine: string;
  profile: string;
  requestsPerQuery: number;
  loadMs: number;
  queries: ReadonlyMap<
    string,
    Readonly<{ stats: LatencyStats; comparable: boolean }>
  >;
}>;

export function writeLaneHistoryEntry(input: WriteLaneHistoryInput): string {
  const queries: Record<string, LaneHistoryEntry["queries"][string]> = {};
  for (const [label, { stats, comparable }] of input.queries) {
    queries[`${input.lane}:${label}`] = {
      medianMs: Number(stats.medianMs.toFixed(3)),
      p95Ms: Number(stats.p95Ms.toFixed(3)),
      p99Ms: Number(stats.p99Ms.toFixed(3)),
      cvPercent: Number(stats.cvPercent.toFixed(2)),
      noisy: stats.noisy,
      comparable,
    };
  }

  const entry: LaneHistoryEntry = {
    timestamp: new Date().toISOString(),
    gitSha: resolveGitSha(),
    gitRefName: resolveGitRefName(),
    lane: input.lane,
    engine: input.engine,
    profile: input.profile,
    requestsPerQuery: input.requestsPerQuery,
    loadMs: Number(input.loadMs.toFixed(1)),
    queries,
  };
  return appendHistoryLine(entry);
}
