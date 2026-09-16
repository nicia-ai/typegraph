/**
 * Bind parameters in one resolved node replacement statement, excluding its
 * entries: two graph/kind predicates, the update timestamp, and the count gate.
 */
export const RESOLVED_NODE_UPDATE_BATCH_FIXED_BIND_COUNT = 6;

/** Each entry contributes CASE id/props, IN id, and id/version gate binds. */
export const RESOLVED_NODE_UPDATE_BATCH_ENTRY_BIND_COUNT = 5;

/**
 * The one owner of whether the portable resolved-update statement fits the
 * target's advertised bind budget. An absent budget is an explicit admission
 * that this backend has no known ceiling.
 */
export function resolvedNodeUpdateBatchFitsBindBudget(
  entryCount: number,
  maxBindParameters: number | undefined,
): boolean {
  if (!Number.isSafeInteger(entryCount) || entryCount < 1) return false;
  if (maxBindParameters === undefined) return true;
  return (
    RESOLVED_NODE_UPDATE_BATCH_FIXED_BIND_COUNT +
      entryCount * RESOLVED_NODE_UPDATE_BATCH_ENTRY_BIND_COUNT <=
    maxBindParameters
  );
}
