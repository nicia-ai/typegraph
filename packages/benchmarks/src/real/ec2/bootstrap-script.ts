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
import {
  BOOTSTRAP_COMPLETE_SENTINEL,
  renderBootstrapPrelude,
  REPO_DIR,
} from "./bootstrap-common";

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
  /**
   * Optional `authorized_keys` line for the `ubuntu` user. The runner's
   * default control channel is SSM only (see the module doc comment) — this
   * exists purely as an opt-in diagnostic fallback for when SSM itself is
   * the thing that's broken, so it's written before anything else that
   * could fail, and the caller is responsible for opening/closing port 22
   * on the security group around its use.
   */
  sshPublicKey: string | undefined;
}>;

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

  const prelude = renderBootstrapPrelude({
    deadManSwitchMinutes: options.deadManSwitchMinutes,
    sshPublicKey: options.sshPublicKey,
    extraAptPackages: ["zstd"],
    installDocker: true,
  });

  return `${prelude}

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
