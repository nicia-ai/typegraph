/**
 * Splits `items` into consecutive chunks of at most `size` elements.
 *
 * An empty input yields no chunks (`[]`), and an input that already fits in a
 * single chunk is returned without copying. Callers rely on the empty-input
 * behavior to skip work entirely rather than issue a statement with an empty
 * `IN ()` list.
 */
export function chunk<T>(
  items: readonly T[],
  size: number,
): readonly (readonly T[])[] {
  // A non-positive, non-finite, or fractional size would make the slice loop
  // fail to advance correctly; fail loud rather than spin or emit empty chunks.
  // All current callers derive size from a positive integer bind-parameter
  // budget, so this only guards against a future regression.
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new RangeError(`chunk size must be a positive integer, got: ${size}`);
  }
  if (items.length === 0) return [];
  if (items.length <= size) return [items];
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

/**
 * Groups items by a caller-supplied key while preserving input order within
 * each group.
 */
export function groupBy<T, K>(
  items: Iterable<T>,
  keyFor: (item: T) => K,
): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}
