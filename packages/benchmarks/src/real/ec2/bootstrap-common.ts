/**
 * Shared pieces of the EC2 bootstrap (cloud-init user-data) scripts: the
 * sentinel paths every runner polls for, the "wait for bootstrap" SSM
 * command, and the common prelude every bootstrap script starts with
 * (apt hardening, optional Docker, Node 24). `bootstrap-script.ts` (the SNB
 * runner) and `../../regression/ec2/bootstrap.ts` (the regression-lane
 * runner) both build their full script by appending their own tail
 * (dataset download vs. a full-history clone + Postgres container) to
 * `renderBootstrapPrelude`'s output — this file is the one place that
 * prelude is spelled, so the two runners cannot silently drift on it.
 */
export const BOOTSTRAP_LOG_PATH = "/var/log/typegraph-bootstrap.log";
export const BOOTSTRAP_COMPLETE_SENTINEL = "/opt/typegraph-bootstrap-complete";
export const BOOTSTRAP_FAILED_SENTINEL = "/opt/typegraph-bootstrap-failed";
export const REPO_DIR = "/opt/typegraph";

export type BootstrapPreludeOptions = Readonly<{
  /**
   * Minutes until the dead-man's-switch `shutdown` fires. Must be
   * comfortably longer than the workload's own SSM executionTimeout —
   * otherwise this "in case nobody ever collects" safety net becomes the
   * thing that kills a run that's still legitimately in progress. See
   * `deadManSwitchMinutes` below for the shared formula.
   */
  deadManSwitchMinutes: number;
  /**
   * Optional `authorized_keys` line for the `ubuntu` user. The runner's
   * default control channel is SSM only — this exists purely as an opt-in
   * diagnostic fallback for when SSM itself is the thing that's broken, so
   * it's written before anything else that could fail, and the caller is
   * responsible for opening/closing port 22 on the security group around
   * its use.
   */
  sshPublicKey: string | undefined;
  /** Extra `apt-get install` package names appended after the common set. */
  extraAptPackages: readonly string[];
  /**
   * Whether to tune `nf_conntrack` and install Docker Engine. Only the SNB
   * runner's four-engine, high-container-churn workload needs either —
   * the regression lane needs Docker only for its optional Postgres leg,
   * decided by its own caller (`renderRegressionBootstrapScript`).
   */
  installDocker: boolean;
}>;

const NF_CONNTRACK_AND_DOCKER_LINES: readonly string[] = [
  "# A real SF10 run against instance i-021c312ac05b1720a (2026-07-09) went",
  "# network-unreachable ~3h in — AWS's own instance-reachability check and the",
  "# SSM agent both went dark while CPU utilization stayed rock steady, with no",
  "# kernel panic or OOM-kill in the console log — while Docker was running",
  "# heavy, high-churn connection traffic across 4 benchmarked engines at 10x",
  "# scale. That signature matches conntrack-table exhaustion degrading the",
  "# whole instance's networking, a well-documented failure mode for exactly",
  "# this kind of workload. Raise the ceiling before Docker's first iptables",
  "# NAT rule loads the module with the (much smaller) default hashsize.",
  "mkdir -p /etc/modprobe.d",
  'echo "options nf_conntrack hashsize=131072" > /etc/modprobe.d/nf_conntrack.conf',
  "modprobe nf_conntrack",
  "mkdir -p /etc/sysctl.d",
  'echo "net.netfilter.nf_conntrack_max = 1048576" > /etc/sysctl.d/99-typegraph-bench-conntrack.conf',
  "sysctl --system",
  "",
  "# Docker Engine (official apt repo).",
  "install -m 0755 -d /etc/apt/keyrings",
  "curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc",
  "chmod a+r /etc/apt/keyrings/docker.asc",
  "echo \\",
  '  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \\',
  "  > /etc/apt/sources.list.d/docker.list",
  "apt-get update -y",
  "apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin",
  "systemctl enable --now docker",
];

