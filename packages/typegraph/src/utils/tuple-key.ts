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

/**
 * The injective map key for a node reference: {@link encodeTupleKey} over
 * `(kind, id)`. Node ids are arbitrary caller data, so a delimiter join could
 * collapse two distinct references onto one key.
 */
export function nodeRefKey(
  ref: Readonly<{ kind: string; id: string }>,
): string {
  return encodeTupleKey([ref.kind, ref.id]);
}
