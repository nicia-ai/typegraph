/** Exact round-to-nearest overflow boundary for IEEE-754 binary64. */
export const DOUBLE_OVERFLOW_BOUNDARY = String(2n ** 1024n - 2n ** 970n);

/** Exact integer value of the largest finite IEEE-754 binary64. */
export const MAXIMUM_FINITE_DOUBLE_INTEGER = String(2n ** 1024n - 2n ** 971n);

/** Shortest decimal text that round-trips to the largest finite binary64. */
export const MAXIMUM_FINITE_DOUBLE_TEXT = "1.7976931348623157e308";
