/**
 * Thin wrappers over the `aws` CLI for the EC2 SNB-SF1 remote runner
 * (docs/design/benchmark-program-plan.md's Lane 1, EC2 extension). Shells
 * out via the existing `spawnCapture` (harness/process.ts) the same way the
 * Postgres/Neo4j engine drivers shell out to `docker` — no new AWS SDK
 * dependency for a handful of imperative calls.
 *
 * Every call takes `region` explicitly and passes `--region` on the command
 * line rather than relying on the ambient `AWS_REGION`/`AWS_DEFAULT_REGION`
 * env vars or the profile's configured region: a stray `AWS_REGION` left set
 * in a shell silently overrides the profile's own region and points every
 * call at the wrong account state.
 */
import { spawnCapture } from "../harness/process";

export type AwsCliOptions = Readonly<{
  region: string;
  profile?: string;
}>;

function baseArgs(options: AwsCliOptions): string[] {
  const args = ["--region", options.region, "--output", "json"];
  if (options.profile !== undefined) {
    args.push("--profile", options.profile);
  }
  return args;
}

async function awsJson<T>(
  options: AwsCliOptions,
  args: readonly string[],
): Promise<T> {
  const stdout = await spawnCapture("aws", [...baseArgs(options), ...args]);
  return JSON.parse(stdout) as T;
}

/** Resolves the current canonical Ubuntu 24.04 LTS amd64 AMI id for the region. */
export async function resolveUbuntu2404Ami(
  options: AwsCliOptions,
): Promise<string> {
  const result = await awsJson<{ Parameter: { Value: string } }>(options, [
    "ssm",
    "get-parameter",
    "--name",
    "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id",
  ]);
  return result.Parameter.Value;
}

export type RunInstanceOptions = Readonly<{
  amiId: string;
  instanceType: string;
  subnetId: string;
  securityGroupId: string;
  iamInstanceProfile: string;
  volumeSizeGib: number;
  userData: string;
  name: string;
  runId: string;
  /**
   * Requests a public IP even if the subnet's own `MapPublicIpOnLaunch`
   * is false. Only useful (and only reachable) if `subnetId` also routes
   * to an Internet Gateway — a private, NAT-egress-only subnet still won't
   * accept inbound traffic to the assigned IP. Off by default: SSM is the
   * default control channel and doesn't need this.
   */
  associatePublicIp: boolean;
}>;

/** Launches one instance and returns its id. Caller waits for `running` separately. */
export async function runInstance(
  options: AwsCliOptions,
  input: RunInstanceOptions,
): Promise<string> {
  const userDataBase64 = Buffer.from(input.userData, "utf-8").toString(
    "base64",
  );
  const tagSpec = [
    `ResourceType=instance,Tags=[` +
      `{Key=Name,Value=${input.name}},` +
      `{Key=Project,Value=TypeGraphBenchmark},` +
      `{Key=Lane,Value=snb},` +
      `{Key=RunId,Value=${input.runId}}` +
      `]`,
  ];
  const result = await awsJson<{
    Instances: readonly { InstanceId: string }[];
  }>(options, [
    "ec2",
    "run-instances",
    "--image-id",
    input.amiId,
    "--instance-type",
    input.instanceType,
    "--subnet-id",
    input.subnetId,
    "--security-group-ids",
    input.securityGroupId,
    "--iam-instance-profile",
    `Name=${input.iamInstanceProfile}`,
    "--block-device-mappings",
    JSON.stringify([
      {
        DeviceName: "/dev/sda1",
        Ebs: {
          VolumeSize: input.volumeSizeGib,
          VolumeType: "gp3",
          DeleteOnTermination: true,
        },
      },
    ]),
    "--instance-initiated-shutdown-behavior",
    "terminate",
    "--user-data",
    userDataBase64,
    "--tag-specifications",
    ...tagSpec,
    "--count",
    "1",
    ...(input.associatePublicIp ? ["--associate-public-ip-address"] : []),
  ]);
  const instanceId = result.Instances[0]?.InstanceId;
  if (instanceId === undefined) {
    throw new Error("ec2 run-instances did not return an instance id.");
  }
  return instanceId;
}

