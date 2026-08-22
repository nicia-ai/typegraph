/**
 * The single owner of "did this remote regression run succeed" for the EC2
 * lane — `collect`'s decision after polling an SSM command to a terminal
 * status and fetching whichever per-backend reports it could. Every rule
 * here exists to preserve one of the invariants a naive
 * `ssmStatus === "Success"` check would silently violate: a nonzero
 * `bench:regression` exit code (a real regression, not a broken run) makes
 * SSM itself report `Failed` (E4); a truncated or missing artifact must
 * never read as clean (E3).
 */
import { type CommandInvocationStatus } from "../../real/ec2/aws-cli";
import { type LaneBackend } from "../lanes";

export type CollectVerdictInput = Readonly<{
  ssmStatus: CommandInvocationStatus;
  remoteExitCode: number | undefined;
  requestedBackends: readonly LaneBackend[];
  fetchedBackends: readonly LaneBackend[];
}>;

export type RemoteRunVerdict = Readonly<{
  ok: boolean;
  exitCode: 0 | 1 | 2;
  reasons: readonly string[];
}>;

function toVerdict(
  exitCode: 0 | 1 | 2,
  reasons: readonly string[],
): RemoteRunVerdict {
  return { ok: exitCode === 0, exitCode, reasons };
}

/**
 * Judges a remote regression run. Rules, in order:
 *
 * 1. Any backend requested but not fetched is a hard failure (2) — the
 *    reason names the missing backend.
 * 2. No exit code could be read from the wrapped command's stdout (a
 *    truncated or absent artifact, `extractExitCode` returning
 *    `undefined`) is a hard failure (2).
 * 3. A remote exit code of 1 or 2 is read through as that code, **even
 *    when `ssmStatus` is `"Failed"`** — a nonzero `bench:regression` exit
 *    makes SSM report `Failed` for a run that measured a real regression,
 *    not one that broke.
 * 4. Any other non-`"Success"` SSM status (`TimedOut`, `Cancelled`, …) is a
 *    hard failure (2) — the run never got the chance to report its own
 *    verdict.
 * 5. `remoteExitCode === 0` and `ssmStatus === "Success"` is clean (0).
 * 6. Anything else (e.g. an exit code outside `0 | 1 | 2`) is a hard
 *    failure (2), never silently coerced.
 */
export function judgeRemoteRun(input: CollectVerdictInput): RemoteRunVerdict {
  const { ssmStatus, remoteExitCode, requestedBackends, fetchedBackends } =
    input;

  const fetchedSet = new Set(fetchedBackends);
  const missingBackends = requestedBackends.filter(
    (backend) => !fetchedSet.has(backend),
  );
  if (missingBackends.length > 0) {
    return toVerdict(
      2,
      missingBackends.map(
        (backend) => `No report was fetched for backend "${backend}".`,
      ),
    );
  }

  if (remoteExitCode === undefined) {
    return toVerdict(2, [
      "No exit code could be read from the remote run's stdout " +
        "(truncated or absent output).",
    ]);
  }

  if (remoteExitCode === 1 || remoteExitCode === 2) {
    return toVerdict(remoteExitCode, [
      `bench:regression exited ${remoteExitCode} on the remote instance ` +
        `(SSM status: ${ssmStatus}).`,
    ]);
  }

  if (ssmStatus !== "Success") {
    return toVerdict(2, [
      `SSM command status was "${ssmStatus}", not "Success".`,
    ]);
  }

  if (remoteExitCode === 0) {
    return toVerdict(0, []);
  }

  return toVerdict(2, [
    `Unexpected remote exit code ${remoteExitCode}; treating as a hard failure.`,
  ]);
}
