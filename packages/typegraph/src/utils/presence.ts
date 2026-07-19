/**
 * Predicate for values that are materially present in database rows.
 */
export function isPresent(value: unknown): boolean {
  return value !== null && value !== undefined;
}

/**
 * Narrows a value after a runtime presence check. Prefer this to a non-null
 * assertion: an invalid invariant fails at the point where it is assumed,
 * with a stable error instead of propagating `undefined` into unrelated code.
 */
export function requireDefined<T>(
  value: T,
  message = "Expected a defined value.",
): NonNullable<T> {
  if (value === undefined || value === null) throw new TypeError(message);
  return value;
}
