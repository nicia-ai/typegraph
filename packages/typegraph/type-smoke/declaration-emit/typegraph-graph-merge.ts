/**
 * Declaration-emit consumer of `@nicia-ai/typegraph/graph-merge` alone (see `typegraph.ts` in this
 * directory): every export has an inferred type that this entrypoint's
 * declarations spell, and this file's program holds no other entrypoint.
 */
import {
  applyMergePlan,
  branch,
  computeBaseVersion,
  createMutationPlanBuilder,
  merge,
  normalizeMergeOptions,
  openProvenanceStore,
  planMerge,
  planMutations,
  readProvenance,
} from "@nicia-ai/typegraph/graph-merge";

export const planBranchMerge = (...args: Parameters<typeof planMerge>) =>
  planMerge(...args);
export const applyPlan = (...args: Parameters<typeof applyMergePlan>) =>
  applyMergePlan(...args);
export const mergeBranches = (...args: Parameters<typeof merge>) =>
  merge(...args);
export const branchStore = (...args: Parameters<typeof branch>) =>
  branch(...args);
export const baseVersion = (...args: Parameters<typeof computeBaseVersion>) =>
  computeBaseVersion(...args);
export const mutationPlan = (...args: Parameters<typeof planMutations>) =>
  planMutations(...args);
export const mutationBuilder = (
  ...args: Parameters<typeof createMutationPlanBuilder>
) => createMutationPlanBuilder(...args);
export const provenanceOf = (...args: Parameters<typeof readProvenance>) =>
  readProvenance(...args);
export const provenanceStore = (
  ...args: Parameters<typeof openProvenanceStore>
) => openProvenanceStore(...args);
export const mergeOptions = (
  ...args: Parameters<typeof normalizeMergeOptions>
) => normalizeMergeOptions(...args);
