/**
 * Shared coalesce precondition gate for `upsertById` / `bulkUpsertById`.
 *
 * Centralizes the rules that must ALL hold before a value-identical upsert is
 * skipped, so the node single-upsert, node bulk, and edge bulk paths cannot
 * drift on when coalescing is legal (see
 * {@link file://../types.ts BaseStoreOptions.coalesceUnchangedUpserts}):
 *
 *   1. The store enabled coalescing (`isUnchanged` is defined — its absence is
 *      the off switch).
 *   2. The existing row is not soft-deleted (an upsert onto a tombstone
 *      resurrects it — a real write — never coalesce).
 *   3. The caller passed no explicit `validFrom` / `validTo` (an explicit
 *      temporal override is a deliberate request).
 *   4. The validated props are value-identical to the stored props
 *      (`isUnchanged`, evaluated last so the dirty-check runs only when the
 *      cheap preconditions already passed).
 *
 * `isUnchanged` returns `undefined` when the store did not enable coalescing
 * (the seam is absent), which fails the `=== true` check — so an unconfigured
 * store never coalesces.
 */
export function shouldCoalesceUpsert(
  existing: Readonly<{ deleted_at: string | undefined }>,
  options: Readonly<{ validFrom?: string; validTo?: string }> | undefined,
  isUnchanged: () => boolean | undefined,
): boolean {
  return (
    existing.deleted_at === undefined &&
    options?.validFrom === undefined &&
    options?.validTo === undefined &&
    isUnchanged() === true
  );
}
