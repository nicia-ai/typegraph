/**
 * Date encoding utilities for consistent storage.
 *
 * Contract: All dates are stored as ISO 8601 strings in UTC.
 * - Always includes milliseconds
 * - Always UTC (Z suffix)
 * - Sorts correctly as strings
 */

import { INVERTED_VALIDITY_WINDOW_CODE, ValidationError } from "../errors";

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
 * THE window-ordering guard a valid-time UPDATE goes through, identically for
 * nodes and edges. Refuses a window of negative width — a row that stopped
 * being true before it started — whether the caller states both endpoints or
 * only the new end.
 *
 * Two checks, because the two failures deserve different messages: the caller
 * who supplied both endpoints out of order gets told about the pair, and the
 * caller whose lone `validTo` inverts against the bound the row will actually
 * carry gets told which bound that is.
 *
 * INSERTS use {@link assertOrderedValidityWindow} alone. An insert carrying a
 * lone historical `validTo` means "born already ended", and the write instant
 * the backend stamps as `valid_from` is a storage convention rather than a
 * caller assertion — the row is deliberately not current and is read back
 * through `includeEnded`. Only an UPDATE has a lower bound the caller can be
 * held to.
 *
 * @param subject - Human-readable identification of the row, for the message
 *   (e.g. `Person "01H..."`).
 * @param validFrom - The caller's explicit lower bound, if any.
 * @param fallbackValidFrom - The lower bound the row carries when the caller
 *   supplies none: the stored `valid_from` for an in-place update, the write
 *   instant for a resurrection that resets it, `undefined` where there is no
 *   bound to invert against.
 * @throws ValidationError with issue code {@link INVERTED_VALIDITY_WINDOW_CODE}
 */
export function assertWritableValidityWindow(
  subject: string,
  validFrom: string | undefined,
  fallbackValidFrom: string | undefined,
  validTo: string | undefined,
): void {
  assertOrderedValidityWindow(subject, validFrom, validTo);
  assertEffectiveValidityLowerBound(
    subject,
    validFrom ?? fallbackValidFrom,
    validTo,
  );
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
