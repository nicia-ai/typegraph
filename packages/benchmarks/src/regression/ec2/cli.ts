/**
 * Pure argv parsing for the regression-lane EC2 CLI (`../../regression-ec2.ts`).
 * No filesystem or process spawning — `parseEc2CollectOptions` takes its
 * file reader (`readLaunchJson`) as an explicit parameter rather than
 * importing `node:fs` itself, so every decision here is testable against
 * plain strings. Reuses `readValue`/`readFlag`/`parseBackends` from
 * `../cli.ts` rather than a second, differently spelled argv reader.
 */
import { parseBackends, readFlag, readValue } from "../cli";
import { type LaneBackend } from "../lanes";
import { type AwsCliOptions } from "../../real/ec2/aws-cli";

export class Ec2CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Ec2CliUsageError";
  }
}

export type CollectTarget = Readonly<{
  instanceId: string;
  commandId: string;
  runId: string;
  backends: readonly LaneBackend[];
}>;

export type LaunchRecord = CollectTarget &
  Readonly<{
    region: string;
    awsProfile: string | undefined;
    launchedAt: string;
    /**
     * The local directory `launch` resolved `launch.json` into (either the
     * caller's `--output` or `defaultOutputDir`). `collect` reuses this
     * verbatim as its own default `--output` so a fetched report always
     * lands next to the `launch.json` that named it, instead of
     * independently re-deriving a directory from `runId` that only matches
     * by coincidence when `--output` was never overridden at launch time.
     */
    outputDir: string;
  }>;

export type Ec2LaunchOptions = Readonly<{
  aws: AwsCliOptions;
  subnetId: string;
  securityGroupId: string;
  iamInstanceProfile: string;
  instanceType: string;
  volumeSizeGib: number;
  volumeIops: number;
  volumeThroughputMbps: number;
  repoUrl: string;
  /**
   * The ref the remote instance clones. Defaults to the literal `"HEAD"` —
   * `../../regression-ec2.ts`'s `launch()` (impure orchestration, not this
   * pure parser) resolves that sentinel to the invoking repo's actual
   * commit SHA via `resolveGitSha()`, the same way `run-sf1-ec2.ts`'s
   * `launch()` already does for the SNB runner.
   */
  ref: string;
  postgresImage: string;
  backends: readonly LaneBackend[];
  laneIds: readonly string[] | undefined;
  baseRef: string | undefined;
  tagRef: string | undefined;
  featureBaselineRef: string | undefined;
  laneTimeoutMs: number;
  bootstrapTimeoutSeconds: number;
  runTimeoutSeconds: number;
  sshPublicKeyPath: string | undefined;
  associatePublicIp: boolean;
  outputDir: string | undefined;
}>;

export type Ec2CollectOptions = Readonly<{
  aws: AwsCliOptions;
  target: CollectTarget;
  pollIntervalSeconds: number;
  keep: boolean;
  outputDir: string | undefined;
}>;

const DEFAULT_INSTANCE_TYPE = "c7i.2xlarge";
const DEFAULT_VOLUME_SIZE_GIB = 100;
const DEFAULT_VOLUME_IOPS = 10_000;
const DEFAULT_VOLUME_THROUGHPUT_MBPS = 400;
const DEFAULT_REPO_URL = "https://github.com/nicia-ai/typegraph.git";
const DEFAULT_POSTGRES_IMAGE = "pgvector/pgvector:pg18";
const DEFAULT_BOOTSTRAP_TIMEOUT_SECONDS = 2400;
const DEFAULT_RUN_TIMEOUT_SECONDS = 14400;
const DEFAULT_LANE_TIMEOUT_MS = 900_000;
const DEFAULT_POLL_INTERVAL_SECONDS = 60;

export function resolveEc2Subcommand(
  argv: readonly string[],
): "launch" | "collect" {
  return argv[0] === "collect" ? "collect" : "launch";
}

function readAwsOptions(argv: readonly string[]): AwsCliOptions | undefined {
  const region = readValue(argv, "region");
  if (region === undefined) {
    return undefined;
  }
  const profile = readValue(argv, "aws-profile");
  return profile === undefined ? { region } : { region, profile };
}

function parsePositiveNumber(
  argv: readonly string[],
  name: string,
  defaultValue: number,
): number {
  const raw = readValue(argv, name);
  if (raw === undefined) {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Ec2CliUsageError(
      `Invalid --${name} value: "${raw}". Must be a positive number.`,
    );
  }
  return parsed;
}

