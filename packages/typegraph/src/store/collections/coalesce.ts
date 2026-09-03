import {
  isCanonicalIsoDate,
  preservesImmutableLowerBound,
  statedBoundMatchesStored,
} from "../../utils/date";
import { validityEndAfterMutation } from "../validity-end";

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
 * `undefined` is a known open-left bound. A private symbol is an UNKNOWN
 * prediction for a queued create whose backend will choose the lower bound.
 * Keeping those distinct prevents a later explicit open-left request from
 * coalescing against an earlier, not-yet-stamped create.
 */
const UNKNOWN_VALIDITY_LOWER_BOUND = Symbol("unknownValidityLowerBound");

export type UpsertWindow = Readonly<{
  valid_from: string | typeof UNKNOWN_VALIDITY_LOWER_BOUND | undefined;
  valid_to: string | undefined;
}>;

/** The window bounds an upsert item may request. */
type RequestedWindow = Readonly<{
  validFrom?: string | null;
  validTo?: string;
  clearValidTo?: true;
  onImmutableLowerBound?: "preserve" | "refuse";
}>;

/** A window to compare against — a row, or an {@link UpsertWindow}. */
type CurrentWindow = Readonly<{
  valid_from?: string | typeof UNKNOWN_VALIDITY_LOWER_BOUND | undefined;
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
 * requested value is known canonical, or explicitly open-left for `validFrom`.
 * The upper bound retains its separate set/clear protocol: null must reach the
 * write path for rejection even when the stored upper bound is absent.
 */
function windowFieldChanges(
  field: "validFrom" | "validTo",
  requested: string | null | undefined,
  stored: string | typeof UNKNOWN_VALIDITY_LOWER_BOUND | undefined,
): boolean {
  if (requested === undefined) {
    return false;
  }
  if (
    stored === UNKNOWN_VALIDITY_LOWER_BOUND ||
    (requested === null ?
      field !== "validFrom"
    : !isCanonicalIsoDate(requested))
  ) {
    return true;
  }
  return !statedBoundMatchesStored(requested, stored);
}

/** Whether the requested lower bound prevents an unchanged upsert from coalescing. */
function lowerBoundRequiresWrite(
  requested: RequestedWindow | undefined,
  stored: string | typeof UNKNOWN_VALIDITY_LOWER_BOUND | undefined,
): boolean {
  const requestedValidFrom = requested?.validFrom;
  if (!preservesImmutableLowerBound(requested?.onImmutableLowerBound)) {
    return windowFieldChanges("validFrom", requestedValidFrom, stored);
  }
  return (
    requestedValidFrom !== undefined &&
    requestedValidFrom !== null &&
    !isCanonicalIsoDate(requestedValidFrom)
  );
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
    lowerBoundRequiresWrite(requested, current.valid_from) ||
    (requested?.clearValidTo === true &&
      validityEndAfterMutation(requested, current.valid_to) !==
        current.valid_to) ||
    (requested?.clearValidTo === true && requested.validTo !== undefined) ||
    windowFieldChanges("validTo", requested?.validTo, current.valid_to)
  );
}

/**
 * The window a queued upsert CREATE — or a resurrection, which asserts a
 * COMPLETE window — leaves the row holding, for a later item with the same id in
 * the same batch to compare against.
 *
 * An explicit `null` predicts a known open-left row (`undefined`). Omission
 * leaves the lower bound unknown: the backend can stamp its instant or
 * choose no bound for a born-ended write. A later item stating any bound must
 * therefore reach the write path, which compares against the actual row.
 */
export function windowAfterUpsertCreate(
  requested: RequestedWindow,
): UpsertWindow {
  return {
    valid_from:
      requested.validFrom === null ?
        undefined
      : (requested.validFrom ?? UNKNOWN_VALIDITY_LOWER_BOUND),
    valid_to: validityEndAfterMutation(requested, undefined),
  };
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
    valid_to: validityEndAfterMutation(requested, current.valid_to),
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
    valid_from?: string | typeof UNKNOWN_VALIDITY_LOWER_BOUND | undefined;
    valid_to?: string | undefined;
  }>,
  options:
    | Readonly<{
        validFrom?: string | null;
        validTo?: string;
        clearValidTo?: true;
      }>
    | undefined,
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
