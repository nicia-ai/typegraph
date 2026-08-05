import { canonicalizeDatabaseTimestamp } from "../../utils/date";

/**
 * Coalesce dirty-check shared by `upsertById` / `bulkUpsertById`.
 *
 * A store created with `coalesceUnchangedUpserts` skips the write for an upsert
 * whose validated props already equal the row's stored props (see
 * {@link file://../types.ts BaseStoreOptions.coalesceUnchangedUpserts}).
 */

/**
 * Result of the dirty check: the props the update WOULD persist (input merged
 * over the current props and run through the kind's Zod schema), and whether
 * they equal the current props (so the write can be skipped). `validatedProps`
 * doubles as the batch-local running value a later same-id item is compared
 * against in the bulk path.
 */
export type UpsertDirtyCheck = Readonly<{
  validatedProps: Record<string, unknown>;
  unchanged: boolean;
}>;

/**
 * The seam collections call to run the dirty check. Present only when the store
 * enabled coalescing; its absence is the off switch. `existingProps` is the
 * PARSED current props — the prefetched row's, or the batch-local running value
 * for a repeated id.
 */
export type UpsertDirtyCheckFunction = (
  kind: string,
  id: string,
  existingProps: Record<string, unknown>,
  inputProps: Record<string, unknown>,
) => UpsertDirtyCheck;

/**
 * Whether a single upsert may be coalesced: coalescing is enabled
 * (`runDirtyCheck` present), the row is live, no explicit temporal override was
 * requested, and the props are unchanged. The dirty check runs last (only when
 * the cheap preconditions pass).
 *
 * A throw from the dirty check is treated as "do not coalesce". The check
 * validates the input, so it can throw a `ValidationError`; that must not fail
 * HERE, ahead of the operation hooks. Falling through to the normal write path
 * re-validates inside the hooked pipeline, which raises the error with correct
 * `onError` wiring (matching flag-off) — the error is re-raised there, not
 * swallowed.
 */
/**
 * Whether one requested window endpoint differs from the stored one, compared as
 * instants rather than as driver text. An omitted request never changes anything.
 */
function windowFieldChanges(
  requested: string | undefined,
  stored: string | undefined,
): boolean {
  if (requested === undefined) {
    return false;
  }
  return (
    canonicalizeDatabaseTimestamp(requested) !==
    canonicalizeDatabaseTimestamp(stored)
  );
}

export function shouldCoalesceUpsert(
  existing: Readonly<{
    deleted_at: string | undefined;
    valid_from?: string | undefined;
    valid_to?: string | undefined;
  }>,
  options: Readonly<{ validFrom?: string; validTo?: string }> | undefined,
  runDirtyCheck: (() => UpsertDirtyCheck) | undefined,
): boolean {
  // An explicit temporal override blocks coalescing ONLY when it would
  // change the stored window: merge commits pass the staged survivor's window
  // on every canonical write, and a graph merge passes an inherited row's
  // reconciled end-of-validity, so a row written back with the window it
  // already holds (identical props AND identical window) must still coalesce
  // instead of rewriting version, history, and revision state.
  //
  // Both sides are canonicalized before comparison: the STORED value is raw
  // driver text (postgres-js renders `timestamptz` its own way) while the
  // caller's is an ISO 8601 instant, so a raw string compare would report a
  // change on PostgreSQL that SQLite reports as none — the same write
  // coalescing on one backend and not the other.
  const windowChanges =
    windowFieldChanges(options?.validFrom, existing.valid_from) ||
    windowFieldChanges(options?.validTo, existing.valid_to);
  if (
    runDirtyCheck === undefined ||
    existing.deleted_at !== undefined ||
    windowChanges
  ) {
    return false;
  }
  try {
    return runDirtyCheck().unchanged;
  } catch {
    return false;
  }
}
