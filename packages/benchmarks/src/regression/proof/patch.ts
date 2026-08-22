import { execFileSync } from "node:child_process";
import path from "node:path";

import { type RegressionSeed } from "./seeds";

/**
 * Repo-relative paths a unified diff touches, read from its `+++ b/` and
 * `--- a/` headers (deduplicated, `/dev/null` — an add or delete's absent
 * side — excluded). This is the ONE parser every scope/apply check in this
 * module routes through.
 */
export function parsePatchTargets(patchText: string): readonly string[] {
  const targets = new Set<string>();
  for (const rawLine of patchText.split("\n")) {
    if (rawLine.startsWith("+++ b/")) {
      targets.add(rawLine.slice("+++ b/".length).trim());
    } else if (rawLine.startsWith("--- a/")) {
      targets.add(rawLine.slice("--- a/".length).trim());
    }
  }
  targets.delete("dev/null");
  return [...targets];
}

export class SeedPatchScopeError extends Error {
  constructor(seed: RegressionSeed, offendingPaths: readonly string[]) {
    super(
      `Seed "${seed.id}"'s patch "${seed.patchFile}" touches path(s) outside ` +
        `its declared scope (${seed.allowedPathPrefixes.join(", ")}): ` +
        `${offendingPaths.join(", ")}. A seed that patches outside its declared ` +
        "scope (e.g. its own guarding test) would prove nothing.",
    );
    this.name = "SeedPatchScopeError";
  }
}

/**
 * Refuses a seed patch that touches anything outside its declared
 * `allowedPathPrefixes`. Never edits the patch or the tree — a pure text
 * check over the parsed target list.
 */
export function assertSeedPatchScope(
  seed: RegressionSeed,
  patchText: string,
): void {
  const targets = parsePatchTargets(patchText);
  const offendingPaths = targets.filter(
    (target) =>
      !seed.allowedPathPrefixes.some((prefix) => target.startsWith(prefix)),
  );
  if (offendingPaths.length > 0) {
    throw new SeedPatchScopeError(seed, offendingPaths);
  }
}

export class SeedPatchDoesNotApplyError extends Error {
  constructor(seed: RegressionSeed, gitStderr: string) {
    super(
      `Seed "${seed.id}"'s patch "${seed.patchFile}" no longer applies to ` +
        `this tree (git apply --check failed):\n${gitStderr}\n` +
        `Regenerate it — ${seed.origin}`,
    );
    this.name = "SeedPatchDoesNotApplyError";
  }
}

/**
 * `git apply --check` only — never applies. This is the load-bearing
 * freshness guard (I-SEED-FRESH): a patch generated against one commit can
 * silently stop applying as the compiler source it targets evolves, and a
 * proof that can no longer seed the regression it claims to would otherwise
 * fail informatively only deep inside a worktree, long after CI green-lit it.
 */
function extractGitStderr(error: unknown): string {
  if (
    error instanceof Error &&
    "stderr" in error &&
    (error as { stderr?: unknown }).stderr !== undefined
  ) {
    return String((error as { stderr: unknown }).stderr);
  }
  return String(error);
}

export function assertSeedPatchApplies(
  seed: RegressionSeed,
  repoRoot: string,
): void {
  const patchPath = path.join(repoRoot, seed.patchFile);
  try {
    execFileSync("git", ["apply", "--check", patchPath], {
      cwd: repoRoot,
      stdio: "pipe",
    });
  } catch (error) {
    throw new SeedPatchDoesNotApplyError(seed, extractGitStderr(error));
  }
}

/**
 * Applies the seed's patch inside `worktreePath` (a scratch git worktree —
 * never the invoking repo). Callers must have already run
 * {@link assertSeedPatchApplies} against `repoRoot`; this function applies
 * for real and lets a git failure propagate unwrapped, since that would mean
 * the worktree's checked-out tree diverged from `repoRoot` despite the
 * pre-flight check, an unexpected condition worth a raw git error, not a
 * softened one.
 */
export function applySeedPatch(
  seed: RegressionSeed,
  worktreePath: string,
  repoRoot: string,
): void {
  const patchPath = path.join(repoRoot, seed.patchFile);
  execFileSync("git", ["apply", patchPath], {
    cwd: worktreePath,
    stdio: "pipe",
  });
}
