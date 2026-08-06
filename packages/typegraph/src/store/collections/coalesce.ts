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
 * The ids that appear more than once in one bulk-upsert batch.
 *
 * A repeated id is the only case where a queued write's batch-local running
 * value is ever read, and computing a queued CREATE's running value costs a Zod
 * parse the insert will repeat. Batches with all-distinct ids — the common case —
 * skip that parse entirely.
 */
export function findRepeatedUpsertIds(
  items: readonly Readonly<{ id: string }>[],
): Set<string> {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) repeated.add(item.id);
    seen.add(item.id);
  }
  return repeated;
}

/**
 * Whether one requested window endpoint differs from the stored one, compared as
 * instants rather than as driver text. An omitted request never changes anything.
 *
 * An UNREPRESENTABLE request always counts as a change, so it reaches the write
 * path that rejects it. Canonicalization maps both an unparseable string and an
 * absent value to `undefined`, so comparing the canonical forms would read a
 * garbage bound against an open window as "no change" and coalesce the write —
 * swallowing a `ValidationError` the caller must see.
 */
function windowFieldChanges(
  requested: string | undefined,
  stored: string | undefined,
): boolean {
  if (requested === undefined) {
    return false;
  }
  const canonicalRequested = canonicalizeDatabaseTimestamp(requested);
  if (canonicalRequested === undefined) {
    return true;
  }
  return canonicalRequested !== canonicalizeDatabaseTimestamp(stored);
}

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
  // Both sides are canonicalized before comparison. The stored value reaches
  // here as the driver rendered it, and the two dialects do not store a
  // timestamp the same way (SQLite keeps the written text; a Postgres driver
  // renders `timestamptz` its own way), so comparing as INSTANTS is what keeps
  // one backend from writing where the other coalesces.
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
