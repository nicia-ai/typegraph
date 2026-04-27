/**
 * Get-or-create with LRU eviction on a `Map`.
 *
 * Map insertion order is the LRU order: cache hits delete + reinsert
 * the entry to promote it to most-recently-used; on miss, the oldest
 * entry is evicted once the map exceeds `cacheMax`. Used by both the
 * PostgreSQL prepared-statement-name cache and the SQLite prepared-
 * statement cache.
 */
export function getOrCreateLru<K, V>(
  cache: Map<K, V>,
  key: K,
  cacheMax: number,
  create: () => V,
): V {
  const cached = cache.get(key);
  if (cached !== undefined) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const value = create();
  cache.set(key, value);
  if (cache.size > cacheMax) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return value;
}
