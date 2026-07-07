/**
 * Renders the cloud-init user-data bash script for the SNB EC2 runner.
 * Installs Docker, Node, and pnpm; clones the repo at a given ref; builds
 * `@nicia-ai/typegraph`; and (for any real scale-factor profile) downloads
 * the official LDBC dataset to the exact path `resolveDatasetRoot(profile)`
 * already expects (dataset/resolve.ts), so the benchmark run needs no
 * `--data-dir` override.
 *
 * This only prepares the environment. The benchmark itself is kicked off by
 * a separate SSM Run Command sent after this script's completion sentinel
 * appears (run-sf1-ec2.ts) — cloud-init user-data runs once at first boot
 * and isn't a good fit for a command whose stdout we need to parse.
 */
import path from "node:path";

import {
  type SnbProfile,
  SNB_DATASET_SPECS,
  snbDownloadUrl,
} from "../dataset/resolve";

/**
 * This script runs as root on a remote Ubuntu box (bootstrap sets
 * `HOME=/root`), never on the machine that renders it — so the cache path
 * must be built from "/root", not this (local) process's `os.homedir()`.
 */
function remoteCacheDir(profile: Exclude<SnbProfile, "smoke">): string {
  return path.posix.join(
    "/root",
    ...SNB_DATASET_SPECS[profile].cacheRelativeSegments,
  );
}

export type BootstrapOptions = Readonly<{
  repoUrl: string;
  ref: string;
  profile: SnbProfile;
  /**
   * Minutes until the dead-man's-switch `shutdown` fires. Must be
   * comfortably longer than the benchmark's own SSM executionTimeout —
   * otherwise this "in case nobody ever collects" safety net becomes the
   * thing that kills a benchmark that's still legitimately running.
   */
  deadManSwitchMinutes: number;
}>;

export const BOOTSTRAP_LOG_PATH = "/var/log/typegraph-bootstrap.log";
export const BOOTSTRAP_COMPLETE_SENTINEL = "/opt/typegraph-bootstrap-complete";
export const BOOTSTRAP_FAILED_SENTINEL = "/opt/typegraph-bootstrap-failed";
export const REPO_DIR = "/opt/typegraph";

export function renderBootstrapScript(options: BootstrapOptions): string {
  const datasetStep =
    options.profile === "smoke" ?
      "# smoke profile uses the committed fixture; no dataset download needed."
    : (() => {
        const cacheDir = remoteCacheDir(options.profile);
        const { archive } = SNB_DATASET_SPECS[options.profile];
        return `
mkdir -p "${cacheDir}"
cd "${cacheDir}"
curl -fsSL -O "${snbDownloadUrl(options.profile)}"
zstd -d --stdout "${archive}" | tar -xf - --strip-components=1
rm -f "${archive}"
cd "${REPO_DIR}"
`.trim();
      })();

  return `#!/bin/bash
set -euxo pipefail
exec > >(tee -a ${BOOTSTRAP_LOG_PATH}) 2>&1
export HOME=/root
export DEBIAN_FRONTEND=noninteractive

trap 'echo "bootstrap failed at $(date -u --iso-8601=seconds)" > ${BOOTSTRAP_FAILED_SENTINEL}; tail -n 200 ${BOOTSTRAP_LOG_PATH} >> ${BOOTSTRAP_FAILED_SENTINEL} || true' ERR

# Dead-man's switch: self-terminate if the benchmark is never collected.
shutdown -h +${options.deadManSwitchMinutes} || true

apt-get update -y
apt-get install -y ca-certificates curl gnupg git zstd

# Docker Engine (official apt repo).
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo \\
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \\
  > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

# Node 24 (matches this repo's CI and root package.json's pinned toolchain).
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs
corepack enable

git clone --no-checkout "${options.repoUrl}" "${REPO_DIR}"
cd "${REPO_DIR}"
git fetch --depth 1 origin "${options.ref}"
git checkout FETCH_HEAD
pnpm install --frozen-lockfile
pnpm --filter @nicia-ai/typegraph build

${datasetStep}

touch ${BOOTSTRAP_COMPLETE_SENTINEL}
`;
}
