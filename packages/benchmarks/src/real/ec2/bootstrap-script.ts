/**
 * Renders the cloud-init user-data bash script for the SNB-SF1 EC2 runner.
 * Installs Docker, Node, and pnpm; clones the repo at a given ref; builds
 * `@nicia-ai/typegraph`; and (for the `sf1` profile) downloads the official
 * LDBC dataset to the exact path `resolveDatasetRoot("sf1")` already expects
 * (dataset/resolve.ts), so the benchmark run needs no `--data-dir` override.
 *
 * This only prepares the environment. The benchmark itself is kicked off by
 * a separate SSM Run Command sent after this script's completion sentinel
 * appears (run-sf1-ec2.ts) — cloud-init user-data runs once at first boot
 * and isn't a good fit for a command whose stdout we need to parse.
 */
import path from "node:path";

import {
  SF1_ARCHIVE,
  SF1_CACHE_RELATIVE_SEGMENTS,
  SF1_DOWNLOAD_URL,
} from "../dataset/resolve";

/**
 * This script runs as root on a remote Ubuntu box (bootstrap sets
 * `HOME=/root`), never on the machine that renders it — so the cache path
 * must be built from "/root", not this (local) process's `os.homedir()`.
 */
const REMOTE_SF1_CACHE_DIR = path.posix.join(
  "/root",
  ...SF1_CACHE_RELATIVE_SEGMENTS,
);

export type BootstrapOptions = Readonly<{
  repoUrl: string;
  ref: string;
  profile: "smoke" | "sf1";
}>;

export const BOOTSTRAP_LOG_PATH = "/var/log/typegraph-bootstrap.log";
export const BOOTSTRAP_COMPLETE_SENTINEL = "/opt/typegraph-bootstrap-complete";
export const BOOTSTRAP_FAILED_SENTINEL = "/opt/typegraph-bootstrap-failed";
export const REPO_DIR = "/opt/typegraph";

export function renderBootstrapScript(options: BootstrapOptions): string {
  const datasetStep =
    options.profile === "sf1" ?
      `
mkdir -p "${REMOTE_SF1_CACHE_DIR}"
cd "${REMOTE_SF1_CACHE_DIR}"
curl -fsSL -O "${SF1_DOWNLOAD_URL}"
zstd -d --stdout "${SF1_ARCHIVE}" | tar -xf -
rm -f "${SF1_ARCHIVE}"
cd "${REPO_DIR}"
`.trim()
    : "# smoke profile uses the committed fixture; no dataset download needed.";

  return `#!/bin/bash
set -euxo pipefail
exec > >(tee -a ${BOOTSTRAP_LOG_PATH}) 2>&1
export HOME=/root
export DEBIAN_FRONTEND=noninteractive

trap 'echo "bootstrap failed at $(date -u --iso-8601=seconds)" > ${BOOTSTRAP_FAILED_SENTINEL}; tail -n 200 ${BOOTSTRAP_LOG_PATH} >> ${BOOTSTRAP_FAILED_SENTINEL} || true' ERR

# Dead-man's switch: self-terminate if the benchmark is never collected.
shutdown -h +360 || true

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
