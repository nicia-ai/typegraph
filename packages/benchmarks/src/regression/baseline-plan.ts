import {
  resolveCommitSha,
  resolveLastPublishedTag,
  resolveMergeBase,
} from "../git";
import { type RegressionCliOptions } from "./cli";
import { type BaselineId } from "./policy";

export type BaselinePlan = Readonly<{ id: BaselineId; ref: string }>;

/**
 * The single owner of "what commit is the candidate, for the purpose of
 * resolving a *default* baseline". Mirrors `resolveCandidateWorktree`'s own
 * ref resolution exactly: an explicit `--candidate=<ref>` names a ref in the
 * invoking repo's object database (not yet checked out anywhere), while the
 * absence of `--candidate` means "HEAD of `--candidate-worktree`, or of the
 * invoking repo root if that's absent too." Any default baseline computed
 * against a *different* notion of "the candidate" (e.g. always the invoking
 * checkout's own `HEAD`) would silently diff against the wrong commit
 * whenever `--candidate` names something else — exactly the "two divergent
 * representations of the same concept" failure mode this harness exists to
 * prevent for the regressions it measures.
 */
export function resolveCandidateShaForBaseline(
  options: Readonly<
    Pick<RegressionCliOptions, "candidateRef" | "candidateWorktree">
  >,
  repoRoot: string,
): string {
  if (options.candidateRef !== undefined) {
    return resolveCommitSha(options.candidateRef, repoRoot);
  }
  const candidatePath = options.candidateWorktree ?? repoRoot;
  return resolveCommitSha("HEAD", candidatePath);
}

/**
 * Resolves the CLI options into the concrete `(id, ref)` plans regression
 * mode provisions a scratch worktree for. The default `base` plan is the
 * merge-base of `main` with the *resolved candidate* (see
 * `resolveCandidateShaForBaseline`), never a hardcoded `"HEAD"` — those
 * differ whenever `--candidate=<ref>` names a ref other than the invoking
 * checkout's own `HEAD`.
 */
export function resolveBaselinePlans(
  options: Readonly<
    Pick<
      RegressionCliOptions,
      | "candidateRef"
      | "candidateWorktree"
      | "tagRef"
      | "baseRef"
      | "featureBaselineRef"
    >
  >,
  repoRoot: string,
): readonly BaselinePlan[] {
  const candidateSha = resolveCandidateShaForBaseline(options, repoRoot);
  const plans: BaselinePlan[] = [
    { id: "tag", ref: options.tagRef ?? resolveLastPublishedTag(repoRoot) },
    {
      id: "base",
      ref: options.baseRef ?? resolveMergeBase(candidateSha, "main", repoRoot),
    },
  ];
  if (options.featureBaselineRef !== undefined) {
    plans.push({ id: "feature", ref: options.featureBaselineRef });
  }
  return plans;
}
