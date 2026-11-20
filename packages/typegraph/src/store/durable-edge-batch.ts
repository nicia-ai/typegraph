import type { EdgeRow, InsertEdgeParams } from "../backend/types";
import { CompilerInvariantError } from "../errors";

export type DurableEdgeBatchOutcome = "created" | "conflict";

/**
 * Matches a durable batch's returned rows back to attempted inputs in input
 * order. Counts, rather than a set, preserve duplicate-id multiplicity.
 */
export function classifyDurableEdgeBatchOutcomes(
  params: readonly InsertEdgeParams[],
  rows: readonly Pick<EdgeRow, "id">[],
): readonly DurableEdgeBatchOutcome[] {
  const returnedCounts = new Map<string, number>();
  for (const row of rows) {
    returnedCounts.set(row.id, (returnedCounts.get(row.id) ?? 0) + 1);
  }

  const outcomes = params.map((item): DurableEdgeBatchOutcome => {
    const count = returnedCounts.get(item.id) ?? 0;
    if (count === 0) return "conflict";
    returnedCounts.set(item.id, count - 1);
    return "created";
  });
  const unexpectedIds = [...returnedCounts]
    .filter(([, count]) => count > 0)
    .map(([id]) => id);
  if (unexpectedIds.length > 0) {
    throw new CompilerInvariantError(
      "A durable edge batch returned rows that were not attempted.",
      { unexpectedIds },
    );
  }
  return outcomes;
}
