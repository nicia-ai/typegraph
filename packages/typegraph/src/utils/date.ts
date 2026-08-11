/**
 * Date encoding utilities for consistent storage.
 *
 * Contract: All dates are stored as ISO 8601 strings in UTC.
 * - Always includes milliseconds
 * - Always UTC (Z suffix)
 * - Sorts correctly as strings
 */

import {
  IMMUTABLE_VALIDITY_LOWER_BOUND_CODE,
  INVERTED_VALIDITY_WINDOW_CODE,
  ValidationError,
} from "../errors";

/**
 * ISO 8601 datetime pattern.
 * Matches formats like:
 * - 2024-01-15T10:30:00.000Z
 * - 2024-01-15T10:30:00Z
 * - 2024-01-15T10:30:00.123Z
 */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/**
 * Checks if a string is a valid ISO 8601 datetime.
 *
 * @param value - String to validate
 * @returns True if valid ISO 8601 datetime
 */
export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) {
    return false;
  }
  // Also check that Date parsing produces a valid date
  const date = new Date(value);
  return !Number.isNaN(date.getTime());
}

/**
 * Validates that a string is a valid ISO 8601 datetime.
 * Throws ValidationError if invalid.
 *
 * @param value - String to validate
 * @param fieldName - Name of field for error message
 * @returns The validated string
 * @throws ValidationError if not a valid ISO datetime
 */
export function validateIsoDate(value: string, fieldName: string): string {
  if (!isValidIsoDate(value)) {
    throw new ValidationError(
      `Invalid ISO 8601 datetime for "${fieldName}": "${value}". ` +
        `Expected format: YYYY-MM-DDTHH:mm:ss.sssZ`,
      {
        issues: [
          {
            path: fieldName,
            message: `Invalid ISO 8601 datetime format. Expected: YYYY-MM-DDTHH:mm:ss.sssZ, got: "${value}"`,
          },
        ],
      },
      {
        suggestion: `Use a valid ISO 8601 UTC datetime like "2024-01-15T10:30:00.000Z"`,
      },
    );
  }
  return value;
}

/**
 * Strict canonical ISO 8601 pattern: fixed-width UTC with exactly
 * millisecond precision (`YYYY-MM-DDTHH:mm:ss.sssZ`). Unlike
 * {@link ISO_DATE_PATTERN}, which tolerates a missing or variable-width
 * fractional part, this is the only shape whose lexicographic text order
 * matches chronological order — avoiding cases like `"...:00.1Z"` (= `.100`)
 * sorting *after* `"...:00.101Z"`.
 */
const CANONICAL_ISO_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const ZONELESS_DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;
const OFFSET_DATETIME_PATTERN =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}(?::?\d{2})?)$/i;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function normalizedOffset(offset: string): string {
  if (offset.toUpperCase() === "Z") return "Z";
  if (/^[+-]\d{2}$/.test(offset)) return `${offset}:00`;
  if (/^[+-]\d{4}$/.test(offset)) {
    return `${offset.slice(0, 3)}:${offset.slice(3)}`;
  }
  return offset;
}

function databaseTimestampMilliseconds(value: string): number {
  if (ZONELESS_DATETIME_PATTERN.test(value)) {
    return Date.parse(`${value.replace(" ", "T")}Z`);
  }
  const offsetMatch = OFFSET_DATETIME_PATTERN.exec(value);
  if (offsetMatch !== null) {
    const date = offsetMatch[1];
    const time = offsetMatch[2];
    const offset = offsetMatch[3];
    if (date === undefined || time === undefined || offset === undefined) {
      return Number.NaN;
    }
    return Date.parse(`${date}T${time}${normalizedOffset(offset)}`);
  }
  if (DATE_ONLY_PATTERN.test(value)) {
    return Date.parse(`${value}T00:00:00.000Z`);
  }
  return Number.NaN;
}

/**
 * Canonicalizes a database-driver timestamp without interpreting a zoneless
 * string in the host timezone. PostgreSQL drivers can return values such as
 * `2026-06-25 12:00:00`; TypeGraph treats that shape as UTC so the same stored
 * clock value cannot move across hosts or daylight-saving boundaries.
 *
 * Returns `undefined` for an unsupported or unrepresentable value so callers
 * can raise an error specific to their storage boundary.
 */
