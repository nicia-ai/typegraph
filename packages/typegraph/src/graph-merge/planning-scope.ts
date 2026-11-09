import { MergePlanCapabilityError } from "./errors";
import { err, ok, type Result } from "./result";

/** The target state a planner may copy. */
export type PlanningScope = "candidate" | "full";

/** One cost contract for mutation and candidate planners: full cloning is explicit. */
export function resolvePlanningScope(
  scope: unknown,
): Result<PlanningScope, MergePlanCapabilityError> {
  if (scope === undefined || scope === "candidate") return ok("candidate");
  if (scope === "full") return ok("full");
  return err(
    new MergePlanCapabilityError("Unknown planning scope.", {
      details: { capability: "planningScope", rejectedPlanningScope: scope },
    }),
  );
}