function parseLaneIds(raw: string | undefined): readonly string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/**
 * argv -> `Ec2LaunchOptions`. Refuses (never silently defaults) a missing
 * `--region`, `--subnet-id`, `--security-group-id`, or
 * `--iam-instance-profile` — every missing one is named in a single error
 * so a caller sees the full list without retrying flag-by-flag.
 */
export function parseEc2LaunchOptions(
  argv: readonly string[],
): Ec2LaunchOptions {
  const region = readValue(argv, "region");
  const subnetId = readValue(argv, "subnet-id");
  const securityGroupId = readValue(argv, "security-group-id");
  const iamInstanceProfile = readValue(argv, "iam-instance-profile");

  const missingFlags = (
    [
      ["--region", region],
      ["--subnet-id", subnetId],
      ["--security-group-id", securityGroupId],
      ["--iam-instance-profile", iamInstanceProfile],
    ] as const
  )
    .filter(([, value]) => value === undefined)
    .map(([flagName]) => flagName);
  if (missingFlags.length > 0) {
    throw new Ec2CliUsageError(
      `Missing required flag(s): ${missingFlags.join(", ")}.`,
    );
  }

  const awsProfile = readValue(argv, "aws-profile");
  const aws: AwsCliOptions =
    awsProfile === undefined ?
      { region: region! }
    : { region: region!, profile: awsProfile };

  return {
    aws,
    subnetId: subnetId!,
    securityGroupId: securityGroupId!,
    iamInstanceProfile: iamInstanceProfile!,
    instanceType: readValue(argv, "instance-type") ?? DEFAULT_INSTANCE_TYPE,
    volumeSizeGib: parsePositiveNumber(
      argv,
      "volume-size-gib",
      DEFAULT_VOLUME_SIZE_GIB,
    ),
    volumeIops: parsePositiveNumber(argv, "volume-iops", DEFAULT_VOLUME_IOPS),
    volumeThroughputMbps: parsePositiveNumber(
      argv,
      "volume-throughput-mbps",
      DEFAULT_VOLUME_THROUGHPUT_MBPS,
    ),
    repoUrl: readValue(argv, "repo-url") ?? DEFAULT_REPO_URL,
    ref: readValue(argv, "ref") ?? "HEAD",
    postgresImage: readValue(argv, "postgres-image") ?? DEFAULT_POSTGRES_IMAGE,
    backends: parseBackends(readValue(argv, "backend")),
    laneIds: parseLaneIds(readValue(argv, "lanes")),
    baseRef: readValue(argv, "base"),
    tagRef: readValue(argv, "tag"),
    featureBaselineRef: readValue(argv, "feature-baseline"),
    laneTimeoutMs: parsePositiveNumber(
      argv,
      "lane-timeout-ms",
      DEFAULT_LANE_TIMEOUT_MS,
    ),
    bootstrapTimeoutSeconds: parsePositiveNumber(
      argv,
      "bootstrap-timeout-seconds",
      DEFAULT_BOOTSTRAP_TIMEOUT_SECONDS,
    ),
    runTimeoutSeconds: parsePositiveNumber(
      argv,
      "run-timeout-seconds",
      DEFAULT_RUN_TIMEOUT_SECONDS,
    ),
    sshPublicKeyPath: readValue(argv, "ssh-public-key-path"),
    associatePublicIp: readValue(argv, "associate-public-ip") === "true",
    outputDir: readValue(argv, "output"),
  };
}

/**
 * Validates and narrows a parsed `--launch-json` payload into a
 * `LaunchRecord`, refusing (never silently accepting) a file missing any
 * required field.
 */
