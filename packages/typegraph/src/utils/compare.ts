/**
 * Deterministic UTF-16 code-unit string comparison.
 *
 * `localeCompare` (and any `Intl`-backed collation) varies with the host's
 * ICU configuration, so two processes can order the same strings differently
 * — which turns "sorted" lock-acquisition sequences into cross-process
 * deadlocks and makes result/report ordering flap between environments.
 * Code-unit order is identical everywhere, matches SQLite's BINARY collation
 * for ASCII identifiers, and sorts NUL below every other character, so
 * NUL-separated composite keys compare as true tuples.
 *
 * Use this (or `Array.prototype.toSorted()` with no comparator, which is the
 * same order) for every internal ordering; locale-aware collation belongs
 * only in user-facing presentation code, which this library does not have.
 */
export function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}
