import { describe, expect, it } from "vitest";

import {
  Ec2CliUsageError,
  parseEc2CollectOptions,
  parseEc2LaunchOptions,
  parseLaunchRecord,
  renderCollectCommand,
  resolveEc2Subcommand,
  type LaunchRecord,
} from "../../../src/regression/ec2/cli";

const VALID_LAUNCH_RECORD: LaunchRecord = {
  instanceId: "i-0123456789abcdef0",
  commandId: "cmd-1234",
  runId: "regression-ec2-20260101T000000Z",
  backends: ["sqlite"],
  region: "us-west-2",
  awsProfile: undefined,
  launchedAt: "2026-01-01T00:00:00.000Z",
  outputDir:
    "/repo/packages/benchmarks/reports/regression/ec2-20260101T000000Z",
};

describe("resolveEc2Subcommand", () => {
  it("resolves 'collect' explicitly and defaults to 'launch' otherwise", () => {
    expect(resolveEc2Subcommand(["collect", "--region=us-west-2"])).toBe(
      "collect",
    );
    expect(resolveEc2Subcommand(["--region=us-west-2"])).toBe("launch");
    expect(resolveEc2Subcommand([])).toBe("launch");
  });
});

describe("parseEc2LaunchOptions", () => {
  const REQUIRED_FLAGS = [
    "--region=us-west-2",
    "--subnet-id=subnet-1",
    "--security-group-id=sg-1",
    "--iam-instance-profile=profile-1",
  ];

  it("refuses launch with no flags, naming every missing required flag", () => {
    expect(() => parseEc2LaunchOptions([])).toThrowError(Ec2CliUsageError);
    try {
      parseEc2LaunchOptions([]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(Ec2CliUsageError);
      const message = (error as Error).message;
      expect(message).toContain("--region");
      expect(message).toContain("--subnet-id");
      expect(message).toContain("--security-group-id");
      expect(message).toContain("--iam-instance-profile");
    }
  });

  it("parses required flags and applies documented defaults", () => {
    const options = parseEc2LaunchOptions(REQUIRED_FLAGS);
    expect(options.aws).toEqual({ region: "us-west-2" });
    expect(options.subnetId).toBe("subnet-1");
    expect(options.securityGroupId).toBe("sg-1");
    expect(options.iamInstanceProfile).toBe("profile-1");
    expect(options.instanceType).toBe("c7i.2xlarge");
    expect(options.volumeSizeGib).toBe(100);
    expect(options.volumeIops).toBe(10_000);
    expect(options.volumeThroughputMbps).toBe(400);
    expect(options.postgresImage).toBe("pgvector/pgvector:pg18");
    expect(options.bootstrapTimeoutSeconds).toBe(2400);
    expect(options.runTimeoutSeconds).toBe(14400);
    expect(options.ref).toBe("HEAD");
    expect(options.backends).toEqual(["sqlite"]);
  });

  it("rejects a non-positive --lane-timeout-ms or --run-timeout-seconds", () => {
    expect(() =>
      parseEc2LaunchOptions([...REQUIRED_FLAGS, "--lane-timeout-ms=0"]),
    ).toThrowError(Ec2CliUsageError);
    expect(() =>
      parseEc2LaunchOptions([...REQUIRED_FLAGS, "--run-timeout-seconds=-1"]),
    ).toThrowError(Ec2CliUsageError);
  });
});

describe("parseLaunchRecord", () => {
  it("parses a valid launch record", () => {
    const record = parseLaunchRecord(JSON.stringify(VALID_LAUNCH_RECORD));
    expect(record).toEqual(VALID_LAUNCH_RECORD);
  });

  it("refuses a launch record missing its command id", () => {
    const { commandId: _commandId, ...withoutCommandId } = VALID_LAUNCH_RECORD;
    expect(() =>
      parseLaunchRecord(JSON.stringify(withoutCommandId)),
    ).toThrowError(Ec2CliUsageError);
  });

  it("refuses a launch record missing its output directory", () => {
    const { outputDir: _outputDir, ...withoutOutputDir } = VALID_LAUNCH_RECORD;
    expect(() =>
      parseLaunchRecord(JSON.stringify(withoutOutputDir)),
    ).toThrowError(Ec2CliUsageError);
  });

  it("refuses invalid JSON", () => {
    expect(() => parseLaunchRecord("not json")).toThrowError(Ec2CliUsageError);
  });

  it("refuses a record with an invalid backends field", () => {
    expect(() =>
      parseLaunchRecord(
        JSON.stringify({ ...VALID_LAUNCH_RECORD, backends: ["not-a-backend"] }),
      ),
    ).toThrowError(Ec2CliUsageError);
  });
});

describe("parseEc2CollectOptions", () => {
  it("refuses --launch-json together with --instance-id", () => {
    expect(() =>
      parseEc2CollectOptions(
        ["--launch-json=/tmp/launch.json", "--instance-id=i-1"],
        () => JSON.stringify(VALID_LAUNCH_RECORD),
      ),
    ).toThrowError(Ec2CliUsageError);
  });

  it("refuses --instance-id without --command-id", () => {
    expect(() =>
      parseEc2CollectOptions(
        ["--region=us-west-2", "--instance-id=i-1"],
        () => "",
      ),
    ).toThrowError(Ec2CliUsageError);
  });

  it("refuses --command-id without --instance-id", () => {
    expect(() =>
      parseEc2CollectOptions(
        ["--region=us-west-2", "--command-id=cmd-1"],
        () => "",
      ),
    ).toThrowError(Ec2CliUsageError);
  });

  it("refuses neither --launch-json nor --instance-id/--command-id", () => {
    expect(() =>
      parseEc2CollectOptions(["--region=us-west-2"], () => ""),
    ).toThrowError(Ec2CliUsageError);
  });

  it("resolves the target from --launch-json", () => {
    const options = parseEc2CollectOptions(
      ["--launch-json=/tmp/launch.json"],
      () => JSON.stringify(VALID_LAUNCH_RECORD),
    );
    expect(options.target).toEqual({
      instanceId: VALID_LAUNCH_RECORD.instanceId,
      commandId: VALID_LAUNCH_RECORD.commandId,
      runId: VALID_LAUNCH_RECORD.runId,
      backends: VALID_LAUNCH_RECORD.backends,
    });
    expect(options.aws).toEqual({ region: VALID_LAUNCH_RECORD.region });
  });

  it("resolves the target from --instance-id/--command-id", () => {
    const options = parseEc2CollectOptions(
      [
        "--region=us-west-2",
        "--instance-id=i-1",
        "--command-id=cmd-1",
        "--run-id=run-1",
        "--backend=both",
      ],
      () => "",
    );
    expect(options.target).toEqual({
      instanceId: "i-1",
      commandId: "cmd-1",
      runId: "run-1",
      backends: ["sqlite", "postgres"],
    });
  });

  it("defaults --output from the launch record's own output directory", () => {
    const options = parseEc2CollectOptions(
      ["--launch-json=/tmp/launch.json"],
      () => JSON.stringify(VALID_LAUNCH_RECORD),
    );
    expect(options.outputDir).toBe(VALID_LAUNCH_RECORD.outputDir);
  });

  it("an explicit --output overrides the launch record's output directory", () => {
    const options = parseEc2CollectOptions(
      ["--launch-json=/tmp/launch.json", "--output=/tmp/override"],
      () => JSON.stringify(VALID_LAUNCH_RECORD),
    );
    expect(options.outputDir).toBe("/tmp/override");
  });
});

describe("renderCollectCommand", () => {
  it("parses a launch record and renders the exact collect command", () => {
    const command = renderCollectCommand(VALID_LAUNCH_RECORD);
    expect(command).toContain(`--region=${VALID_LAUNCH_RECORD.region}`);
    expect(command).toContain(
      `--instance-id=${VALID_LAUNCH_RECORD.instanceId}`,
    );
    expect(command).toContain(`--command-id=${VALID_LAUNCH_RECORD.commandId}`);
    expect(command).toContain(`--run-id=${VALID_LAUNCH_RECORD.runId}`);
    expect(command).toContain("--backend=sqlite");
    expect(command).toContain(`--output=${VALID_LAUNCH_RECORD.outputDir}`);
    expect(command).not.toContain("--aws-profile");
  });

  it("includes --aws-profile when the record has one", () => {
    const command = renderCollectCommand({
      ...VALID_LAUNCH_RECORD,
      awsProfile: "nicia-production",
    });
    expect(command).toContain("--aws-profile=nicia-production");
  });
});
