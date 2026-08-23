import { describe, expect, it } from "vitest";

import { judgeRemoteRun } from "../../../src/regression/ec2/collect-verdict";

describe("judgeRemoteRun", () => {
  it("a missing backend report is a hard failure", () => {
    const verdict = judgeRemoteRun({
      ssmStatus: "Success",
      remoteExitCode: 0,
      requestedBackends: ["sqlite", "postgres"],
      fetchedBackends: ["sqlite"],
    });
    expect(verdict.exitCode).toBe(2);
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(" ")).toContain("postgres");
  });

  it("an SSM Failed status carrying remote exit 1 reports exit 1", () => {
    const verdict = judgeRemoteRun({
      ssmStatus: "Failed",
      remoteExitCode: 1,
      requestedBackends: ["sqlite"],
      fetchedBackends: ["sqlite"],
    });
    expect(verdict.exitCode).toBe(1);
    expect(verdict.ok).toBe(false);
  });

  it("an SSM Failed status carrying remote exit 2 reports exit 2", () => {
    const verdict = judgeRemoteRun({
      ssmStatus: "Failed",
      remoteExitCode: 2,
      requestedBackends: ["sqlite"],
      fetchedBackends: ["sqlite"],
    });
    expect(verdict.exitCode).toBe(2);
  });

  it("a Success status with no exit code is a hard failure", () => {
    // ssmStatus is deliberately "Success" (not e.g. "TimedOut") so this test
    // isolates the undefined-exit-code guard: a non-Success status would
    // independently force exit 2 through a different rule, masking a
    // regression where the undefined-exit-code guard itself is dropped or
    // defaulted away.
    const verdict = judgeRemoteRun({
      ssmStatus: "Success",
      remoteExitCode: undefined,
      requestedBackends: ["sqlite"],
      fetchedBackends: ["sqlite"],
    });
    expect(verdict.exitCode).toBe(2);
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(" ")).toContain("exit code");
  });

  it("an unexpected remote exit code is never clean", () => {
    const verdict = judgeRemoteRun({
      ssmStatus: "Success",
      remoteExitCode: 137,
      requestedBackends: ["sqlite"],
      fetchedBackends: ["sqlite"],
    });
    expect(verdict.exitCode).toBe(2);
    expect(verdict.ok).toBe(false);
  });

  it("a clean Success status with exit code 0 is ok", () => {
    const verdict = judgeRemoteRun({
      ssmStatus: "Success",
      remoteExitCode: 0,
      requestedBackends: ["sqlite", "postgres"],
      fetchedBackends: ["sqlite", "postgres"],
    });
    expect(verdict).toEqual({ ok: true, exitCode: 0, reasons: [] });
  });

  it("a non-Success status with a clean exit code 0 is still a hard failure", () => {
    const verdict = judgeRemoteRun({
      ssmStatus: "Cancelled",
      remoteExitCode: 0,
      requestedBackends: ["sqlite"],
      fetchedBackends: ["sqlite"],
    });
    expect(verdict.exitCode).toBe(2);
  });
});
