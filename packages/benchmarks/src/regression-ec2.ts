/**
 * Runs `bench:regression` on a dedicated, ephemeral EC2 instance instead of
 * locally — the timing lane's SSM-driven runner (`docs/ec2-regression-lane.md`).
 * Mirrors `real/ec2/run-sf1-ec2.ts`'s two-subcommand shape and reuses its
 * shared plumbing (`real/ec2/{aws-cli,bootstrap-common,ssm-run}.ts`)
 * rather than a second SSM client — see that file's module doc for why SSM
 * Run Command, not SSH, is the default control channel.
 *
 *   launch   Provisions the instance, waits for it to register with SSM,
 *            confirms bootstrap succeeded (a full-history clone with a
 *            resolvable `main` and published tags — `bench:regression`'s
 *            baselines need both), fires `bench:regression` in the
 *            background, and writes a `launch.json` record plus the exact
 *            `collect` invocation to run next.
 *   collect  Polls the run to a terminal SSM status, fetches each
 *            requested backend's report (gzip+base64-encoded to dodge
 *            SSM's 24,000-character `StandardOutputContent` cap), judges
 *            the run (`regression/ec2/collect-verdict.ts`), and terminates
 *            the instance (unless `--keep`).
 *
 * Orchestration only — every decision (bootstrap script shape, run script
 * shape, exit-code marker, per-backend report layout, pass/fail verdict) is
 * owned by `regression/ec2/*.ts`, `real/ec2/*.ts`, and `regression/report.ts`
 * (`writeFetchedBackendReport`, which itself routes through
 * `resolveBackendReportDir` — the same layout decision `regression-bench.ts`'s
 * local writer and `regression/ec2/remote-scripts.ts`'s remote fetcher use —
 * so this file's local write can never drift from where the remote report
 * actually lives, and the decision is unit-tested independently of this
 * orchestration entrypoint). This lane writes
 * reports only; it never appends to the shared `reports/history.jsonl`
 * trend log the SNB runner does.
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { resolveGitSha, resolveRepoRoot } from "./git";
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
} from "./real/ec2/aws-cli";
import {
  deadManSwitchMinutes,
  renderBootstrapWaitScript,
} from "./real/ec2/bootstrap-common";
import {
  extractExitCode,
  fetchRemoteText,
  pollCommand,
  sleep,
  waitUntil,
} from "./real/ec2/ssm-run";
import { stringifyError, writeJsonFile } from "./real/harness/process";
import { renderRegressionBootstrapScript } from "./regression/ec2/bootstrap";
import {
  type CollectTarget,
  Ec2CliUsageError,
  parseEc2CollectOptions,
  parseEc2LaunchOptions,
  renderCollectCommand,
  resolveEc2Subcommand,
  type LaunchRecord,
} from "./regression/ec2/cli";
import { judgeRemoteRun } from "./regression/ec2/collect-verdict";
import {
  decodeCompressedArtifact,
  CompressedArtifactError,
} from "./regression/ec2/artifacts";
import {
  REMOTE_RUN_LOG_PATH,
  remoteReportPaths,
  renderFetchCompressedScript,
  renderLaneLogTailScript,
  renderRegressionRunScript,
} from "./regression/ec2/remote-scripts";
import { type LaneBackend } from "./regression/lanes";
import { writeFetchedBackendReport } from "./regression/report";

const HEARTBEAT_EVERY_N_POLLS = 5;

function newRunId(): string {
  return `regression-ec2-${new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")}`;
}

function defaultOutputDir(repoRoot: string, runId: string): string {
  return path.join(
    repoRoot,
    "packages",
    "benchmarks",
    "reports",
    "regression",
    `ec2-${runId}`,
  );
}

async function heartbeatTail(
  awsOptions: AwsCliOptions,
  instanceId: string,
): Promise<void> {
  try {
    console.log(
      "  --- heartbeat: tail of regression run log ---\n" +
        (
          await fetchRemoteText(
            awsOptions,
            instanceId,
            `tail -n 20 ${REMOTE_RUN_LOG_PATH} 2>/dev/null || echo '(log not yet created)'`,
            30,
          )
        )
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n"),
    );
  } catch (error) {
    console.log(`  (heartbeat tail failed: ${stringifyError(error)})`);
  }
}

async function launch(argv: readonly string[]): Promise<void> {
  const options = parseEc2LaunchOptions(argv);
  const ref = options.ref === "HEAD" ? resolveGitSha() : options.ref;
  const repoRoot = resolveRepoRoot();
  const runId = newRunId();
  const name = `typegraph-regression-${runId}`;
  const outputDir = options.outputDir ?? defaultOutputDir(repoRoot, runId);

  console.log(`Resolving current Ubuntu 24.04 AMI in ${options.aws.region}...`);
  const amiId = await resolveUbuntu2404Ami(options.aws);
  console.log(`AMI: ${amiId}`);

  const sshPublicKey =
    options.sshPublicKeyPath === undefined ?
      undefined
    : (await readFile(options.sshPublicKeyPath, "utf8")).trim();

  console.log(`Ref to clone: ${ref} (from ${options.repoUrl})`);
  const userData = renderRegressionBootstrapScript({
    repoUrl: options.repoUrl,
    ref,
    backends: options.backends,
    postgresImage: options.postgresImage,
    deadManSwitchMinutes: deadManSwitchMinutes(
      options.bootstrapTimeoutSeconds,
      options.runTimeoutSeconds,
    ),
    sshPublicKey,
  });

  console.log(`Launching ${options.instanceType} (${runId})...`);
  const instanceId = await runInstance(options.aws, {
    amiId,
    instanceType: options.instanceType,
    subnetId: options.subnetId,
    securityGroupId: options.securityGroupId,
    iamInstanceProfile: options.iamInstanceProfile,
    volumeSizeGib: options.volumeSizeGib,
    volumeIops: options.volumeIops,
    volumeThroughputMbps: options.volumeThroughputMbps,
    userData,
    name,
    runId,
    associatePublicIp: options.associatePublicIp,
    lane: "regression",
  });
  console.log(`Instance: ${instanceId}`);

  // Persist the billable resource identity before any wait/bootstrap/SSM
  // operation can fail. The workflow backstop reads this smaller record even
  // when launch.json was never reached.
  const instanceJsonPath = path.join(outputDir, "instance.json");
  try {
    await writeJsonFile(instanceJsonPath, {
      instanceId,
      runId,
      region: options.aws.region,
      awsProfile: options.aws.profile,
      launchedAt: new Date().toISOString(),
    });
  } catch (error) {
    await terminateInstance(options.aws, instanceId);
    throw error;
  }

  console.log("Waiting for instance to reach 'running'...");
  await waitUntil("instance running", 5_000, 5 * 60_000, async () => {
    const state = await describeInstanceState(options.aws, instanceId);
    return state.state === "running";
  });

  console.log("Waiting for SSM agent to register...");
  await waitUntil("SSM online", 5_000, 5 * 60_000, () =>
    isSsmOnline(options.aws, instanceId),
  );

  console.log(
    `Waiting for bootstrap to complete (up to ${options.bootstrapTimeoutSeconds}s)...`,
  );
  const bootstrapCommandId = await sendShellCommand(
    options.aws,
    instanceId,
    renderBootstrapWaitScript(options.bootstrapTimeoutSeconds),
    { timeoutSeconds: options.bootstrapTimeoutSeconds + 120 },
  );
  const bootstrapResult = await pollCommand(
    options.aws,
    instanceId,
    bootstrapCommandId,
    5_000,
    options.bootstrapTimeoutSeconds + 180,
  );
  if (bootstrapResult.status !== "Success") {
    console.error(bootstrapResult.stdout);
    console.error(bootstrapResult.stderr);
    throw new Error(
      `Bootstrap did not complete successfully (status: ${bootstrapResult.status}). ` +
        `Instance ${instanceId} was NOT terminated — inspect or terminate manually: ` +
        `aws ec2 terminate-instances --region ${options.aws.region} --instance-ids ${instanceId}`,
    );
  }
  console.log("Bootstrap complete.");

  console.log("Starting regression run in the background...");
  const runScript = renderRegressionRunScript({
    backends: options.backends,
    laneIds: options.laneIds,
    baseRef: options.baseRef,
    tagRef: options.tagRef,
    featureBaselineRef: options.featureBaselineRef,
    laneTimeoutMs: options.laneTimeoutMs,
  });
  const commandId = await sendShellCommand(options.aws, instanceId, runScript, {
    timeoutSeconds: options.runTimeoutSeconds,
  });

  const launchRecord: LaunchRecord = {
    instanceId,
    commandId,
    runId,
    backends: options.backends,
    region: options.aws.region,
    awsProfile: options.aws.profile,
    launchedAt: new Date().toISOString(),
    outputDir,
  };
  const launchJsonPath = path.join(outputDir, "launch.json");
  await writeJsonFile(launchJsonPath, launchRecord);

  console.log("");
  console.log(`Launched. Launch record written to ${launchJsonPath}`);
  console.log("Collect results once the run finishes with:");
  console.log("");
  console.log(`  ${renderCollectCommand(launchRecord)}`);
  console.log("");
}

async function collect(argv: readonly string[]): Promise<void> {
  const options = parseEc2CollectOptions(argv, (jsonPath) =>
    readFileSync(jsonPath, "utf-8"),
  );
  const { aws } = options;
  const target: CollectTarget = options.target;

  try {
    console.log(
      `Polling SSM command ${target.commandId} on ${target.instanceId} every ${options.pollIntervalSeconds}s...`,
    );
    let pollCount = 0;
    let invocation = await getCommandInvocation(
      aws,
      target.instanceId,
      target.commandId,
    );
    while (!TERMINAL_COMMAND_STATUSES.includes(invocation.status)) {
      pollCount += 1;
      console.log(
        `  [${new Date().toISOString()}] status=${invocation.status}`,
      );
      if (pollCount % HEARTBEAT_EVERY_N_POLLS === 0) {
        await heartbeatTail(aws, target.instanceId);
      }
      await sleep(options.pollIntervalSeconds * 1000);
      invocation = await getCommandInvocation(
        aws,
        target.instanceId,
        target.commandId,
      );
    }
    console.log(`Command finished with status: ${invocation.status}`);

    const repoRoot = resolveRepoRoot();
    const outputDir =
      options.outputDir ?? defaultOutputDir(repoRoot, target.runId);
    const remoteExitCode = extractExitCode(invocation.stdout);

    const fetchedBackends: LaneBackend[] = [];
    for (const reportPaths of remoteReportPaths(target.backends)) {
      try {
        const markdownEncoded = await fetchRemoteText(
          aws,
          target.instanceId,
          renderFetchCompressedScript(reportPaths.markdownPath),
          60,
        );
        const jsonEncoded = await fetchRemoteText(
          aws,
          target.instanceId,
          renderFetchCompressedScript(reportPaths.jsonPath),
          60,
        );
        const markdown = decodeCompressedArtifact(markdownEncoded);
        const json = decodeCompressedArtifact(jsonEncoded);
        await writeFetchedBackendReport(
          outputDir,
          target.backends.length,
          reportPaths.backend,
          markdown,
          json,
        );
        fetchedBackends.push(reportPaths.backend);
      } catch (error) {
        // A decode failure (a truncated or corrupt artifact) records this
        // backend as unfetched rather than aborting the whole collect —
        // `judgeRemoteRun` below treats a missing backend as a hard
        // failure either way, but the other backends' reports are still
        // worth writing.
        const reason =
          error instanceof CompressedArtifactError ?
            error.message
          : stringifyError(error);
        console.error(
          `Failed to fetch report for backend "${reportPaths.backend}": ${reason}`,
        );
      }
    }

    const verdict = judgeRemoteRun({
      ssmStatus: invocation.status,
      remoteExitCode,
      requestedBackends: target.backends,
      fetchedBackends,
    });

    for (const reason of verdict.reasons) {
      console.error(reason);
    }
    if (verdict.ok) {
      console.log(`Reports written to ${outputDir}`);
    } else {
      console.error("--- lane log tail (failure diagnostic) ---");
      console.error(
        await fetchRemoteText(
          aws,
          target.instanceId,
          renderLaneLogTailScript(),
          30,
        ),
      );
    }
    process.exitCode = verdict.exitCode;
  } finally {
    // Always reached: a hard failure above must not leave a billable
    // instance orphaned.
    if (!options.keep) {
      console.log(`Terminating instance ${target.instanceId}...`);
      await terminateInstance(aws, target.instanceId);
    } else {
      console.log(`--keep set: instance ${target.instanceId} left running.`);
      console.log(
        `Terminate manually: aws ec2 terminate-instances --region ${aws.region} --instance-ids ${target.instanceId}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const subcommand = resolveEc2Subcommand(argv);
  if (subcommand === "collect") {
    await collect(argv);
    return;
  }
  await launch(argv);
}

main().catch((error: unknown) => {
  if (error instanceof Ec2CliUsageError) {
    console.error(error.message);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
