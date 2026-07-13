/**
 * Runs the existing, unmodified SNB Lane 1 benchmark (snb-short-reads.ts) on
 * a dedicated, ephemeral EC2 instance instead of the local machine — useful
 * when local hardware is contended (background backups, Docker Desktop
 * sharing memory/CPU with unrelated projects) or when a stable, reproducible
 * hardware profile matters more than convenience.
 *
 * Two subcommands, because a multi-hour SSM command shouldn't block a
 * foreground CLI invocation:
 *
 *   launch   Provisions the instance, waits for it to register with SSM,
 *            confirms bootstrap succeeded, then fires the (long) benchmark
 *            command in fire-and-forget mode and exits.
 *   collect  Polls the benchmark command until it finishes (with periodic
 *            log-tail heartbeats), writes results/summary locally, appends
 *            the new lines to reports/history.jsonl, and terminates the
 *            instance (unless --keep).
 *
 * SSM Session Manager / Run Command is the default and only required
 * control channel — no key pairs to manage. The launched instance's IAM
 * instance profile MUST have the AWS-managed `AmazonSSMManagedInstanceCore`
 * policy attached — see docs/ec2-benchmark-runner.md for the flags this
 * account uses and how to adapt them to a different AWS account.
 *
 * `--ssh-public-key-path` is an opt-in diagnostic fallback for when SSM
 * itself is the thing that's broken (see BootstrapOptions.sshPublicKey) —
 * the caller is responsible for opening/closing port 22 on the security
 * group around its use.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveGitSha } from "../../git";
import { resolveHistoryPath } from "../../history";
import { stringifyError, writeJsonFile } from "../harness/process";
import {
  type AwsCliOptions,
  describeInstanceState,
  getCommandInvocation,
  isSsmOnline,
  resolveUbuntu2404Ami,
  runInstance,
  sendShellCommand,
  terminateInstance,
  TERMINAL_COMMAND_STATUSES,
} from "./aws-cli";
import {
  BOOTSTRAP_COMPLETE_SENTINEL,
  BOOTSTRAP_FAILED_SENTINEL,
  BOOTSTRAP_LOG_PATH,
  renderBootstrapScript,
  REPO_DIR,
} from "./bootstrap-script";

// Profile-aware: SF10's load phase consumes memory proportional to
// available RAM, not a fixed budget (see reports/snb-lane1-results.md's
// "memory exhaustion, not networking" section) — four EC2 attempts on
// c7i.4xlarge (32GB) died from exactly this before r7i.4xlarge (128GB,
// same 16 vCPU) completed cleanly. Defaulting sf10 to c7i.4xlarge would
// silently reproduce that failure for anyone who doesn't already know to
// override --instance-type.
const DEFAULT_INSTANCE_TYPE_BY_PROFILE: Readonly<
  Record<"smoke" | "sf1" | "sf10", string>
> = {
  smoke: "c7i.4xlarge",
  sf1: "c7i.4xlarge",
  sf10: "r7i.4xlarge",
};
const DEFAULT_VOLUME_SIZE_GIB = 150;
// gp3 decouples IOPS/throughput from volume size — an unprovisioned volume
// silently gets the account's gp3 *baseline* (3,000 IOPS / 125 MB/s)
// regardless of size. An EBS root-cause investigation (see
// reports/snb-lane1-results.md) confirmed that baseline is a genuine
// bottleneck for SQLite's bulk-load checkpoint I/O once the database is a
// few GB: checkpoint flushes revert from large sequential writes to small
// ~4KB random writes that pin against the IOPS ceiling regardless of
// wal_autocheckpoint tuning. These defaults provision well above baseline
// with headroom, at negligible extra cost for a run lasting hours.
const DEFAULT_VOLUME_IOPS = 10_000;
const DEFAULT_VOLUME_THROUGHPUT_MBPS = 400;
const DEFAULT_REPO_URL = "https://github.com/nicia-ai/typegraph.git";
const DEFAULT_BOOTSTRAP_TIMEOUT_SECONDS = 1800; // 30 min
// 6h was the original guess and proved too tight in practice: a real SF1
// run's sqlite (74.5min) + postgres (78.4min) + neo4j (4.5min) load phases
// alone already used ~2.6h, leaving too little margin once query
// benchmarking, container startup, and ladybugdb's own load are added.
// SF10 has since been measured directly (a full run with every load-time
// fix in place completes in ~5.4h total, per reports/snb-lane1-results.md),
// but its timeout stays deliberately generous rather than tightened to
// that number — a slower, non-fatal run (a busier shared host, a cold
// Docker image pull) shouldn't hit a timeout that a full re-run can't
// afford to trigger.
const DEFAULT_BENCHMARK_TIMEOUT_SECONDS_BY_PROFILE: Readonly<
  Record<string, number>
> = {
  smoke: 3600, // 1 h
  sf1: 36000, // 10 h
  sf10: 129600, // 36 h
};
const DEFAULT_POLL_INTERVAL_SECONDS = 60;
const HEARTBEAT_EVERY_N_POLLS = 5;

const EXIT_CODE_MARKER = {
  start: "===EXIT_CODE_START===",
  end: "===EXIT_CODE_END===",
};

/**
 * Sentinel file the backgrounded benchmark script writes at startup, so
 * `collect()` can compute the correct `tail -n +N` offset into
 * `reports/history.jsonl` in a later, separate SSM command — the run may
 * finish hours after it started, long after any in-process variable holding
 * this value would be gone.
 */
