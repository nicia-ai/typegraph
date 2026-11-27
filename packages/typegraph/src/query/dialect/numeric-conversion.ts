/** Exact round-to-nearest overflow boundary for IEEE-754 binary64. */
export const DOUBLE_OVERFLOW_BOUNDARY = String(2n ** 1024n - 2n ** 970n);

/** Exact integer value of the largest finite IEEE-754 binary64. */
export const MAXIMUM_FINITE_DOUBLE_INTEGER = String(2n ** 1024n - 2n ** 971n);

/** Shortest decimal text that round-trips to the largest finite binary64. */
export const MAXIMUM_FINITE_DOUBLE_TEXT = "1.7976931348623157e308";

/**
 * The decimal float text a database renders a double as: an optional sign,
 * digits with an optional fraction, and an optional exponent. Leading or
 * trailing space, hexadecimal, a lone sign or `.` are not.
 */
const DECIMAL_FLOAT_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

/** Whether decimal float text denotes zero: every digit is 0. */
function denotesZero(text: string): boolean {
  const mantissa = text.replace(/e.*$/i, "");
  return !/[1-9]/.test(mantissa);
}

/**
 * The binary64 value decimal float `text` denotes, or `undefined` when the
 * text is not decimal float text or is outside what a binary64 holds: it
 * overflows to an infinity, or a nonzero value underflows to zero. The one
 * owner of "can a double hold this text": PostgreSQL's `double precision`
 * input and SQLite's REAL refuse or lose exactly those, so a dialect checks
 * a cursor's relevance key here before binding it.
 */
export function parseRepresentableDouble(text: string): number | undefined {
  if (!DECIMAL_FLOAT_TEXT.test(text)) return undefined;
  const value = Number(text);
  if (!Number.isFinite(value)) return undefined;
  if (value === 0 && !denotesZero(text)) return undefined;
  return value;
}
