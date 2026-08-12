import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveCommitSha } from "../git";
import { spawnStatus } from "../real/harness/process";
import { type BaselineId } from "./policy";

export type ScratchWorktree = Readonly<{
  id: BaselineId | "candidate";
  ref: string;
  sha: string;
  path: string;
  /** `false` for an in-place candidate worktree: never created, never removed. */
  provisioned: boolean;
}>;

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const BUILD_TIMEOUT_MS = 5 * 60 * 1000;

export class WorktreeRootInsideRepoError extends Error {
  constructor(worktreeRoot: string, repoRoot: string) {
    super(
      `Regression worktree root "${worktreeRoot}" is inside the repository ` +
        `("${repoRoot}"). An in-repo scratch worktree pollutes \`git status\`, ` +
        "prettier, and knip scans — pass --worktree-root pointing outside the repo.",
    );
    this.name = "WorktreeRootInsideRepoError";
  }
}

function isInside(containerPath: string, candidatePath: string): boolean {
  const relative = path.relative(containerPath, candidatePath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/**
 * Default scratch-worktree root (I7): `<tmpdir>/typegraph-regression/<sha>`,
 * always outside the repository. An explicit root is returned as-is
 * (resolved to an absolute path); containment against the repo is checked
 * by `provisionWorktree`, which is the function that actually knows the
 * repo root.
 */
export function resolveWorktreeRoot(explicit: string | undefined): string {
  if (explicit !== undefined) {
    return path.resolve(explicit);
  }
  const headSha = resolveCommitSha("HEAD");
  return path.join(os.tmpdir(), "typegraph-regression", headSha.slice(0, 12));
}

export type ProvisionWorktreeInput = Readonly<{
  id: BaselineId | "candidate";
  ref: string;
  repoRoot: string;
  worktreeRoot: string;
}>;

/** Creates a detached scratch worktree for `ref` under `worktreeRoot`. */
export async function provisionWorktree(
  input: ProvisionWorktreeInput,
): Promise<ScratchWorktree> {
  const { id, ref, repoRoot, worktreeRoot } = input;
  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedWorktreeRoot = path.resolve(worktreeRoot);
  if (isInside(resolvedRepoRoot, resolvedWorktreeRoot)) {
    throw new WorktreeRootInsideRepoError(
      resolvedWorktreeRoot,
      resolvedRepoRoot,
    );
  }

  const sha = resolveCommitSha(ref, resolvedRepoRoot);
  const worktreePath = path.join(resolvedWorktreeRoot, id);
  execFileSync("git", ["worktree", "add", "--detach", worktreePath, ref], {
    cwd: resolvedRepoRoot,
    stdio: "pipe",
  });

  return { id, ref, sha, path: worktreePath, provisioned: true };
}

export class SkipInstallWithoutNodeModulesError extends Error {
  constructor(worktreePath: string) {
    super(
      `--skip-install was set but "${worktreePath}" has no node_modules. ` +
        "A skipped install with no prior install is refused, not silently ignored.",
    );
    this.name = "SkipInstallWithoutNodeModulesError";
  }
}

/**
 * Installs dependencies and builds `@nicia-ai/typegraph` inside the
 * worktree. The build step is explicit because pnpm 10 does not run
 * `pre*`/`post*` lifecycle scripts by default, so each lane's own
 * `pre<script>` build hook will not fire — the worktree must already have
 * a built `dist/` before any lane script runs in it.
 */
export async function installWorktree(
  worktree: ScratchWorktree,
  skipInstall: boolean,
): Promise<void> {
  const nodeModulesPath = path.join(worktree.path, "node_modules");
  if (skipInstall) {
    if (!existsSync(nodeModulesPath)) {
      throw new SkipInstallWithoutNodeModulesError(worktree.path);
    }
    return;
  }

  const install = await spawnStatus(
    "pnpm",
    ["install", "--frozen-lockfile", "--prefer-offline"],
    INSTALL_TIMEOUT_MS,
    { cwd: worktree.path },
  );
  if (install.code !== 0) {
    throw new Error(
      `pnpm install failed in "${worktree.path}" (exit ${install.code}): ${install.stderr}`,
    );
  }

  const build = await spawnStatus(
    "pnpm",
    ["--filter", "@nicia-ai/typegraph", "build"],
    BUILD_TIMEOUT_MS,
    { cwd: worktree.path },
  );
  if (build.code !== 0) {
    throw new Error(
      `pnpm --filter @nicia-ai/typegraph build failed in "${worktree.path}" ` +
        `(exit ${build.code}): ${build.stderr}`,
    );
  }
}

/** Removes a scratch worktree; a no-op for an in-place (unprovisioned) one. */
export async function removeWorktree(worktree: ScratchWorktree): Promise<void> {
  if (!worktree.provisioned) {
    return;
  }
  execFileSync("git", ["worktree", "remove", "--force", worktree.path], {
    cwd: worktree.path,
    stdio: "pipe",
  });
}

type BenchmarksPackageJson = Readonly<{
  scripts?: Readonly<Record<string, string>>;
}>;

/**
 * Whether `script` exists in the worktree's `packages/benchmarks/package.json`
 * (I8). Lane availability is always probed against the actual checked-out
 * tree, never assumed from the candidate's own `package.json`.
 */
export function laneScriptExists(
  worktreePath: string,
  script: string,
): boolean {
  const packageJsonPath = path.join(
    worktreePath,
    "packages",
    "benchmarks",
    "package.json",
  );
  if (!existsSync(packageJsonPath)) {
    return false;
  }
  const packageJson = JSON.parse(
    readFileSync(packageJsonPath, "utf-8"),
  ) as BenchmarksPackageJson;
  return typeof packageJson.scripts?.[script] === "string";
}
