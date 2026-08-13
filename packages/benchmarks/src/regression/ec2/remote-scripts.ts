/**
 * SSM command scripts for the regression-lane EC2 runner's `run` step: how
 * `bench:regression` is invoked on the remote instance, where its reports
 * land, and how those reports are fetched back. `remoteReportPaths` derives
 * its layout from `resolveBackendReportDir` (`../report.ts`) — the same
 * function the local writer in `regression-bench.ts` uses — so the remote
 * fetcher and the local writer can never disagree on where a backend's
 * report lives.
 */
import path from "node:path";

import { renderExitCodeCapture } from "../../real/ec2/ssm-run";
import { type LaneBackend } from "../lanes";
import { resolveBackendReportDir } from "../report";
import { REMOTE_POSTGRES_URL } from "./bootstrap";

export const REMOTE_OUTPUT_DIR = "/root/typegraph-regression-report";
export const REMOTE_NODE_OPTIONS = "--max-old-space-size=8192";
export const REMOTE_RUN_LOG_PATH = "/var/log/typegraph-regression.log";

export type RemoteRunOptions = Readonly<{
  backends: readonly LaneBackend[];
  laneIds: readonly string[] | undefined;
  baseRef: string | undefined;
  tagRef: string | undefined;
  featureBaselineRef: string | undefined;
  laneTimeoutMs: number;
}>;

function backendFlagValue(backends: readonly LaneBackend[]): string {
  if (backends.length === 2) {
    return "both";
  }
  const [backend] = backends;
  if (backend === undefined) {
    throw new Error("renderRegressionRunScript requires at least one backend.");
  }
  return backend;
}

/**
 * Renders the SSM command that runs `pnpm bench:regression` on the remote
 * instance, logging to `REMOTE_RUN_LOG_PATH` and reporting its exit code
 * through the one shared marker convention (`renderExitCodeCapture` /
 * `extractExitCode`, `real/ec2/ssm-run.ts`). An undefined baseline option
 * (`baseRef`/`tagRef`/`featureBaselineRef`) is omitted entirely — never
 * emitted as an empty `--flag=`, which `bench:regression`'s own CLI would
 * read as an explicit (and wrong) empty-string ref.
 */
export function renderRegressionRunScript(options: RemoteRunOptions): string {
  const wantsPostgres = options.backends.includes("postgres");

  const flags: readonly (string | undefined)[] = [
    `--backend=${backendFlagValue(options.backends)}`,
    `--output=${REMOTE_OUTPUT_DIR}`,
    `--lane-timeout-ms=${options.laneTimeoutMs}`,
    options.laneIds === undefined ?
      undefined
    : `--lanes=${options.laneIds.join(",")}`,
    options.baseRef === undefined ? undefined : `--base=${options.baseRef}`,
    options.tagRef === undefined ? undefined : `--tag=${options.tagRef}`,
    options.featureBaselineRef === undefined ?
      undefined
    : `--feature-baseline=${options.featureBaselineRef}`,
  ];
  const definedFlags = flags.filter(
    (flag): flag is string => flag !== undefined,
  );

  return renderExitCodeCapture({
    preamble: [
      "cd /opt/typegraph/packages/benchmarks",
      `export NODE_OPTIONS="${REMOTE_NODE_OPTIONS}"`,
      ...(wantsPostgres ?
        [`export POSTGRES_URL="${REMOTE_POSTGRES_URL}"`]
      : []),
    ],
    command: `pnpm bench:regression ${definedFlags.join(" ")} > ${REMOTE_RUN_LOG_PATH} 2>&1`,
  });
}

export type RemoteReportPaths = Readonly<{
  backend: LaneBackend;
  markdownPath: string;
  jsonPath: string;
}>;

/**
 * The remote report paths `collect` fetches, one per requested backend.
 * Derived from `resolveBackendReportDir` — the same layout decision the
 * local writer in `regression-bench.ts` uses — so a multi-backend run's
 * per-backend subdirectories are never independently re-derived here.
 */
export function remoteReportPaths(
  backends: readonly LaneBackend[],
): readonly RemoteReportPaths[] {
  return backends.map((backend) => {
    const dir = resolveBackendReportDir(
      REMOTE_OUTPUT_DIR,
      backends.length,
      backend,
    );
    return {
      backend,
      markdownPath: path.posix.join(dir, "report.md"),
      jsonPath: path.posix.join(dir, "report.json"),
    };
  });
}

/** Renders the SSM command that gzips + base64-encodes one remote file for transport. */
export function renderFetchCompressedScript(remotePath: string): string {
  return `gzip -c ${remotePath} | base64 -w0`;
}

/**
 * Renders the SSM command that tails the regression run's own console log
 * plus every per-(worktree, lane, backend) lane log
 * (`regression/run-lane.ts`'s `laneLogPath`) — failure diagnostics only,
 * printed by `collect` when the run's verdict is not clean.
 */
export function renderLaneLogTailScript(): string {
  return `echo "--- ${REMOTE_RUN_LOG_PATH} (tail) ---"
tail -n 200 ${REMOTE_RUN_LOG_PATH} 2>/dev/null || true
echo "--- lane logs (tail) ---"
for f in /opt/typegraph/packages/benchmarks/reports/regression/logs/*.log; do
  echo "=== $f ==="
  tail -n 100 "$f" 2>/dev/null || true
done`;
}
