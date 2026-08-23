import { CompilerInvariantError } from "../errors";
import type { ManagedCreatePlan, ManagedCreateResult } from "./types";

/** Refuse a custom backend result that does not describe the submitted plan. */
export function assertManagedCreateResultMatchesPlan(
  plan: ManagedCreatePlan,
  result: ManagedCreateResult,
): void {
  if (result.entity !== plan.entity) {
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
  if (result.outcome !== "created") return;
  if (
    result.row.graph_id === plan.params.graphId &&
    result.row.kind === plan.params.kind &&
    result.row.id === plan.params.id
  ) {
    return;
  }
  throw new CompilerInvariantError(
    "A managed create result row must match the submitted plan identity.",
    {
      plan: {
        graphId: plan.params.graphId,
        kind: plan.params.kind,
        id: plan.params.id,
      },
      result: {
        graphId: result.row.graph_id,
        kind: result.row.kind,
        id: result.row.id,
      },
    },
  );
}
