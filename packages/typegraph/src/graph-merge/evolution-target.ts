import type { GraphDef } from "../core/define-graph";
import type { EvolutionPlan } from "../schema/evolution-plan";
import { storeRuntime } from "../store/runtime-port";
import type { Store } from "../store/store";
import { MergePlanCapabilityError } from "./errors";

/**
 * Constructs the plan-owned view of the graph that an evolution will produce.
 *
 * This is the single bridge from a module-issued evolution plan to merge
 * planning. It validates both plan ownership and graph identity through the
 * Store runtime before any branch is created or candidate data is staged.
 */
export function evolutionPlanningTarget<G extends GraphDef>(
  store: Store<G>,
  plan: EvolutionPlan,
): Store<G> {
  const planningTarget = storeRuntime(store).evolutionPlanningTarget;
  if (planningTarget === undefined) {
    throw new MergePlanCapabilityError(
      "This Store cannot construct a resulting-schema merge planning view.",
      { details: { capability: "evolutionPlanningTarget" } },
    );
  }
  return planningTarget(plan);
}
