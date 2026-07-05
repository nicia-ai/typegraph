import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type PerfBackend,
  type PostgresDriver,
  type SqliteStorage,
} from "./config";
import { resolveGitRefName, resolveGitSha } from "./git";
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
  /** SQLite lanes only. Rows written before this field existed are "memory". */
  sqliteStorage?: SqliteStorage;
  scale: number;
  userCount: number;
  latencies: Readonly<
    Record<string, Readonly<{ median: number; p95: number }>>
  >;
}>;

/**
 * Absolute path to the shared `packages/benchmarks/reports/history.jsonl`
 * append log. Every lane (the original synthetic perf suite, and the
 * real-workload lanes under `src/real/`) appends to this one file.
 */
export function resolveHistoryPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/ -> ../reports/history.jsonl
  return join(here, "..", "reports", "history.jsonl");
}

/** Appends one JSONL line to `history.jsonl`, creating the directory if needed. */
export function appendHistoryLine(
  entry: Readonly<Record<string, unknown>>,
): string {
  const path = resolveHistoryPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf-8");
  return path;
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
  sqliteStorage?: SqliteStorage;
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
    ...(input.sqliteStorage === undefined ?
      {}
    : { sqliteStorage: input.sqliteStorage }),
    scale: input.scale,
    userCount: input.userCount,
    latencies: serializeLatencies(input.latencies),
  };
  return appendHistoryLine(entry);
}