export function canonicalizeDatabaseTimestamp(
  value: unknown,
): string | undefined {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return undefined;
    return value.toISOString();
  }
  if (typeof value !== "string") return undefined;
  const milliseconds = databaseTimestampMilliseconds(value);
  if (Number.isNaN(milliseconds)) return undefined;
  return new Date(milliseconds).toISOString();
}

/**
 * Checks if a string is a canonical UTC ISO 8601 datetime with fixed
 * millisecond width (`YYYY-MM-DDTHH:mm:ss.sssZ`).
 */
export function isCanonicalIsoDate(value: string): boolean {
  if (!CANONICAL_ISO_DATE_PATTERN.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

/**
 * Validates that a string is a canonical UTC ISO 8601 datetime with fixed
 * millisecond width. Stricter than {@link validateIsoDate} (which also
 * accepts missing or 1–2 digit milliseconds): required wherever the value
 * is compared **as text** against stored timestamps and must sort
 * chronologically — e.g. a temporal `asOf` coordinate, where a
 * variable-width value would mis-order and silently include or exclude the
 * wrong rows. Produce one with `new Date(value).toISOString()`.
 *
 * @param value - String to validate
 * @param fieldName - Name of field for error message
 * @returns The validated string
 * @throws ValidationError if not a canonical UTC ISO datetime
 */
export function validateCanonicalIsoDate(
  value: string,
  fieldName: string,
): string {
  if (!isCanonicalIsoDate(value)) {
    throw new ValidationError(
      `Invalid canonical ISO 8601 datetime for "${fieldName}": "${value}". ` +
        `Expected fixed-width UTC: YYYY-MM-DDTHH:mm:ss.sssZ`,
      {
        issues: [
          {
            path: fieldName,
            message: `Expected canonical UTC ISO 8601 (YYYY-MM-DDTHH:mm:ss.sssZ), got: "${value}"`,
          },
        ],
      },
      {
        suggestion: `Use a fixed-width UTC datetime like "2024-01-15T10:30:00.000Z" (e.g. new Date(value).toISOString()).`,
      },
    );
  }
  return value;
}

/**
 * Validates an optional canonical ISO date string. Returns `undefined` for an
 * absent value; otherwise enforces canonical fixed-width UTC ISO 8601 via
 * {@link validateCanonicalIsoDate}. Used for stored validity-window inputs
 * (`validFrom` / `validTo`) so every timestamp the temporal filters compare as
 * text is canonical and sorts chronologically — the same contract the `asOf`
 * read coordinate already enforces.
 */
export function validateOptionalCanonicalIsoDate(
  value: string | undefined,
  fieldName: string,
): string | undefined {
  if (value === undefined) return undefined;
  return validateCanonicalIsoDate(value, fieldName);
}

/**
 * Whether a CANONICAL stated bound names the same instant a row already stores.
 *
 * The one comparison of a caller's bound against a stored one, so the coalesce
 * dirty check ("would this write move the window?") and the write guard ("can
 * this stated bound be applied?") can never disagree about what "the same bound"
 * means. Two copies of it did disagree — one comparing driver text, one
 * comparing instants — which is how a re-stated window wrote on one backend and
 * coalesced on the other.
 *
 * Only the STORED side is canonicalized. It arrives as the driver rendered it,
 * and the dialects do not render a timestamp the same way (SQLite returns the
 * written text; a Postgres driver may hand back a zoned string equivalent to the
 * canonical form without being identical to it). The stated side needs no
 * canonicalization because every write path validates it as canonical first —
 * which is a PRECONDITION here, not an assumption: a non-canonical stated bound
 * would compare unequal to an equivalent stored instant and must be rejected by
 * {@link validateCanonicalIsoDate} rather than silently treated as a mismatch.
 */
export function statedBoundMatchesStored(
  stated: string,
  stored: string | undefined,
): boolean {
  return stated === canonicalizeDatabaseTimestamp(stored);
}

/**
 * Whether a stated validity window has NEGATIVE width — a row that stopped
 * being true before it started. The one comparison every window refusal is
 * built on, so paths that must report the fault through their own error type
 * (trusted import) decide it identically to the ones that throw a
 * `ValidationError`.
 *
 * PRECONDITION: both endpoints are canonical fixed-width UTC ISO 8601, which is
 * what makes a lexicographic compare a chronological one. Every caller
 * establishes that before comparing, with no exception: the paths that throw a
 * `ValidationError` reach this through {@link validateOptionalCanonicalIsoDate},
 * and trusted import — which skips schema validation for throughput —
 * format-checks the stated window fields of every streamed row against
 * {@link isCanonicalIsoDate} before reaching here. A bound read back from a row
 * needs no check of its own: it is canonical because the write that stored it
 * was held to this same contract — SQLite hands that text back verbatim, and the
 * PostgreSQL row mapper normalizes the driver's shape back to it. So no caller
 * can compare a value that would mis-sort, here or later against an `asOf`
 * coordinate.
 *
 * ZERO width (`validFrom === validTo`) is not inverted: it is what a
 * same-instant retraction produces at millisecond precision, and the store's own
 * output must round-trip.
 */
export function isInvertedValidityWindow(
  validFrom: string | undefined,
  validTo: string | undefined,
): boolean {
  if (validFrom === undefined || validTo === undefined) return false;
  return validFrom > validTo;
}

/**
 * Whether a validity window is readable at NO instant — inverted OR zero width.
 * The CHOICE predicate, sibling to {@link isInvertedValidityWindow}'s REFUSAL
 * predicate, and the two answer different questions on purpose:
 *
 *  - a window a caller STATED in full is refused only when it is inverted, because
 *    zero width is what a same-instant retraction produces and the store's own
 *    output must round-trip;
 *  - a bound a write CHOOSES for a caller who stated none must never satisfy this
 *    one, because a row nobody can read at any coordinate is not a window the
 *    caller asked for.
 *
 * `inverted ⇒ empty`, and `empty ∧ ¬inverted ⟺ zero width`. That law is a
 * property in `tests/property/temporal-window.test.ts`, so the pair cannot drift
 * into disagreeing about anything but the boundary they deliberately differ on.
 *
 * PRECONDITION: as {@link isInvertedValidityWindow} — both endpoints canonical
 * fixed-width UTC ISO 8601, so the lexicographic compare is a chronological one.
 */
export function isEmptyValidityWindow(
  validFrom: string | undefined,
  validTo: string | undefined,
): boolean {
  if (validFrom === undefined || validTo === undefined) return false;
  return validFrom >= validTo;
}

/**
 * Whether a canonical instant belongs to the half-open validity interval
 * `[validFrom, validTo)`. An omitted bound is unbounded on that side.
 *
 * This is the single JavaScript owner of validity-window membership. SQL read
 * paths express the same decision through the shared temporal compiler.
 */
export function validityWindowContainsInstant(
  validFrom: string | undefined,
  validTo: string | undefined,
  instant: string,
): boolean {
  return (
    (validFrom === undefined || validFrom <= instant) &&
    (validTo === undefined || instant < validTo)
  );
}

/**
 * THE lower bound a write that STAMPS its own start stores, decided against the
 * instant it is about to stamp. One owner for every such write, so no two of them
 * can spell the decision differently. Three inputs, three outcomes:
 *
 *  - a stated `null`   → no lower bound (a CONFIRMED open-left window, which is
 *                        how interchange round-trips a row that has none);
 *  - a stated string   → that bound, the caller's own assertion, verbatim;
 *  - nothing stated    → the write instant, UNLESS stamping it would leave the
 *                        window readable at no instant. A row carrying only a
 *                        `validTo` at or before the write instant is "born already
 *                        ended": its start is UNKNOWN, not at-or-after its end, so
 *                        it stores no lower bound and reads back at every `asOf`
 *                        before that end (issue #407).
 *
 * The comparison against `validTo` is NON-STRICT: `validTo === writeInstant`
 * stores no bound too. A stamped `[T, T)` is a successful write no coordinate can
 * observe, and the millisecond of skew between a caller's own `Date.now()` and the
 * backend's sample is enough to land there — so the rule is total, and there is no
 * input for which a stamped bound yields an empty window.
 *
 * The write instant is a PARAMETER, not a clock read: the caller passes the very
 * value it binds into `created_at`/`updated_at` (or, for a resurrection, the
 * instant its guard judged), so the decision and the stamp cannot come from two
 * different samples (issue #413's failure mode). This function has no way to
 * sample a clock, which is what makes that structural rather than tested.
 *
 * PRECONDITION: as {@link isEmptyValidityWindow}. This is called BELOW the
 * validation boundary, on a public `GraphBackend` surface, so canonicality is
 * established by whoever reached the backend: store paths through
 * {@link validateOptionalCanonicalIsoDate}, interchange import through its own
 * window validator, trusted import through its per-chunk format check. A direct
 * `GraphBackend` caller establishes it itself — a pre-existing property of that
 * surface, written down here rather than left implicit.
 */
export function resolveStampedValidityLowerBound(
  statedValidFrom: string | null | undefined,
  validTo: string | undefined,
  writeInstant: string,
): string | undefined {
  if (statedValidFrom === null) return undefined;
  if (statedValidFrom !== undefined) return statedValidFrom;
  return isEmptyValidityWindow(writeInstant, validTo) ? undefined : (
      writeInstant
    );
}

/**
 * The lower bound a write that PASSES THROUGH a stated one stores: `null` — the
 * interchange spelling of a confirmed open-left window — becomes "no bound", and
 * a string is stored verbatim.
 *
 * Separate from {@link resolveStampedValidityLowerBound} because it answers a
 * different question. Its one caller (`buildUpdateEdge`'s resurrection leg) writes
 * the window only when the caller NAMED a lower bound; an edge resurrection that
 * names none RETAINS the stored window rather than choosing a new one, so there is
 * no instant to judge and none is offered.
 */
export function resolveStatedValidityLowerBound(
  validFrom: string | null,
): string | undefined {
  return validFrom ?? undefined;
}

/**
 * Refuses a `validTo` whose EFFECTIVE lower bound would invert the window. On an
 * in-place update the row's stored lower bound is the effective one and must stay
 * <= the new `validTo`; on a resurrection that RESETS `valid_from` it is the
 * write instant, so a lone past `validTo` would be born inverted.
 *
 * A ZERO-width window (`validTo === effectiveValidFrom`) is legal and stays
 * legal: it is what a same-instant retraction produces at millisecond
 * precision, and the identity-import window check sanctions it for the same
 * reason. Only NEGATIVE width refuses.
 *
 * Reached through {@link assertWritableValidityWindow} rather than called
 * directly, so no writer can check the effective bound without also checking a
 * stated pair.
 */
function assertEffectiveValidityLowerBound(
  subject: string,
  effectiveValidFrom: string | undefined,
  validTo: string | undefined,
): void {
  if (!isInvertedValidityWindow(effectiveValidFrom, validTo)) return;
  throw new ValidationError(
    `Inverted validity window for ${subject}: the effective validFrom "${effectiveValidFrom}" is after validTo "${validTo}".`,
    {
      issues: [
        {
          path: "validTo",
          code: INVERTED_VALIDITY_WINDOW_CODE,
          message: `Expected the effective validFrom <= validTo, got "${effectiveValidFrom}" > "${validTo}". The effective validFrom is the row's stored lower bound, or the write instant where the write stamps one.`,
        },
      ],
    },
    {
      suggestion:
        "Provide both validFrom and validTo for a historical window, or drop validTo to keep the row current.",
    },
  );
}

/**
 * Rejects an inverted validity window. `validFrom > validTo` describes a row
 * that stopped being true before it started, so no current-mode or `asOf` read
 * can ever observe it — the write succeeds and the row is then reachable only
 * through `includeEnded`, which reads as data loss rather than as the error it
 * is. Call this wherever both endpoints are supplied together; both are
 * canonical ISO 8601 by then, so a lexicographic compare is a chronological
 * compare.
 *
 * @param subject - Human-readable identification of the row, for the message
 *   (e.g. `Person "01H..."`).
 * @throws ValidationError if both endpoints are present and out of order
 */
export function assertOrderedValidityWindow(
  subject: string,
  validFrom: string | undefined,
  validTo: string | undefined,
): void {
  if (!isInvertedValidityWindow(validFrom, validTo)) return;
  throw new ValidationError(
    `Inverted validity window for ${subject}: validFrom "${validFrom}" is after validTo "${validTo}".`,
    {
      issues: [
        {
          path: "validFrom",
          code: INVERTED_VALIDITY_WINDOW_CODE,
          message: `Expected validFrom <= validTo, got "${validFrom}" > "${validTo}"`,
        },
      ],
    },
    {
      suggestion:
        "Pass a validFrom at or before validTo, or omit validTo to leave the window open.",
    },
  );
}

/**
 * What an UPDATE will do with the row's validity lower bound — the two facts the
 * write guard needs, stated by the writer that knows them.
 *
 * Every update path must decide `appliesStatedValidFrom` explicitly, because the
 * answer is not a property of the guard's other arguments: the same
 * `(validFrom, storedBound, validTo)` triple is a legal window restatement on a
 * resurrection and an unappliable bound on an in-place update.
 */
export type UpdateValidityLowerBound = Readonly<{
  /**
   * The bound the row will hold when the caller states no `validFrom`: the
   * stored `valid_from` for an in-place update, the write instant for a
   * resurrection that stamps a new one, `undefined` where there is no bound to
   * invert against.
   */
  effectiveValidFrom: string | undefined;
  /**
   * Whether the write STORES a stated `validFrom`. False for an in-place update
   * of a live row — `buildUpdateNode` / `buildUpdateEdge` rewrite `valid_from`
   * only on a resurrection — which is what makes a differing stated bound a
   * refusal rather than a silent drop.
   */
  appliesStatedValidFrom: boolean;
  /**
   * Whether `effectiveValidFrom` IS the row's stored `valid_from` — the value an
   * `expectedValidFrom` predicate would name — rather than a bound this write is
   * about to stamp itself.
   *
   * A node resurrection resets `valid_from` to the write instant and passes THAT
   * as the effective bound, so its verdict never looked at what the row holds and
   * a fence on the stored value would predicate the write on something nothing
   * read. An edge retains its bound through a resurrection, so its effective
   * bound is the stored one on both legs.
   */
  effectiveBoundIsStored: boolean;
}>;

/**
 * The `expectedValidFrom` predicate a write owes its verdict, shaped for
 * spreading straight into the backend's update params.
 *
 * `{}` means "assert nothing"; `{ expectedValidFrom: null }` means "assert the
 * row still has NO lower bound". The two are different claims and the object
 * form keeps them distinguishable at every call site — see
 * `UpdateNodeParams.expectedValidFrom`.
 */
export type ValidityLowerBoundFence = Readonly<{
  expectedValidFrom?: string | null;
}>;

/**
 * Whether a {@link ValidityLowerBoundFence} STATES anything. Returns a
 * boolean, despite the `asserts` in its name reading like a TypeScript
 * assertion function: it answers "does this fence assert the row's stored
 * lower bound?".
 *
 * THE SINGLE OWNER of that question, placed beside the type it decides about.
 * Two spellings of it existed — `args.expectedValidFrom !== undefined` at the
 * write step that carries the fence into the UPDATE, and a key-membership test
 * wherever a fence had to be recognised as empty. They agree today under
 * `exactOptionalPropertyTypes`, which is exactly the state in which a second
 * implementation of an existing decision is still a defect: the copies WILL
 * drift, and this one decides whether a write is fenced at all.
 *
 * `{ expectedValidFrom: null }` is a STATED fence — "assert the row still has
 * NO lower bound" — not an empty one, which is why the test is against
 * `undefined` and not against nullishness.
 */
export function assertsStoredLowerBound<T extends ValidityLowerBoundFence>(
  fence: T,
): fence is T & StatedValidityLowerBoundFence {
  return fence.expectedValidFrom !== undefined;
}

/**
 * A {@link ValidityLowerBoundFence} that states a bound — what
 * {@link assertsStoredLowerBound} narrows to, so a caller that has asked the
 * question does not have to re-ask it to satisfy `exactOptionalPropertyTypes`.
 * Re-asking is how the second spelling gets reintroduced.
 */
export type StatedValidityLowerBoundFence = Readonly<{
  expectedValidFrom: string | null;
}>;

/**
 * The `expectedValidTo` predicate a write owes a verdict that read the row's
 * stored window END, shaped for spreading straight into the update params.
 *
 * The counterpart of {@link ValidityLowerBoundFence}, and stated separately for
 * the same reason: `{}` means "assert nothing" and `{ expectedValidTo: null }`
 * means "assert the row is still open-ended". A reopen of an `oneActive` edge
 * judged the end the row carried, so its UPDATE asserts it.
 */
export type ValidityUpperBoundFence = Readonly<{
  expectedValidTo?: string | null;
}>;

/**
 * Whether a {@link ValidityUpperBoundFence} STATES anything — the single owner
 * of that question, for the same reason {@link assertsStoredLowerBound} is the
 * single owner of its own.
 */
export function assertsStoredUpperBound<T extends ValidityUpperBoundFence>(
  fence: T,
): fence is T & Readonly<{ expectedValidTo: string | null }> {
  return fence.expectedValidTo !== undefined;
}

/**
 * What {@link assertWritableValidityWindow} reports back about the verdict it
 * just reached — not about the window, but about what the verdict DEPENDED ON.
 *
 * THE SINGLE OWNER of the question "must this write assert the row's stored
 * lower bound?", and it answers by handing over the predicate ITSELF rather than
 * a flag a caller then turns into one. A write asserts every component its
 * verdict read (see `UpdateNodeParams.expectedValidFrom`), and which components
 * those are is decided by which branches the guard actually took — so a caller
 * that could still spell the fence on its own would eventually spell a different
 * one. Interchange import did exactly that: it asserted the probed
 * `valid_from` unconditionally, over-fencing props-only updates the store paths
 * (correctly) left unfenced. There is now nothing to re-derive.
 *
 * Too FEW assertions is a silent race; too many is a refusal of writes that are
 * legitimate. Both failures come from a second spelling.
 */
export type ValidityWindowVerdict = Readonly<{
  /**
   * The fence this verdict obliges the write to carry. Non-empty when the
   * verdict consulted the row's STORED `valid_from` — either by comparing a
   * stated bound against it, or by inverting a lone `validTo` against it — and
   * empty when the caller named no window at all, when the write applies the
   * bound it stated, or when the effective bound was one this write will stamp
   * rather than one the row holds. In those cases the verdict is independent of
   * what the row carries, and predicating the write on it would refuse a
   * concurrent recreate that changed nothing this decision looked at.
   */
  storedLowerBoundFence: ValidityLowerBoundFence;
}>;

/**
 * Whether an upsert explicitly treats its stated lower bound as
 * create/resurrection-only input.
 *
 * This predicate owns the policy decision for both write execution and
 * unchanged-upsert coalescing, so those paths cannot drift on whether a live
 * row's stored lower bound is preserved.
 */
export function preservesImmutableLowerBound(
  policy: "preserve" | "refuse" | undefined,
): policy is "preserve" {
  return policy === "preserve";
}

/**
 * Refuses a stated `validFrom` the write would not apply.
 *
 * A live row's lower bound is HISTORY: it records when the row started being
 * true, and an in-place update never moves it. Accepting a bound that names a
 * different instant and then dropping it is the API lying — the caller's stated
 * window silently is not the stored one, while the write still spends a version
 * bump and a history row moving nothing. Restating the bound the row already
 * holds stays legal, so a caller that echoes a row's own window back (a merge
 * commit, a re-delivered upsert) is unaffected.
 *
 * Reached through {@link assertWritableValidityWindow} rather than called
 * directly, so no writer can accept a lower bound without declaring whether it
 * applies one.
 */
function assertStatedLowerBoundIsApplicable(
  subject: string,
  statedValidFrom: string,
  storedValidFrom: string | undefined,
): void {
  if (statedBoundMatchesStored(statedValidFrom, storedValidFrom)) return;
  const storedDescription =
    storedValidFrom === undefined ?
      "the row has no lower bound"
    : `the row's stored lower bound is "${storedValidFrom}"`;
  throw new ValidationError(
    `Unappliable validFrom for ${subject}: stated "${statedValidFrom}", but ${storedDescription} and the row is live.`,
    {
      issues: [
        {
          path: "validFrom",
          code: IMMUTABLE_VALIDITY_LOWER_BOUND_CODE,
          message: `A live row's lower bound is history and an in-place update never rewrites it, so "${statedValidFrom}" could not be applied.`,
        },
      ],
    },
    {
      suggestion:
        storedValidFrom === undefined ?
          "Omit validFrom: this row has no lower bound to restate, and only a resurrection can give it one."
        : `Restate the stored bound ("${storedValidFrom}") or omit validFrom.`,
    },
  );
}

/**
 * THE window-ordering guard a valid-time UPDATE goes through, identically for
 * nodes and edges. Refuses a window of negative width — a row that stopped
 * being true before it started — whether the caller states both endpoints or
 * only the new end. Also refuses a stated lower bound the write cannot apply,
 * so no update accepts a `validFrom` it will ignore.
 *
 * Three checks, because the failures deserve different messages: the caller who
 * supplied both endpoints out of order gets told about the pair, the caller who
 * stated a lower bound this write cannot store gets told which bound the row
 * holds, and the caller whose lone `validTo` inverts against the bound the row
 * will actually carry gets told which bound that is.
 *
 * The stated pair is judged FIRST — an inverted pair is wrong whatever the row
 * holds — and the applicability of the lower bound before the effective-bound
 * check, so a caller is told their bound will not be stored rather than being
 * told about a bound they did not name.
 *
 * INSERTS use {@link assertOrderedValidityWindow} alone, and that is now the
 * COMPLETE stated-pair rule rather than a partial one. An insert carrying a lone
 * historical `validTo` means "born already ended", and there is no bound to hold
 * the caller to because the write stamps none:
 * {@link resolveStampedValidityLowerBound} stores no lower bound whenever the
 * instant it would stamp cannot precede the stated end (I1b). So no insert path
 * can store a window readable at no coordinate, on any `GraphBackend` caller —
 * the decision lives in the SQL builders, below the store, below interchange and
 * below trusted import (I5). Only an UPDATE has a lower bound the caller can be
 * held to.
 *
 * @param subject - Human-readable identification of the row, for the message
 *   (e.g. `Person "01H..."`).
 * @param validFrom - The caller's explicit lower bound, if any.
 * @param lowerBound - What the write will do with the row's lower bound; see
 *   {@link UpdateValidityLowerBound}.
 * @returns {@link ValidityWindowVerdict} — the `expectedValidFrom` fence this
 *   verdict obliges the write to carry, empty when it read no stored bound.
 * @throws ValidationError with issue code {@link INVERTED_VALIDITY_WINDOW_CODE}
 *   or {@link IMMUTABLE_VALIDITY_LOWER_BOUND_CODE}
 */
export function assertWritableValidityWindow(
  subject: string,
  validFrom: string | undefined,
  lowerBound: UpdateValidityLowerBound,
  validTo: string | undefined,
): ValidityWindowVerdict {
  assertOrderedValidityWindow(subject, validFrom, validTo);

  // The stated bound is COMPARED against the stored one only here — a write
  // that applies what the caller stated has nothing to compare it to.
  const comparedStatedBound =
    validFrom !== undefined && !lowerBound.appliesStatedValidFrom;
  if (comparedStatedBound) {
    assertStatedLowerBoundIsApplicable(
      subject,
      validFrom,
      lowerBound.effectiveValidFrom,
    );
  }

  assertEffectiveValidityLowerBound(
    subject,
    validFrom ?? lowerBound.effectiveValidFrom,
    validTo,
  );
  // ...and the inversion check falls back to the row's bound only when the
  // caller named an end without a start. Note this is true whether or not the
  // row HAS a bound: "no lower bound to invert against" is itself a reading of
  // the row, and a recreate that gives the row one changes the answer.
  const comparedStoredBoundAgainstEnd =
    validFrom === undefined && validTo !== undefined;

  const readEffectiveLowerBound =
    comparedStatedBound || comparedStoredBoundAgainstEnd;
  return {
    storedLowerBoundFence:
      readEffectiveLowerBound && lowerBound.effectiveBoundIsStored ?
        // eslint-disable-next-line unicorn/no-null -- `expectedValidFrom` distinguishes "assert IS NULL" (null) from "assert nothing" (an absent key); see UpdateNodeParams.
        { expectedValidFrom: lowerBound.effectiveValidFrom ?? null }
      : {},
  };
}

/**
 * Encodes a Date to an ISO 8601 string for storage.
 */
export function encodeDate(date: Date): string {
  return date.toISOString();
}

/**
 * Decodes an ISO 8601 string to a Date.
 * Validates the string format first.
 *
 * @throws ValidationError if not a valid ISO datetime
 */
export function decodeDate(isoString: string): Date {
  validateIsoDate(isoString, "date");
  return new Date(isoString);
}

/**
 * Returns the current timestamp as an ISO string.
 */
export function nowIso(): string {
  return new Date().toISOString();
}
