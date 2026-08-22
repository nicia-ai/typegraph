/**
 * SSM Run Command plumbing shared by every EC2 runner: polling a command to
 * a terminal status, tailing a small remote script's stdout, and — the one
 * owner AGENTS.md's "one predicate, one owner" rule requires — how a
 * remote command's exit code is embedded in and extracted from that
 * stdout. `run-sf1-ec2.ts` (the SNB runner) and
 * `../../regression-ec2.ts` (the regression-lane runner) both build their
 * "run the real command" script through `renderExitCodeCapture` and both
 * read its result back through `extractExitCode` — a second, differently
 * spelled marker pair in either runner would silently drift from this one.
 */
import { stringifyError } from "../harness/process";
import {
  type AwsCliOptions,
  type CommandInvocation,
  getCommandInvocation,
  sendShellCommand,
  TERMINAL_COMMAND_STATUSES,
} from "./aws-cli";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries `check()` until it returns true or `timeoutMs` elapses. A thrown
 * error from `check()` is treated as "not ready yet" rather than a fatal
 * failure — `describeInstanceState` right after `run-instances` reliably
 * hits AWS's own eventual-consistency window (`InvalidInstanceID.NotFound`
 * for an instance id the API itself just returned), and propagating that
 * immediately killed the whole launch instead of retrying a few seconds
 * later like everything else in this poll loop already does. The last error
 * is surfaced in the timeout message so a genuine, persistent failure (bad
 * credentials, wrong region) is still diagnosable instead of silently
 * retrying to a generic timeout.
 */
export async function waitUntil(
  description: string,
  intervalMs: number,
  timeoutMs: number,
  check: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      if (await check()) return;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const suffix =
        lastError === undefined ? "" : (
          ` (last error: ${stringifyError(lastError)})`
        );
      throw new Error(`Timed out waiting for: ${description}${suffix}`);
    }
    await sleep(intervalMs);
  }
}

/** Polls an SSM command invocation until it reaches a terminal status. */
export async function pollCommand(
  awsOptions: AwsCliOptions,
  instanceId: string,
  commandId: string,
  intervalMs: number,
  timeoutSeconds: number,
): Promise<CommandInvocation> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const invocation = await getCommandInvocation(
      awsOptions,
      instanceId,
      commandId,
    );
    if (TERMINAL_COMMAND_STATUSES.includes(invocation.status)) {
      return invocation;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for SSM command ${commandId} on ${instanceId}.`,
      );
    }
    await sleep(intervalMs);
  }
}

/** Runs a short shell command via SSM and returns its stdout, trimmed. */
export async function fetchRemoteText(
  awsOptions: AwsCliOptions,
  instanceId: string,
  script: string,
  timeoutSeconds = 60,
): Promise<string> {
  const commandId = await sendShellCommand(awsOptions, instanceId, script, {
    timeoutSeconds,
  });
  const result = await pollCommand(
    awsOptions,
    instanceId,
    commandId,
    2_000,
    timeoutSeconds + 30,
  );
  return result.stdout.trim();
}

/**
 * The single spelling of the markers a remote exit-code capture writes
 * around the numeric exit code, and that `extractExitCode` reads back.
 */
export const EXIT_CODE_MARKER: Readonly<{ start: string; end: string }> = {
  start: "===EXIT_CODE_START===",
  end: "===EXIT_CODE_END===",
};

export type RenderExitCodeCaptureInput = Readonly<{
  /** Lines run before `command`, e.g. `cd` and `export` statements. */
  preamble?: readonly string[];
  command: string;
}>;

/**
 * Renders a script that runs `command`, captures its exit code, prints it
 * between `EXIT_CODE_MARKER`'s start/end lines, and re-exits with that same
 * code — so the *shell script's own* exit status (which SSM turns into
 * `Success`/`Failed`) matches the wrapped command's, while the marker gives
 * `extractExitCode` a value to read back even when SSM's own status is
 * ambiguous (see `judgeRemoteRun` in `regression/ec2/collect-verdict.ts` for
 * why both are needed). `set +e` keeps a nonzero `command` from aborting the
 * script before the markers are written.
 */
export function renderExitCodeCapture(
  input: RenderExitCodeCaptureInput,
): string {
  const preambleLines = input.preamble ?? [];
  return `#!/bin/bash
set +e
${[...preambleLines, input.command].join("\n")}
EXIT_CODE=$?
echo "${EXIT_CODE_MARKER.start}"
echo $EXIT_CODE
echo "${EXIT_CODE_MARKER.end}"
exit $EXIT_CODE
`;
}

/**
 * Extracts the integer exit code written between `EXIT_CODE_MARKER`'s
 * start/end lines. Returns `undefined` — never `0` — when either marker is
 * missing or the payload between them is not an integer: truncated or
 * killed stdout (SSM's `StandardOutputContent` cap, a command that never
 * reached the marker lines) must never read as a clean exit.
 */
export function extractExitCode(stdout: string): number | undefined {
  const startIndex = stdout.indexOf(EXIT_CODE_MARKER.start);
  const endIndex = stdout.indexOf(EXIT_CODE_MARKER.end);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    return undefined;
  }
  const payload = stdout
    .slice(startIndex + EXIT_CODE_MARKER.start.length, endIndex)
    .trim();
  if (!/^-?\d+$/.test(payload)) {
    return undefined;
  }
  return Number.parseInt(payload, 10);
}
