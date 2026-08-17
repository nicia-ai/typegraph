import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  extractLaneMeasurements,
  historyFileSize,
  readHistoryTail,
  type ExtractedRun,
} from "./history-extract";
import { type LaneBackend, type RegressionLane } from "./lanes";
import { spawnStatus } from "../real/harness/process";
import { laneScriptExists, type ScratchWorktree } from "./worktree";

export type LaneRunOutcome =
  | Readonly<{
      kind: "measured";
      laneId: string;
      refId: string;
      sha: string;
      run: ExtractedRun;
      measurementSemantics?: RegressionLane["measurementSemantics"];
      durationMs: number;
    }>
  | Readonly<{
      kind: "unavailable";
      laneId: string;
      refId: string;
      sha: string;
      reason: string;
    }>
  | Readonly<{
      kind: "failed";
      laneId: string;
      refId: string;
      sha: string;
      reason: string;
      exitCode: number | null;
      timedOut: boolean;
    }>;

export type RunLaneInput = Readonly<{
  lane: RegressionLane;
  backend: LaneBackend;
  worktree: ScratchWorktree;
  timeoutMs: number;
  postgresUrl: string | undefined;
  logDir: string;
}>;

/**
 * The per-(worktree, lane, backend) log file path. Every dimension a run
 * can vary independently must appear in the filename: a `--backend=both`
 * invocation runs the same lane, in the same worktree, once per backend
 * (`main()` in `regression-bench.ts` loops backends over the same lanes and
 * worktrees) — omitting `backend` here would let the second backend's run
 * silently overwrite the first's log.
 */
export function laneLogPath(
  logDir: string,
  worktree: Readonly<Pick<ScratchWorktree, "id">>,
  lane: Readonly<Pick<RegressionLane, "id">>,
  backend: LaneBackend,
): string {
  return path.join(logDir, `${worktree.id}-${lane.id}-${backend}.log`);
}

/**
 * Runs one lane's pnpm script for one backend inside one worktree, then
 * extracts the measurements it appended to that worktree's
 * `reports/history.jsonl`. A missing script (I8) or a failed/timed-out
 * run (I9) is reported as such — never silently treated as "no regression".
 */
export async function runLane(input: RunLaneInput): Promise<LaneRunOutcome> {
  const { lane, backend, worktree, timeoutMs, postgresUrl, logDir } = input;
  const script = lane.scripts[backend];
  if (script === undefined) {
    return {
      kind: "unavailable",
      laneId: lane.id,
      refId: worktree.id,
      sha: worktree.sha,
      reason: `Lane "${lane.id}" has no ${backend} script.`,
    };
  }
  if (!laneScriptExists(worktree.path, script)) {
    return {
      kind: "unavailable",
      laneId: lane.id,
      refId: worktree.id,
      sha: worktree.sha,
      reason: `Script "${script}" is absent from ${worktree.path}/packages/benchmarks/package.json.`,
    };
  }

  const benchmarksDir = path.join(worktree.path, "packages", "benchmarks");
  const historyPath = path.join(benchmarksDir, "reports", "history.jsonl");
  const byteOffsetBefore = historyFileSize(historyPath);

  const outputChunks: string[] = [];
  const startedAt = Date.now();
  const result = await spawnStatus("pnpm", ["run", script], timeoutMs, {
    cwd: benchmarksDir,
    ...(postgresUrl === undefined ?
      {}
    : { env: { POSTGRES_URL: postgresUrl } }),
    onOutput: (chunk) => {
      outputChunks.push(chunk);
    },
  });
  const durationMs = Date.now() - startedAt;

  await mkdir(logDir, { recursive: true });
  await writeFile(
    laneLogPath(logDir, worktree, lane, backend),
    outputChunks.join(""),
    "utf-8",
  );

  if (result.timedOut || result.code !== 0) {
    return {
      kind: "failed",
      laneId: lane.id,
      refId: worktree.id,
      sha: worktree.sha,
      reason:
        result.timedOut ?
          `Lane "${lane.id}" (${worktree.id}) timed out after ${timeoutMs}ms.`
        : `Lane "${lane.id}" (${worktree.id}) exited with code ${result.code}.`,
      exitCode: result.code,
      timedOut: result.timedOut,
    };
  }

  const appendedLines = readHistoryTail(historyPath, byteOffsetBefore);
  let run: ExtractedRun;
  try {
    run = extractLaneMeasurements(appendedLines);
  } catch (error) {
    return {
      kind: "failed",
      laneId: lane.id,
      refId: worktree.id,
      sha: worktree.sha,
      reason:
        `Lane "${lane.id}" (${worktree.id}) exited successfully but did not ` +
        `produce usable benchmark measurements: ${error instanceof Error ? error.message : String(error)}`,
      exitCode: result.code,
      timedOut: false,
    };
  }
  return {
    kind: "measured",
    laneId: lane.id,
    refId: worktree.id,
    sha: worktree.sha,
    run,
    ...(lane.measurementSemantics === undefined ?
      {}
    : { measurementSemantics: lane.measurementSemantics }),
    durationMs,
  };
}
