import { isCanonicalIsoDate, statedBoundMatchesStored } from "../../utils/date";

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
 * A validity window as a row carries it, in the column names a backend returns —
 * so a prefetched row is comparable without being reshaped.
 *
 * `undefined` means BOTH "no bound" (an open window) and "a bound this layer
 * cannot know", and the two need no distinguishing: an absent bound never equals
 * a requested one, so an item naming a bound against either always writes. That
 * is what makes {@link windowAfterUpsertCreate} safe to leave `undefined` where
 * the backend will stamp the write instant.
 */
export type UpsertWindow = Readonly<{
  valid_from: string | undefined;
  valid_to: string | undefined;
}>;

/** The window bounds an upsert item may request. */
type RequestedWindow = Readonly<{ validFrom?: string; validTo?: string }>;

/** A window to compare against — a row, or an {@link UpsertWindow}. */
type CurrentWindow = Readonly<{
  valid_from?: string | undefined;
  valid_to?: string | undefined;
}>;

/**
 * Whether one requested window endpoint differs from the stored one, compared as
 * instants rather than as driver text. An omitted request never changes anything.
 *
 * A NON-CANONICAL request always counts as a change, so it reaches the write path
 * that rejects it. Coalescing must not decide whether malformed input is
 * reported: a bound the write path refuses has to be refused whether or not this
 * store happens to coalesce, or the flag silently turns a `ValidationError` into
 * a no-op. That covers the unparseable string and the merely non-canonical one
 * alike — `"2100-06-01T00:00:00Z"` names the same instant as the stored
 * `"2100-06-01T00:00:00.000Z"` and is still refused by every write path, because
 * a variable-width bound mis-sorts against an `asOf` coordinate.
 *
 * Counting it as a change is also what lets the comparison canonicalize the
 * STORED side only ({@link statedBoundMatchesStored}): past this guard the
 * requested value is known canonical.
 */
function windowFieldChanges(
  requested: string | undefined,
  stored: string | undefined,
): boolean {
  if (requested === undefined) {
    return false;
  }
  if (!isCanonicalIsoDate(requested)) {
    return true;
  }
  return !statedBoundMatchesStored(requested, stored);
}

/**
 * Whether an upsert item's requested window differs from the one its target
 * already holds.
 *
 * THE window comparison: `upsertById` and both `bulkUpsertById` paths call this
 * one function, so a re-stated window coalesces identically whether it arrives
 * alone or inside a batch. Comparing as INSTANTS is what keeps one backend from
 * writing where the other coalesces — the stored value arrives as the driver
 * rendered it, and the dialects do not render a timestamp the same way (SQLite
 * returns the written text; a Postgres driver renders `timestamptz` its own way,
 * and one that hands back a zoned string rather than a `Date` hands back text
 * that is equivalent to the canonical form without being identical to it).
 */
export function upsertWindowChanges(
  requested: RequestedWindow | undefined,
  current: CurrentWindow,
): boolean {
  return (
    windowFieldChanges(requested?.validFrom, current.valid_from) ||
    windowFieldChanges(requested?.validTo, current.valid_to)
  );
}

/**
 * The window a queued upsert CREATE — or a resurrection, which asserts a
 * COMPLETE window — leaves the row holding, for a later item with the same id in
 * the same batch to compare against.
 *
 * An omitted `validFrom` is stamped with the write instant by the backend, a
 * value this layer cannot know, so it stays `undefined`. A later copy naming a
 * lower bound therefore counts as a change and writes, rather than coalescing
 * against a guess: the bulk path may spend a write the sequential path would
 * skip, but it never skips one the sequential path makes.
 */
export function windowAfterUpsertCreate(
  requested: RequestedWindow,
): UpsertWindow {
  return { valid_from: requested.validFrom, valid_to: requested.validTo };
}

/**
 * The window a queued upsert UPDATE over a live row leaves it holding: the lower
 * bound is history and never moves (only a resurrection rewrites `valid_from`),
 * and the upper bound moves only when the item names one.
 */
export function windowAfterUpsertUpdate(
  current: UpsertWindow,
  requested: RequestedWindow,
): UpsertWindow {
  return {
    valid_from: current.valid_from,
    valid_to: requested.validTo ?? current.valid_to,
  };
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
  const windowChanges = upsertWindowChanges(options, existing);
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
