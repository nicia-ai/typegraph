import { describe, expect, it } from "vitest";

import {
  BOOTSTRAP_COMPLETE_SENTINEL,
  BOOTSTRAP_FAILED_SENTINEL,
  BOOTSTRAP_LOG_PATH,
  deadManSwitchMinutes,
  renderBootstrapPrelude,
  renderBootstrapWaitScript,
} from "../../../src/real/ec2/bootstrap-common";

describe("renderBootstrapPrelude", () => {
  it("installs Docker only when asked", () => {
    const withDocker = renderBootstrapPrelude({
      deadManSwitchMinutes: 120,
      sshPublicKey: undefined,
      extraAptPackages: [],
      installDocker: true,
    });
    const withoutDocker = renderBootstrapPrelude({
      deadManSwitchMinutes: 120,
      sshPublicKey: undefined,
      extraAptPackages: [],
      installDocker: false,
    });
    expect(withDocker).toContain("docker-ce docker-ce-cli");
    expect(withDocker).toContain("systemctl enable --now docker");
    expect(withoutDocker).not.toContain("docker-ce docker-ce-cli");
    expect(withoutDocker).not.toContain("systemctl enable --now docker");
  });

  it("appends the caller's extra apt packages", () => {
    const prelude = renderBootstrapPrelude({
      deadManSwitchMinutes: 120,
      sshPublicKey: undefined,
      extraAptPackages: ["zstd"],
      installDocker: true,
    });
    expect(prelude).toContain(
      "apt-get install -y ca-certificates curl gnupg git zstd",
    );
  });

  it("omits extras entirely when none are requested", () => {
    const prelude = renderBootstrapPrelude({
      deadManSwitchMinutes: 120,
      sshPublicKey: undefined,
      extraAptPackages: [],
      installDocker: false,
    });
    expect(prelude).toContain(
      "apt-get install -y ca-certificates curl gnupg git",
    );
    expect(prelude).not.toContain("zstd");
  });

  it("writes the SSH diagnostic fallback only when a key is supplied", () => {
    const withKey = renderBootstrapPrelude({
      deadManSwitchMinutes: 120,
      sshPublicKey: "ssh-ed25519 AAAA test@example",
      extraAptPackages: [],
      installDocker: false,
    });
    const withoutKey = renderBootstrapPrelude({
      deadManSwitchMinutes: 120,
      sshPublicKey: undefined,
      extraAptPackages: [],
      installDocker: false,
    });
    expect(withKey).toContain("ssh-ed25519 AAAA test@example");
    expect(withKey).toContain("authorized_keys");
    expect(withoutKey).not.toContain("authorized_keys");
    expect(withoutKey).toContain("SSM remains the only control channel");
  });
});

describe("deadManSwitchMinutes", () => {
  it("outlives bootstrap plus workload with a comfortable margin", () => {
    expect(deadManSwitchMinutes(1800, 36000)).toBe(
      Math.ceil((1800 + 36000) / 60) + 60,
    );
    expect(deadManSwitchMinutes(0, 0)).toBe(60);
  });
});

describe("renderBootstrapWaitScript", () => {
  it("polls for the complete sentinel and fails on the failed sentinel", () => {
    const script = renderBootstrapWaitScript(600);
    expect(script).toContain(BOOTSTRAP_COMPLETE_SENTINEL);
    expect(script).toContain(BOOTSTRAP_FAILED_SENTINEL);
    expect(script).toContain("exit 1");
    // On timeout, tails the same bootstrap log the prelude redirects into.
    expect(script).toContain(BOOTSTRAP_LOG_PATH);
  });
});
