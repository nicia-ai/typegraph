import { CompilerInvariantError } from "../errors";
import type { ManagedCreatePlan, ManagedCreateResult } from "./types";

/** Refuse a custom backend result that does not describe the submitted plan. */
export function assertManagedCreateResultMatchesPlan(
  plan: ManagedCreatePlan,
  result: ManagedCreateResult,
): void {
  if (result.entity === plan.entity) return;
  throw new CompilerInvariantError(
    "A managed create result must describe the submitted plan entity.",
    {
      planEntity: plan.entity,
      resultEntity: result.entity,
      graphId: plan.params.graphId,
      id: plan.params.id,
    },
  );
}
