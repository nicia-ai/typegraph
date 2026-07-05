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
 * No SSH, no key pairs: the only supported control channel is SSM Session
 * Manager / Run Command. The launched instance's IAM instance profile MUST
 * have the AWS-managed `AmazonSSMManagedInstanceCore` policy attached — see
 * docs/ec2-benchmark-runner.md for the flags this account uses and how to
 * adapt them to a different AWS account.
 */
import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveGitSha } from "../../git";
import { resolveHistoryPath } from "../../history";
import { writeJsonFile } from "../harness/process";
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

const DEFAULT_INSTANCE_TYPE = "c7i.4xlarge";
const DEFAULT_VOLUME_SIZE_GIB = 150;
const DEFAULT_REPO_URL = "https://github.com/nicia-ai/typegraph.git";
const DEFAULT_BOOTSTRAP_TIMEOUT_SECONDS = 1800; // 30 min
const DEFAULT_BENCHMARK_TIMEOUT_SECONDS = 21600; // 6 h
const DEFAULT_POLL_INTERVAL_SECONDS = 60;
const HEARTBEAT_EVERY_N_POLLS = 5;

const RESULTS_MARKER = {
  start: "===RESULTS_JSON_START===",
  end: "===RESULTS_JSON_END===",
};
const SUMMARY_MARKER = {
  start: "===SUMMARY_JSON_START===",
  end: "===SUMMARY_JSON_END===",
};
const HISTORY_MARKER = {
  start: "===HISTORY_LINES_START===",
  end: "===HISTORY_LINES_END===",
};
const EXIT_CODE_MARKER = {
  start: "===EXIT_CODE_START===",
  end: "===EXIT_CODE_END===",
};

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

async function waitUntil(
  description: string,
  intervalMs: number,
  timeoutMs: number,
  check: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for: ${description}`);
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

/** Renders the SSM command that runs the benchmark and prints delimited result sections. */
function renderBenchmarkRunScript(profile: string): string {
  const benchDir = `${REPO_DIR}/packages/benchmarks`;
  return `#!/bin/bash
set +e
cd ${benchDir}
LINES_BEFORE=$(wc -l < reports/history.jsonl 2>/dev/null || echo 0)
pnpm bench:snb:${profile} --check > /var/log/typegraph-bench.log 2>&1
EXIT_CODE=$?
echo "${EXIT_CODE_MARKER.start}"
echo $EXIT_CODE
echo "${EXIT_CODE_MARKER.end}"
echo "${RESULTS_MARKER.start}"
cat bench-results/current/snb-${profile}/results.json 2>/dev/null || echo '{}'
echo "${RESULTS_MARKER.end}"
echo "${SUMMARY_MARKER.start}"
cat bench-results/current/snb-${profile}/summary.json 2>/dev/null || echo '{}'
echo "${SUMMARY_MARKER.end}"
echo "${HISTORY_MARKER.start}"
tail -n +$((LINES_BEFORE+1)) reports/history.jsonl 2>/dev/null || true
echo "${HISTORY_MARKER.end}"
echo "--- last 60 lines of benchmark console log ---"
tail -n 60 /var/log/typegraph-bench.log 2>/dev/null || true
exit $EXIT_CODE
`;
}

async function launch(argv: readonly string[]): Promise<void> {
  const region = requireArgValue(argv, "region");
  const awsProfile = parseArgValue(argv, "aws-profile");
  const awsOptions: AwsCliOptions =
    awsProfile === undefined ? { region } : { region, profile: awsProfile };

  const subnetId = requireArgValue(argv, "subnet-id");
  const securityGroupId = requireArgValue(argv, "security-group-id");
  const iamInstanceProfile = requireArgValue(argv, "iam-instance-profile");
  const instanceType =
    parseArgValue(argv, "instance-type") ?? DEFAULT_INSTANCE_TYPE;
  const volumeSizeGib = Number(
    parseArgValue(argv, "volume-size-gib") ?? DEFAULT_VOLUME_SIZE_GIB,
  );
  const repoUrl = parseArgValue(argv, "repo-url") ?? DEFAULT_REPO_URL;
  const ref = parseArgValue(argv, "ref") ?? resolveGitSha();
  const benchProfile = parseArgValue(argv, "profile") ?? "sf1";
  if (benchProfile !== "smoke" && benchProfile !== "sf1") {
    throw new Error(
      `Unsupported --profile "${benchProfile}". Expected "smoke" or "sf1".`,
    );
  }
  const bootstrapTimeoutSeconds = Number(
    parseArgValue(argv, "bootstrap-timeout-seconds") ??
      DEFAULT_BOOTSTRAP_TIMEOUT_SECONDS,
  );
  const benchmarkTimeoutSeconds = Number(
    parseArgValue(argv, "benchmark-timeout-seconds") ??
      DEFAULT_BENCHMARK_TIMEOUT_SECONDS,
  );

  const runId = `ec2-${new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")}`;
  const name = `typegraph-benchmark-${runId}`;

  console.log(`Resolving current Ubuntu 24.04 AMI in ${region}...`);
  const amiId = await resolveUbuntu2404Ami(awsOptions);
  console.log(`AMI: ${amiId}`);

  console.log(`Ref to clone: ${ref} (from ${repoUrl})`);
  const userData = renderBootstrapScript({
    repoUrl,
    ref,
    profile: benchProfile,
  });

  console.log(`Launching ${instanceType} (${runId})...`);
  const instanceId = await runInstance(awsOptions, {
    amiId,
    instanceType,
    subnetId,
    securityGroupId,
    iamInstanceProfile,
    volumeSizeGib,
    userData,
    name,
    runId,
  });
  console.log(`Instance: ${instanceId}`);

  console.log("Waiting for instance to reach 'running'...");
  await waitUntil("instance running", 5_000, 5 * 60_000, async () => {
    const state = await describeInstanceState(awsOptions, instanceId);
    return state.state === "running";
  });

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
    const resultsText = extractSection(invocation.stdout, RESULTS_MARKER);
    const summaryText = extractSection(invocation.stdout, SUMMARY_MARKER);
    const historyText = extractSection(invocation.stdout, HISTORY_MARKER);

    if (resultsText === undefined) {
      console.error(
        "Could not find delimited results section in command output.",
      );
      console.error("--- stdout ---");
      console.error(invocation.stdout);
      console.error("--- stderr ---");
      console.error(invocation.stderr);
      throw new Error(
        `SSM command ${commandId} produced no parseable results (status: ${invocation.status}).`,
      );
    }

    const localDir = path.join(
      benchmarksRoot(),
      "bench-results",
      "current",
      `snb-${benchProfile}-ec2-${runId}`,
    );
    await mkdir(localDir, { recursive: true });

    if (resultsText.length > 0) {
      await writeJsonFile(
        path.join(localDir, "results.json"),
        JSON.parse(resultsText),
      );
    }
    if (summaryText !== undefined && summaryText.length > 0) {
      await writeJsonFile(
        path.join(localDir, "summary.json"),
        JSON.parse(summaryText),
      );
    }
    if (historyText !== undefined && historyText.length > 0) {
      await appendFile(resolveHistoryPath(), `${historyText}\n`, "utf-8");
      console.log(
        `Appended ${historyText.split("\n").length} line(s) to ${resolveHistoryPath()}`,
      );
    }

    console.log(`Results written to ${localDir}`);
    console.log(`Benchmark exit code: ${exitCodeText ?? "unknown"}`);
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