export function parseLaunchRecord(text: string): LaunchRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Ec2CliUsageError(
      `--launch-json content is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Ec2CliUsageError("--launch-json content must be a JSON object.");
  }

  const record = parsed as Record<string, unknown>;
  const isValidBackends =
    Array.isArray(record["backends"]) &&
    record["backends"].length > 0 &&
    record["backends"].every(
      (backend) => backend === "sqlite" || backend === "postgres",
    );
  const invalidFields = [
    typeof record["instanceId"] === "string" ? undefined : "instanceId",
    typeof record["commandId"] === "string" ? undefined : "commandId",
    typeof record["runId"] === "string" ? undefined : "runId",
    isValidBackends ? undefined : "backends",
    typeof record["region"] === "string" ? undefined : "region",
    (
      record["awsProfile"] === undefined ||
      typeof record["awsProfile"] === "string"
    ) ?
      undefined
    : "awsProfile",
    typeof record["launchedAt"] === "string" ? undefined : "launchedAt",
    typeof record["outputDir"] === "string" ? undefined : "outputDir",
  ].filter((field): field is string => field !== undefined);
  if (invalidFields.length > 0) {
    throw new Ec2CliUsageError(
      `--launch-json is missing or has invalid field(s): ${invalidFields.join(", ")}.`,
    );
  }

  return {
    instanceId: record["instanceId"] as string,
    commandId: record["commandId"] as string,
    runId: record["runId"] as string,
    backends: record["backends"] as readonly LaneBackend[],
    region: record["region"] as string,
    awsProfile: record["awsProfile"] as string | undefined,
    launchedAt: record["launchedAt"] as string,
    outputDir: record["outputDir"] as string,
  };
}

/**
 * argv -> `Ec2CollectOptions`. The collect target is resolved from exactly
 * one of two mutually exclusive forms: `--launch-json=<path>` (read via the
 * injected `readLaunchJson`, then validated by `parseLaunchRecord`), or the
 * `--instance-id`/`--command-id` pair together. Any other combination —
 * both forms, only one of the pair, or neither — is refused.
 */
export function parseEc2CollectOptions(
  argv: readonly string[],
  readLaunchJson: (path: string) => string,
): Ec2CollectOptions {
  const launchJsonPath = readValue(argv, "launch-json");
  const instanceId = readValue(argv, "instance-id");
  const commandId = readValue(argv, "command-id");

  const outputDir = readValue(argv, "output");
  const keep = readFlag(argv, "keep");
  const pollIntervalSeconds = parsePositiveNumber(
    argv,
    "poll-interval-seconds",
    DEFAULT_POLL_INTERVAL_SECONDS,
  );

  if (launchJsonPath !== undefined) {
    if (instanceId !== undefined || commandId !== undefined) {
      throw new Ec2CliUsageError(
        "--launch-json is mutually exclusive with --instance-id/--command-id.",
      );
    }
    const record = parseLaunchRecord(readLaunchJson(launchJsonPath));
    const regionOverride = readValue(argv, "region");
    const awsProfileOverride = readValue(argv, "aws-profile");
    const region = regionOverride ?? record.region;
    const awsProfile = awsProfileOverride ?? record.awsProfile;
    return {
      aws:
        awsProfile === undefined ? { region } : { region, profile: awsProfile },
      target: {
        instanceId: record.instanceId,
        commandId: record.commandId,
        runId: record.runId,
        backends: record.backends,
      },
      pollIntervalSeconds,
      keep,
      // Reuse the directory `launch` actually wrote `launch.json` into
      // unless the caller explicitly overrides it — never re-derive a
      // directory from `runId`, which only happens to match when `launch`
      // was never given its own `--output`.
      outputDir: outputDir ?? record.outputDir,
    };
  }

  if (instanceId === undefined && commandId === undefined) {
    throw new Ec2CliUsageError(
      "Provide either --launch-json=<path> or both --instance-id and --command-id.",
    );
  }
  if (instanceId === undefined || commandId === undefined) {
    throw new Ec2CliUsageError(
      "--instance-id and --command-id must be supplied together.",
    );
  }

  const aws = readAwsOptions(argv);
  if (aws === undefined) {
    throw new Ec2CliUsageError("Missing required flag(s): --region.");
  }

  return {
    aws,
    target: {
      instanceId,
      commandId,
      runId: readValue(argv, "run-id") ?? "unknown-run",
      backends: parseBackends(readValue(argv, "backend")),
    },
    pollIntervalSeconds,
    keep,
    outputDir,
  };
}

/** Renders the exact `collect` invocation a user copies from `launch`'s output. */
export function renderCollectCommand(record: LaunchRecord): string {
  const flags = [
    `--region=${record.region}`,
    record.awsProfile !== undefined ?
      `--aws-profile=${record.awsProfile}`
    : undefined,
    `--instance-id=${record.instanceId}`,
    `--command-id=${record.commandId}`,
    `--run-id=${record.runId}`,
    `--backend=${record.backends.length === 2 ? "both" : record.backends[0]}`,
    // Always spelled out explicitly: without it, `collect` would fall back
    // to re-deriving a directory from `--run-id` that only matches
    // `launch`'s actual output directory when `--output` was never
    // overridden at launch time.
    `--output=${record.outputDir}`,
  ].filter((flag): flag is string => flag !== undefined);
  return `tsx src/regression-ec2.ts collect ${flags.join(" ")}`;
}
