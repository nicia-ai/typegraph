import type { GraphDef } from "../core/define-graph";
import type { EvolutionPlan } from "../schema/evolution-plan";
import type { Store } from "../store/store";
import { branch } from "./branch";
import { type BranchError, MergePlanCapabilityError } from "./errors";
import { evolutionPlanningTarget } from "./evolution-target";
import type { Result } from "./result";
import { err } from "./result";
import type { BranchOptions, GraphBranch } from "./types";
import { cloneWorkingCopyStrategy, type MakeBackend } from "./working-copy";

export type EvolutionBranchOptions = BranchOptions &
  Readonly<{ revisionJournal?: false }>;

/**
 * Forks an isolated branch from an evolution plan's resulting graph, before
 * the caller opens its schema-write transaction. The original Store remains
 * pinned to its baseline; planMergeForEvolution checks its durable fence.
 */
export async function branchForEvolution<G extends GraphDef>(
  store: Store<G>,
  plan: EvolutionPlan,
  makeBackend: MakeBackend,
  options?: EvolutionBranchOptions,
): Promise<Result<GraphBranch<G>, BranchError | MergePlanCapabilityError>> {
  try {
    const candidate = evolutionPlanningTarget(store, plan);
    const strategy =
      options?.revisionJournal === false ?
        cloneWorkingCopyStrategy<G>(makeBackend, { revisionJournal: false })
      : undefined;
    const result = await branch(candidate, makeBackend, options, strategy);
    return result;
  } catch (error) {
    if (error instanceof MergePlanCapabilityError) return err(error);
    return err(
      new MergePlanCapabilityError(
        "Could not fork a resulting-schema branch.",
        { cause: error, details: { capability: "evolutionBranch" } },
      ),
    );
  }
}
