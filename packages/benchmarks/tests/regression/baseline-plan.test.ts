import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveBaselinePlans,
  resolveCandidateShaForBaseline,
} from "../../src/regression/baseline-plan";

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function commit(cwd: string, fileName: string, message: string): string {
  writeFileSync(path.join(cwd, fileName), `${message}\n`, "utf-8");
  git(cwd, ["add", fileName]);
  git(cwd, ["commit", "--quiet", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

/** A throwaway git repo with `main` as its default branch (this
 * environment's `git init` otherwise defaults to `master`, which would
 * make `resolveMergeBase(..., "main", ...)` throw). */
function createScratchRepo(): string {
  const repoRoot = mkdtempSync(
    path.join(tmpdir(), "typegraph-baseline-plan-test-"),
  );
  git(repoRoot, ["init", "--quiet", "-b", "main"]);
  git(repoRoot, ["config", "user.email", "test@example.com"]);
  git(repoRoot, ["config", "user.name", "Test"]);
  return repoRoot;
}

describe("resolveCandidateShaForBaseline", () => {
  it("resolves an explicit --candidate ref, not the invoking checkout's HEAD", () => {
    const repoRoot = createScratchRepo();
    commit(repoRoot, "a.txt", "root");
    git(repoRoot, ["checkout", "--quiet", "-b", "feature"]);
    const featureSha = commit(repoRoot, "b.txt", "feature commit");
    git(repoRoot, ["checkout", "--quiet", "main"]);
    // Moves the invoking checkout's own HEAD past the feature branch, so a
    // fix that still (bug-for-bug) resolved "HEAD" here would disagree.
    commit(repoRoot, "c.txt", "main-only commit");

    expect(
      resolveCandidateShaForBaseline(
        { candidateRef: "feature", candidateWorktree: undefined },
        repoRoot,
      ),
    ).toBe(featureSha);
  });

  it("falls back to HEAD of the invoking checkout when no --candidate ref is given", () => {
    const repoRoot = createScratchRepo();
    const headSha = commit(repoRoot, "a.txt", "root");

    expect(
      resolveCandidateShaForBaseline(
        { candidateRef: undefined, candidateWorktree: undefined },
        repoRoot,
      ),
    ).toBe(headSha);
  });
});

describe("resolveBaselinePlans", () => {
  it("computes the default base baseline against the resolved candidate, not the invoking checkout's HEAD", () => {
    const repoRoot = createScratchRepo();
    const rootSha = commit(repoRoot, "a.txt", "root");
    git(repoRoot, ["checkout", "--quiet", "-b", "feature"]);
    commit(repoRoot, "b.txt", "feature commit");
    git(repoRoot, ["checkout", "--quiet", "main"]);
    const mainOnlySha = commit(repoRoot, "c.txt", "main-only commit");
    git(repoRoot, ["tag", "@nicia-ai/typegraph@0.1.0"]);

    const plans = resolveBaselinePlans(
      {
        candidateRef: "feature",
        candidateWorktree: undefined,
        tagRef: undefined,
        baseRef: undefined,
        featureBaselineRef: undefined,
      },
      repoRoot,
    );

    const basePlan = plans.find((plan) => plan.id === "base");
    // main and feature diverge at "root" — that's the correct merge-base
    // regardless of where the invoking checkout's own HEAD has since moved.
    expect(basePlan?.ref).toBe(rootSha);
    expect(basePlan?.ref).not.toBe(mainOnlySha);
  });

  it("respects an explicit --base override without computing a merge-base", () => {
    const repoRoot = createScratchRepo();
    commit(repoRoot, "a.txt", "root");
    git(repoRoot, ["tag", "@nicia-ai/typegraph@0.1.0"]);

    const plans = resolveBaselinePlans(
      {
        candidateRef: undefined,
        candidateWorktree: undefined,
        tagRef: undefined,
        baseRef: "refs/tags/@nicia-ai/typegraph@0.1.0",
        featureBaselineRef: undefined,
      },
      repoRoot,
    );

    expect(plans.find((plan) => plan.id === "base")?.ref).toBe(
      "refs/tags/@nicia-ai/typegraph@0.1.0",
    );
  });
});
