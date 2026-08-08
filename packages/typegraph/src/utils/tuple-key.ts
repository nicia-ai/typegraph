/**
 * Encodes an ordered tuple of strings as an injective map key.
 *
 * Delimiter joins are unsafe because every delimiter is also a legal value
 * character. JSON's string-array grammar preserves both field boundaries and
 * string contents, so distinct tuples cannot collapse onto the same key.
 */
export function encodeTupleKey(values: readonly string[]): string {
  return JSON.stringify(values);
}
