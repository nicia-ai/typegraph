import { execFileSync, execSync } from "node:child_process";

export function resolveGitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

export function resolveGitRefName(): string | undefined {
  try {
    const ref = execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf-8",
    }).trim();
    return ref === "HEAD" ? undefined : ref;
  } catch {
    return undefined;
  }
}

/**
 * Throwing git ref-resolution helpers for the regression harness
 * (`src/regression/**`). Unlike `resolveGitSha`/`resolveGitRefName` above,
 * these never swallow a failure into a sentinel value — a scratch worktree
 * provisioned from an unresolvable ref must abort loudly, not silently
 * measure the wrong commit.
 */

/** Absolute path to the top level of the git working tree containing `cwd`. */
export function resolveRepoRoot(cwd?: string): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf-8",
  }).trim();
}

/** Resolves `ref` to its full commit SHA; throws if `ref` does not exist. */
export function resolveCommitSha(ref: string, cwd?: string): string {
  return execFileSync("git", ["rev-parse", `${ref}^{commit}`], {
    cwd,
    encoding: "utf-8",
  }).trim();
}

class NoPublishedTagError extends Error {
  constructor() {
    super(
      'No tags matching "@nicia-ai/typegraph@*" were found. Fetch tags ' +
        "(`git fetch --tags`) or pass an explicit --tag ref.",
    );
    this.name = "NoPublishedTagError";
  }
}

/**
 * Most recently published `@nicia-ai/typegraph` tag, sorted by semver
 * (never lexically — lexical order returns `@nicia-ai/typegraph@0.9.2`
 * ahead of `@nicia-ai/typegraph@0.49.0`).
 */
export function resolveLastPublishedTag(cwd?: string): string {
  const output = execFileSync(
    "git",
    ["tag", "--list", "@nicia-ai/typegraph@*", "--sort=-version:refname"],
    { cwd, encoding: "utf-8" },
  );
  const [firstLine] = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (firstLine === undefined) {
    throw new NoPublishedTagError();
  }
  return firstLine;
}

/** Merge base of `ref` and `into`; throws if either ref is unresolvable. */
export function resolveMergeBase(
  ref: string,
  into: string,
  cwd?: string,
): string {
  return execFileSync("git", ["merge-base", ref, into], {
    cwd,
    encoding: "utf-8",
  }).trim();
}
