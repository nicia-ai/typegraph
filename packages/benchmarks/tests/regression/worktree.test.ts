import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveLastPublishedTag } from "../../src/git";
import {
  installWorktree,
  laneScriptExists,
  provisionWorktree,
  SkipInstallWithoutNodeModulesError,
  WorktreeRootInsideRepoError,
  type ScratchWorktree,
} from "../../src/regression/worktree";

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

/** A throwaway git repo with one commit, for git-only worktree tests. */
function createScratchRepo(): string {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "typegraph-worktree-test-"));
  git(repoRoot, ["init", "--quiet"]);
  git(repoRoot, ["config", "user.email", "test@example.com"]);
  git(repoRoot, ["config", "user.name", "Test"]);
  writeFileSync(path.join(repoRoot, "README.md"), "scratch repo\n", "utf-8");
  git(repoRoot, ["add", "README.md"]);
  git(repoRoot, ["commit", "--quiet", "-m", "initial commit"]);
  return repoRoot;
}

describe("resolveLastPublishedTag", () => {
  it("returns 0.49.0-style, not lexical, ordering", () => {
    const repoRoot = createScratchRepo();
    git(repoRoot, ["tag", "@nicia-ai/typegraph@0.9.2"]);
    git(repoRoot, ["tag", "@nicia-ai/typegraph@0.49.0"]);

    expect(resolveLastPublishedTag(repoRoot)).toBe(
      "@nicia-ai/typegraph@0.49.0",
    );
  });

  it("throws a named error when no matching tag exists", () => {
    const repoRoot = createScratchRepo();
    expect(() => resolveLastPublishedTag(repoRoot)).toThrowError(
      /No tags matching/,
    );
  });
});

describe("provisionWorktree", () => {
  it("refuses a worktree root inside the repository", async () => {
    const repoRoot = createScratchRepo();
    const insideRoot = path.join(repoRoot, "scratch-worktrees");

    await expect(
      provisionWorktree({
        id: "base",
        ref: "HEAD",
        repoRoot,
        worktreeRoot: insideRoot,
      }),
    ).rejects.toThrowError(WorktreeRootInsideRepoError);
  });

  it("creates a detached worktree outside the repository", async () => {
    const repoRoot = createScratchRepo();
    const worktreeRoot = mkdtempSync(
      path.join(tmpdir(), "typegraph-worktree-scratch-"),
    );

    const worktree = await provisionWorktree({
      id: "base",
      ref: "HEAD",
      repoRoot,
      worktreeRoot,
    });

    expect(worktree.provisioned).toBe(true);
    expect(worktree.path).toBe(path.join(worktreeRoot, "base"));
    expect(worktree.sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("laneScriptExists", () => {
  function createBenchmarksPackageDir(): string {
    const worktreeRoot = mkdtempSync(
      path.join(tmpdir(), "typegraph-lane-script-"),
    );
    const benchmarksDir = path.join(worktreeRoot, "packages", "benchmarks");
    mkdirSync(benchmarksDir, { recursive: true });
    writeFileSync(
      path.join(benchmarksDir, "package.json"),
      JSON.stringify({ scripts: { perf: "tsx src/main.ts" } }),
      "utf-8",
    );
    return worktreeRoot;
  }

  it("is true for a script present in the worktree package.json", () => {
    const worktreeRoot = createBenchmarksPackageDir();
    expect(laneScriptExists(worktreeRoot, "perf")).toBe(true);
  });

  it("is false for a script absent from the worktree package.json", () => {
    const worktreeRoot = createBenchmarksPackageDir();
    expect(laneScriptExists(worktreeRoot, "bench:vector")).toBe(false);
  });

  it("is false when packages/benchmarks/package.json does not exist", () => {
    const worktreeRoot = mkdtempSync(
      path.join(tmpdir(), "typegraph-lane-script-missing-"),
    );
    expect(laneScriptExists(worktreeRoot, "perf")).toBe(false);
  });
});

describe("installWorktree", () => {
  it("refuses --skip-install when node_modules is absent", async () => {
    const worktreePath = mkdtempSync(
      path.join(tmpdir(), "typegraph-install-worktree-"),
    );
    const worktree: ScratchWorktree = {
      id: "base",
      ref: "HEAD",
      sha: "0".repeat(40),
      path: worktreePath,
      provisioned: true,
    };

    await expect(installWorktree(worktree, true)).rejects.toThrowError(
      SkipInstallWithoutNodeModulesError,
    );
  });

  it("skips the install step when node_modules is present", async () => {
    const worktreePath = mkdtempSync(
      path.join(tmpdir(), "typegraph-install-worktree-"),
    );
    mkdirSync(path.join(worktreePath, "node_modules"), { recursive: true });
    const worktree: ScratchWorktree = {
      id: "base",
      ref: "HEAD",
      sha: "0".repeat(40),
      path: worktreePath,
      provisioned: true,
    };

    await expect(installWorktree(worktree, true)).resolves.toBeUndefined();
  });
});
