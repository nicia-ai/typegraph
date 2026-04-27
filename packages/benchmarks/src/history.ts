import { execSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type PerfBackend, type PostgresDriver } from "./config";
import { type LatencyRecord } from "./measurements";

/**
 * Per-run append to `packages/benchmarks/reports/history.jsonl` so
 * trend analysis is a `grep`/`jq` away. One JSONL line per run.
 */
type HistoryEntry = Readonly<{
  timestamp: string;
  gitSha: string;
  gitRefName: string | undefined;
  backend: PerfBackend;
  postgresDriver?: PostgresDriver;
  scale: number;
  userCount: number;
  latencies: Readonly<
    Record<string, Readonly<{ median: number; p95: number }>>
  >;
}>;

function resolveGitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

function resolveGitRefName(): string | undefined {
  try {
    const ref = execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf-8",
    }).trim();
    return ref === "HEAD" ? undefined : ref;
  } catch {
    return undefined;
  }
}

function resolveHistoryPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/ -> ../reports/history.jsonl
  return join(here, "..", "reports", "history.jsonl");
}

function serializeLatencies(record: LatencyRecord): HistoryEntry["latencies"] {
  const out: Record<string, { median: number; p95: number }> = {};
  for (const [label, sample] of record) {
    out[label] = {
      median: Number(sample.median.toFixed(3)),
      p95: Number(sample.p95.toFixed(3)),
    };
  }
  return out;
}

type WriteHistoryInput = Readonly<{
  backend: PerfBackend;
  postgresDriver?: PostgresDriver;
  scale: number;
  userCount: number;
  latencies: LatencyRecord;
}>;

export function writeHistoryEntry(input: WriteHistoryInput): string {
  const entry: HistoryEntry = {
    timestamp: new Date().toISOString(),
    gitSha: resolveGitSha(),
    gitRefName: resolveGitRefName(),
    backend: input.backend,
    ...(input.postgresDriver === undefined ?
      {}
    : { postgresDriver: input.postgresDriver }),
    scale: input.scale,
    userCount: input.userCount,
    latencies: serializeLatencies(input.latencies),
  };
  const path = resolveHistoryPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf-8");
  return path;
}