/**
 * Renders the shared prelude every bootstrap script starts with: shebang,
 * strict mode, log redirection, the `ERR` trap that writes the failed
 * sentinel, the dead-man's-switch `shutdown`, the SSH diagnostic fallback
 * (or its "no key" comment), apt-daily/dpkg-lock hardening, the common apt
 * package set plus the caller's own extras, optional `nf_conntrack`/Docker
 * setup, and Node 24 + corepack. The caller appends its own tail (clone,
 * install, build, and whatever else it needs) directly after this output.
 */
export function renderBootstrapPrelude(
  options: BootstrapPreludeOptions,
): string {
  const sshLines: readonly string[] =
    options.sshPublicKey === undefined ?
      ["# No SSH key supplied — SSM remains the only control channel."]
    : [
        "# Diagnostic-only SSH fallback (opt-in, see BootstrapOptions.sshPublicKey).",
        "install -d -m 0700 -o ubuntu -g ubuntu /home/ubuntu/.ssh",
        `echo "${options.sshPublicKey}" >> /home/ubuntu/.ssh/authorized_keys`,
        "chmod 0600 /home/ubuntu/.ssh/authorized_keys",
        "chown ubuntu:ubuntu /home/ubuntu/.ssh/authorized_keys",
      ];

  const aptInstallLine = [
    "apt-get install -y ca-certificates curl gnupg git",
    ...options.extraAptPackages,
  ].join(" ");

  const lines: readonly string[] = [
    "#!/bin/bash",
    "set -euxo pipefail",
    `exec > >(tee -a ${BOOTSTRAP_LOG_PATH}) 2>&1`,
    "export HOME=/root",
    "export DEBIAN_FRONTEND=noninteractive",
    "",
    `trap 'echo "bootstrap failed at $(date -u --iso-8601=seconds)" > ${BOOTSTRAP_FAILED_SENTINEL}; tail -n 200 ${BOOTSTRAP_LOG_PATH} >> ${BOOTSTRAP_FAILED_SENTINEL} || true' ERR`,
    "",
    "# Dead-man's switch: self-terminate if the benchmark is never collected.",
    `shutdown -h +${options.deadManSwitchMinutes} || true`,
    ...sshLines,
    "",
    "# Fresh Ubuntu cloud images run apt-daily.timer / apt-daily-upgrade.timer /",
    "# unattended-upgrades.service within the first minute or two after boot,",
    "# which races this script for the dpkg lock and reliably fails an apt-get",
    '# call ("Could not get lock /var/lib/dpkg/lock-frontend") if it loses.',
    "# Disable the periodic offenders so nothing new grabs the lock, then wait",
    "# out whichever one might already be mid-run before touching apt ourselves.",
    "systemctl stop apt-daily.timer apt-daily-upgrade.timer apt-daily.service apt-daily-upgrade.service unattended-upgrades.service 2>/dev/null || true",
    "systemctl disable apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true",
    "flock -w 300 /var/lib/dpkg/lock-frontend true",
    "",
    "apt-get update -y",
    aptInstallLine,
    ...(options.installDocker ?
      ["", ...NF_CONNTRACK_AND_DOCKER_LINES, ""]
    : [""]),
    "# Node 24 (matches this repo's CI and root package.json's pinned toolchain).",
    "curl -fsSL https://deb.nodesource.com/setup_24.x | bash -",
    "apt-get install -y nodejs",
    "corepack enable",
  ];

  return lines.join("\n");
}

/**
 * Dead-man's-switch minutes: comfortably longer than both the bootstrap and
 * workload SSM `executionTimeout`s combined, so this "nobody ever collected"
 * safety net can never race a run that's still legitimately in progress.
 * Shared by both EC2 runners so neither can independently drift on the
 * safety margin.
 */
export function deadManSwitchMinutes(
  bootstrapTimeoutSeconds: number,
  workloadTimeoutSeconds: number,
): number {
  return (
    Math.ceil((bootstrapTimeoutSeconds + workloadTimeoutSeconds) / 60) + 60
  );
}

/** Renders the SSM command that waits for the bootstrap sentinel, then fails loudly on timeout. */
export function renderBootstrapWaitScript(timeoutSeconds: number): string {
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