const HISTORY_LINES_BEFORE_SENTINEL = "/root/typegraph-bench-lines-before";

function parseArgValue(
  argv: readonly string[],
  name: string,
): string | undefined {
  const prefix = `--${name}=`;
  const found = argv.find((argument) => argument.startsWith(prefix));
  return found?.slice(prefix.length);
}

function requireArgValue(argv: readonly string[], name: string): string {
  const value = parseArgValue(argv, name);
  if (value === undefined) {
    throw new Error(`Missing required --${name} flag.`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
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
async function waitUntil(
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

function extractSection(
  text: string,
  marker: { start: string; end: string },
): string | undefined {
  const startIndex = text.indexOf(marker.start);
  const endIndex = text.indexOf(marker.end);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex)
    return undefined;
  return text.slice(startIndex + marker.start.length, endIndex).trim();
}

function bareCommand(argv: readonly string[]): "launch" | "collect" {
  const first = argv[0];
  if (first === "collect") return "collect";
  return "launch";
}

function benchmarksRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/real/ec2/ -> ../../..
  return path.join(here, "..", "..", "..");
}

/** Renders the SSM command that waits for the bootstrap sentinel, then fails loudly on timeout. */
function renderBootstrapWaitScript(timeoutSeconds: number): string {
  const iterations = Math.ceil(timeoutSeconds / 10);
  return `#!/bin/bash
for i in $(seq 1 ${iterations}); do
  if [ -f ${BOOTSTRAP_COMPLETE_SENTINEL} ]; then echo BOOTSTRAP_OK; exit 0; fi
  if [ -f ${BOOTSTRAP_FAILED_SENTINEL} ]; then cat ${BOOTSTRAP_FAILED_SENTINEL}; exit 1; fi
  sleep 10
done
echo "bootstrap did not complete within ${timeoutSeconds}s"
tail -n 200 ${BOOTSTRAP_LOG_PATH} || true
exit 1
`;
}

/** Absolute path to the benchmarks package on the remote instance. */
function remoteBenchDir(): string {
  return `${REPO_DIR}/packages/benchmarks`;
}

/**
 * Renders the SSM command that runs the (potentially many-hour) benchmark
 * and reports only its exit code inline.
 *
 * Earlier versions of this script also `cat`ed results.json/summary.json and
 * `tail`ed the new history.jsonl lines + a console-log tail directly into
 * this same command's stdout. That works right up until all four engines
 * succeed on the same run: SSM's `StandardOutputContent` is hard-capped at
 * 24,000 characters, and the combined size of all those sections finally
 * exceeded it on the first fully-successful SF10 attempt — silently
 * truncating mid-JSON and losing the history entry for whichever engine's
 * data came last (see reports/snb-lane1-results.md). `collect()` now fetches
 * each artifact via its own separate, later SSM command instead — each gets
 * its own 24,000-character budget, so no single artifact's growth can crowd
 * out another's.
 */
function renderBenchmarkRunScript(profile: string): string {
  const benchDir = remoteBenchDir();
  return `#!/bin/bash
set +e
cd ${benchDir}
wc -l < reports/history.jsonl 2>/dev/null > ${HISTORY_LINES_BEFORE_SENTINEL} || echo 0 > ${HISTORY_LINES_BEFORE_SENTINEL}
pnpm bench:snb:${profile} --check > /var/log/typegraph-bench.log 2>&1
EXIT_CODE=$?
echo "${EXIT_CODE_MARKER.start}"
echo $EXIT_CODE
echo "${EXIT_CODE_MARKER.end}"
exit $EXIT_CODE
`;
}

/** Renders the SSM command that `cat`s one remote file, defaulting to `{}` if it's missing. */
function renderCatJsonScript(remotePath: string): string {
  return `cat ${remotePath} 2>/dev/null || echo '{}'`;
}

/** Renders the SSM command that tails only the history.jsonl lines this run appended. */
function renderHistoryTailScript(): string {
  const benchDir = remoteBenchDir();
  return `LINES_BEFORE=$(cat ${HISTORY_LINES_BEFORE_SENTINEL} 2>/dev/null || echo 0)
tail -n +$((LINES_BEFORE+1)) ${benchDir}/reports/history.jsonl 2>/dev/null || true`;
}

/** Renders the SSM command that tails the benchmark console log — failure diagnostics only. */
function renderFailureLogTailScript(): string {
  return "tail -n 200 /var/log/typegraph-bench.log 2>/dev/null || true";
}

async function launch(argv: readonly string[]): Promise<void> {
  const region = requireArgValue(argv, "region");
  const awsProfile = parseArgValue(argv, "aws-profile");
  const awsOptions: AwsCliOptions =
    awsProfile === undefined ? { region } : { region, profile: awsProfile };

  const subnetId = requireArgValue(argv, "subnet-id");
  const securityGroupId = requireArgValue(argv, "security-group-id");
  const iamInstanceProfile = requireArgValue(argv, "iam-instance-profile");
  const benchProfile = parseArgValue(argv, "profile") ?? "sf1";
  if (
    benchProfile !== "smoke" &&
    benchProfile !== "sf1" &&
    benchProfile !== "sf10"
  ) {
    throw new Error(
      `Unsupported --profile "${benchProfile}". Expected "smoke", "sf1", or "sf10".`,
    );
  }
  const instanceType =
    parseArgValue(argv, "instance-type") ??
    DEFAULT_INSTANCE_TYPE_BY_PROFILE[benchProfile];
  const volumeSizeGib = Number(
    parseArgValue(argv, "volume-size-gib") ?? DEFAULT_VOLUME_SIZE_GIB,
  );
  const volumeIops = Number(
    parseArgValue(argv, "volume-iops") ?? DEFAULT_VOLUME_IOPS,
  );
  const volumeThroughputMbps = Number(
    parseArgValue(argv, "volume-throughput-mbps") ??
      DEFAULT_VOLUME_THROUGHPUT_MBPS,
  );
  const repoUrl = parseArgValue(argv, "repo-url") ?? DEFAULT_REPO_URL;
  const ref = parseArgValue(argv, "ref") ?? resolveGitSha();
  const sshPublicKeyPath = parseArgValue(argv, "ssh-public-key-path");
  const sshPublicKey =
    sshPublicKeyPath === undefined ? undefined : (
      (await readFile(sshPublicKeyPath, "utf8")).trim()
    );
  const associatePublicIp =
    parseArgValue(argv, "associate-public-ip") === "true";

  const bootstrapTimeoutSeconds = Number(
    parseArgValue(argv, "bootstrap-timeout-seconds") ??
      DEFAULT_BOOTSTRAP_TIMEOUT_SECONDS,
  );
  const benchmarkTimeoutSeconds = Number(
    parseArgValue(argv, "benchmark-timeout-seconds") ??
      DEFAULT_BENCHMARK_TIMEOUT_SECONDS_BY_PROFILE[benchProfile],
  );

  const runId = `ec2-${new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")}`;
  const name = `typegraph-benchmark-${runId}`;

  console.log(`Resolving current Ubuntu 24.04 AMI in ${region}...`);
  const amiId = await resolveUbuntu2404Ami(awsOptions);
  console.log(`AMI: ${amiId}`);

  // Comfortably longer than both SSM executionTimeouts below, so this
  // "nobody ever collected" safety net can never race a benchmark that's
  // still legitimately running (see docs/ec2-benchmark-runner.md).
  const deadManSwitchMinutes =
    Math.ceil((bootstrapTimeoutSeconds + benchmarkTimeoutSeconds) / 60) + 60;

  console.log(`Ref to clone: ${ref} (from ${repoUrl})`);
  const userData = renderBootstrapScript({
    repoUrl,
    ref,
    profile: benchProfile,
    deadManSwitchMinutes,
    sshPublicKey,
  });

  console.log(`Launching ${instanceType} (${runId})...`);
  const instanceId = await runInstance(awsOptions, {
    amiId,
    instanceType,
    subnetId,
    securityGroupId,
    iamInstanceProfile,
    volumeSizeGib,
    volumeIops,
    volumeThroughputMbps,
    userData,
    name,
    runId,
    associatePublicIp,
  });
  console.log(`Instance: ${instanceId}`);

  console.log("Waiting for instance to reach 'running'...");
  let runningState:
    Awaited<ReturnType<typeof describeInstanceState>> | undefined;
  await waitUntil("instance running", 5_000, 5 * 60_000, async () => {
    const state = await describeInstanceState(awsOptions, instanceId);
    if (state.state === "running") runningState = state;
    return state.state === "running";
  });
  if (sshPublicKey !== undefined && runningState?.publicIp !== undefined) {
    console.log(
      `SSH diagnostic access: ssh -i <private-key-path> ubuntu@${runningState.publicIp}`,
    );
  }

  console.log("Waiting for SSM agent to register...");
  await waitUntil("SSM online", 5_000, 5 * 60_000, () =>
    isSsmOnline(awsOptions, instanceId),
  );

  console.log(
    `Waiting for bootstrap to complete (up to ${bootstrapTimeoutSeconds}s)...`,
  );
  const bootstrapCommandId = await sendShellCommand(
    awsOptions,
    instanceId,
    renderBootstrapWaitScript(bootstrapTimeoutSeconds),
    { timeoutSeconds: bootstrapTimeoutSeconds + 120 },
  );
  const bootstrapResult = await pollCommand(
    awsOptions,
    instanceId,
    bootstrapCommandId,
    5_000,
    bootstrapTimeoutSeconds + 180,
  );
  if (bootstrapResult.status !== "Success") {
    console.error(bootstrapResult.stdout);
    console.error(bootstrapResult.stderr);
    throw new Error(
      `Bootstrap did not complete successfully (status: ${bootstrapResult.status}). ` +
        `Instance ${instanceId} was NOT terminated — inspect or terminate manually: ` +
        `aws ec2 terminate-instances --region ${region} --instance-ids ${instanceId}`,
    );
  }
  console.log("Bootstrap complete.");

  console.log(
    `Starting benchmark (--profile=${benchProfile}) in the background...`,
  );
  const benchmarkCommandId = await sendShellCommand(
    awsOptions,
    instanceId,
    renderBenchmarkRunScript(benchProfile),
    { timeoutSeconds: benchmarkTimeoutSeconds },
  );

  console.log("");
  console.log("Launched. Collect results once the benchmark finishes with:");
  console.log("");
  const collectFlags = [
    `--region=${region}`,
    awsProfile !== undefined ? `--aws-profile=${awsProfile}` : undefined,
    `--instance-id=${instanceId}`,
    `--command-id=${benchmarkCommandId}`,
    `--profile=${benchProfile}`,
    `--run-id=${runId}`,
  ].filter((flag): flag is string => flag !== undefined);
  console.log(
    `  tsx src/real/ec2/run-sf1-ec2.ts collect ${collectFlags.join(" ")}`,
  );
  console.log("");
}

async function pollCommand(
  awsOptions: AwsCliOptions,
  instanceId: string,
  commandId: string,
  intervalMs: number,
  timeoutSeconds: number,
): Promise<{ status: string; stdout: string; stderr: string }> {
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
async function fetchRemoteText(
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

async function collect(argv: readonly string[]): Promise<void> {
  const region = requireArgValue(argv, "region");
  const awsProfile = parseArgValue(argv, "aws-profile");
  const awsOptions: AwsCliOptions =
    awsProfile === undefined ? { region } : { region, profile: awsProfile };
  const instanceId = requireArgValue(argv, "instance-id");
  const commandId = requireArgValue(argv, "command-id");
  const benchProfile = parseArgValue(argv, "profile") ?? "sf1";
  const runId = parseArgValue(argv, "run-id") ?? "unknown-run";
  const keep = argv.includes("--keep");
  const pollIntervalSeconds = Number(
    parseArgValue(argv, "poll-interval-seconds") ??
      DEFAULT_POLL_INTERVAL_SECONDS,
  );

  console.log(
    `Polling SSM command ${commandId} on ${instanceId} every ${pollIntervalSeconds}s...`,
  );
  let pollCount = 0;
  let invocation = await getCommandInvocation(
    awsOptions,
    instanceId,
    commandId,
  );
  while (!TERMINAL_COMMAND_STATUSES.includes(invocation.status)) {
    pollCount += 1;
    console.log(`  [${new Date().toISOString()}] status=${invocation.status}`);
    if (pollCount % HEARTBEAT_EVERY_N_POLLS === 0) {
      await heartbeatTail(awsOptions, instanceId);
    }
    await sleep(pollIntervalSeconds * 1000);
    invocation = await getCommandInvocation(awsOptions, instanceId, commandId);
  }

  console.log(`Command finished with status: ${invocation.status}`);

  try {
    const exitCodeText = extractSection(invocation.stdout, EXIT_CODE_MARKER);

    // Fetched via separate SSM commands (not embedded in the main command's
    // own stdout) so each artifact gets its own 24,000-character
    // StandardOutputContent budget — see renderBenchmarkRunScript's doc
    // comment for why that matters.
    const benchDir = remoteBenchDir();
    const resultsText = await fetchRemoteText(
      awsOptions,
      instanceId,
      renderCatJsonScript(
        `${benchDir}/bench-results/current/snb-${benchProfile}/results.json`,
      ),
    );
    const summaryText = await fetchRemoteText(
      awsOptions,
      instanceId,
      renderCatJsonScript(
        `${benchDir}/bench-results/current/snb-${benchProfile}/summary.json`,
      ),
    );
    const historyText = await fetchRemoteText(
      awsOptions,
      instanceId,
      renderHistoryTailScript(),
    );

    const hasParseableResults = resultsText.length > 0 && resultsText !== "{}";

    // Collection is best-effort and unconditional: a failed --check run can
    // still produce real timing data for whichever engines completed before
    // the failure, and that's worth keeping for post-mortem even though the
    // run as a whole must still be reported as a failure below.
    const localDir = path.join(
      benchmarksRoot(),
      "bench-results",
      "current",
      `snb-${benchProfile}-ec2-${runId}`,
    );
    await mkdir(localDir, { recursive: true });

    if (hasParseableResults) {
      await writeJsonFile(
        path.join(localDir, "results.json"),
        JSON.parse(resultsText),
      );
    }
    if (summaryText.length > 0) {
      await writeJsonFile(
        path.join(localDir, "summary.json"),
        JSON.parse(summaryText),
      );
    }
    // Raw history lines are always preserved locally (run-scoped, not the
    // shared canonical file) for post-mortem on a failed run — appending to
    // the *canonical* reports/history.jsonl happens only after every success
    // condition below passes, so a failed run's partial per-engine rows
    // never get mixed into the trend log looking like an ordinary result.
    if (historyText.length > 0) {
      await writeFile(
        path.join(localDir, "history-lines.jsonl"),
        `${historyText}\n`,
        "utf-8",
      );
    }

    if (hasParseableResults) {
      console.log(`Results written to ${localDir}`);
    }
    console.log(`Benchmark exit code: ${exitCodeText ?? "unknown"}`);

    // A `--check` run reports row-count-parity/engine failures via a
    // nonzero exit code, not by omitting results.json — some engines can
    // have completed and produced real timings before a later engine
    // failed. Checking only "did results.json parse" previously let a
    // failed run collect as a successful local command with exit code 0;
    // conversely, checking only the exit code let a `Success` SSM
    // invocation that happened to produce no results.json (e.g. the `cat`
    // fetch itself failed) collect as if it had real data.
    if (
      invocation.status !== "Success" ||
      exitCodeText === undefined ||
      exitCodeText !== "0" ||
      !hasParseableResults
    ) {
      console.error(
        "--- last 200 lines of benchmark console log (failure diagnostic) ---",
      );
      console.error(
        await fetchRemoteText(
          awsOptions,
          instanceId,
          renderFailureLogTailScript(),
          30,
        ),
      );
      throw new Error(
        `Benchmark run did not succeed (SSM status: ${invocation.status}, exit code: ${exitCodeText ?? "unknown"}, parseable results: ${hasParseableResults}).` +
          (hasParseableResults ?
            ` Partial artifacts were written to ${localDir}.`
          : " No parseable results were found on the instance."),
      );
    }

    if (historyText.length > 0) {
      await appendFile(resolveHistoryPath(), `${historyText}\n`, "utf-8");
      console.log(
        `Appended ${historyText.split("\n").length} line(s) to ${resolveHistoryPath()}`,
      );
    }
  } finally {
    // Always reached: a parse failure or non-Success status above must not
    // leave a billable instance orphaned.
    if (!keep) {
      console.log(`Terminating instance ${instanceId}...`);
      await terminateInstance(awsOptions, instanceId);
    } else {
      console.log(`--keep set: instance ${instanceId} left running.`);
      console.log(
        `Terminate manually: aws ec2 terminate-instances --region ${region} --instance-ids ${instanceId}`,
      );
    }
  }
}

async function heartbeatTail(
  awsOptions: AwsCliOptions,
  instanceId: string,
): Promise<void> {
  try {
    const tailCommandId = await sendShellCommand(
      awsOptions,
      instanceId,
      "tail -n 20 /var/log/typegraph-bench.log 2>/dev/null || echo '(log not yet created)'",
      { timeoutSeconds: 30 },
    );
    const tailResult = await pollCommand(
      awsOptions,
      instanceId,
      tailCommandId,
      2_000,
      30,
    );
    console.log("  --- heartbeat: tail of benchmark log ---");
    console.log(
      tailResult.stdout
        .trim()
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n"),
    );
  } catch (error) {
    console.log(
      `  (heartbeat tail failed: ${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = bareCommand(argv);
  if (command === "collect") {
    await collect(argv);
    return;
  }
  await launch(argv);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