export type InstanceState = Readonly<{
  state: string;
  privateIp: string | undefined;
  publicIp: string | undefined;
}>;

export async function describeInstanceState(
  options: AwsCliOptions,
  instanceId: string,
): Promise<InstanceState> {
  const result = await awsJson<{
    Reservations: readonly {
      Instances: readonly {
        State: { Name: string };
        PrivateIpAddress?: string;
        PublicIpAddress?: string;
      }[];
    }[];
  }>(options, ["ec2", "describe-instances", "--instance-ids", instanceId]);
  const instance = result.Reservations[0]?.Instances[0];
  if (instance === undefined) {
    throw new Error(`Instance ${instanceId} not found.`);
  }
  return {
    state: instance.State.Name,
    privateIp: instance.PrivateIpAddress,
    publicIp: instance.PublicIpAddress,
  };
}

export async function terminateInstance(
  options: AwsCliOptions,
  instanceId: string,
): Promise<void> {
  await awsJson(options, [
    "ec2",
    "terminate-instances",
    "--instance-ids",
    instanceId,
  ]);
}

/** True once the SSM agent on the instance has registered as "Online". */
export async function isSsmOnline(
  options: AwsCliOptions,
  instanceId: string,
): Promise<boolean> {
  const result = await awsJson<{
    InstanceInformationList: readonly { PingStatus: string }[];
  }>(options, [
    "ssm",
    "describe-instance-information",
    "--filters",
    `Key=InstanceIds,Values=${instanceId}`,
  ]);
  return result.InstanceInformationList[0]?.PingStatus === "Online";
}

export type SendCommandOptions = Readonly<{
  timeoutSeconds: number;
}>;

/** Sends a shell command via SSM Run Command; returns the command id. */
export async function sendShellCommand(
  options: AwsCliOptions,
  instanceId: string,
  script: string,
  sendOptions: SendCommandOptions,
): Promise<string> {
  const result = await awsJson<{ Command: { CommandId: string } }>(options, [
    "ssm",
    "send-command",
    "--instance-ids",
    instanceId,
    "--document-name",
    "AWS-RunShellScript",
    "--timeout-seconds",
    String(sendOptions.timeoutSeconds),
    "--parameters",
    // AWS-RunShellScript's own `executionTimeout` document parameter
    // defaults to 3600s (1h) and is separate from send-command's top-level
    // --timeout-seconds (a delivery timeout, not an execution timeout) —
    // both must be set for a genuinely multi-hour command.
    JSON.stringify({
      commands: [script],
      executionTimeout: [String(sendOptions.timeoutSeconds)],
    }),
  ]);
  return result.Command.CommandId;
}

export type CommandInvocationStatus =
  | "Pending"
  | "InProgress"
  | "Delayed"
  | "Success"
  | "Cancelled"
  | "TimedOut"
  | "Failed"
  | "Cancelling";

export type CommandInvocation = Readonly<{
  status: CommandInvocationStatus;
  stdout: string;
  stderr: string;
}>;

export async function getCommandInvocation(
  options: AwsCliOptions,
  instanceId: string,
  commandId: string,
): Promise<CommandInvocation> {
  const result = await awsJson<{
    Status: CommandInvocationStatus;
    StandardOutputContent: string;
    StandardErrorContent: string;
  }>(options, [
    "ssm",
    "get-command-invocation",
    "--instance-id",
    instanceId,
    "--command-id",
    commandId,
  ]);
  return {
    status: result.Status,
    stdout: result.StandardOutputContent,
    stderr: result.StandardErrorContent,
  };
}

export const TERMINAL_COMMAND_STATUSES: readonly CommandInvocationStatus[] = [
  "Success",
  "Cancelled",
  "TimedOut",
  "Failed",
];
