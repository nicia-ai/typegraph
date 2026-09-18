/**
 * Bind parameters in the heterogeneous node upsert CTE outside its input
 * rows: two schema-fence predicates plus the lower bound and two timestamps
 * stamped by the data-modifying statement.
 */
export const HETEROGENEOUS_NODE_UPSERT_BATCH_FIXED_BIND_COUNT = 5;

/**
 * Each input row supplies its graph/id reference, both property documents, and
 * its caller-order ordinal.
 */
export const HETEROGENEOUS_NODE_UPSERT_BATCH_ENTRY_BIND_COUNT = 6;

/** Exact parameter count emitted by the heterogeneous node upsert CTE. */
export function heterogeneousNodeUpsertBatchBindParameterCount(
  entryCount: number,
): number | undefined {
  if (!Number.isSafeInteger(entryCount) || entryCount < 1) return;
  return (
    HETEROGENEOUS_NODE_UPSERT_BATCH_FIXED_BIND_COUNT +
    entryCount * HETEROGENEOUS_NODE_UPSERT_BATCH_ENTRY_BIND_COUNT
  );
}

/**
 * Whether the one-statement PostgreSQL heterogeneous node upsert fits the
 * target's declared parameter budget. An absent limit explicitly admits that
 * the backend has no known ceiling.
 */
export function heterogeneousNodeUpsertBatchFitsBindBudget(
  entryCount: number,
  maxBindParameters: number | undefined,
): boolean {
  const parameterCount =
    heterogeneousNodeUpsertBatchBindParameterCount(entryCount);
  if (parameterCount === undefined) return false;
  if (maxBindParameters === undefined) return true;
  return parameterCount <= maxBindParameters;
}
