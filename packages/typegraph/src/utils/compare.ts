import { requireDefined } from "./presence";
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

/**
 * Deterministic code-point string comparison — the order a SQL engine uses.
 *
 * {@link compareStrings} compares UTF-16 code *units*, which disagrees with
 * SQL byte order for astral characters: `"\u{10000}"` is stored as the
 * surrogate pair `𐀀`, so code-unit order sorts it below `""`
 * even though its code point (and its UTF-8 encoding) is far above. SQLite's
 * `BINARY` collation, Postgres's `C` collation, and UTF-8 byte order all agree
 * with code-point order.
 *
 * Use this wherever a JS-side ordering must reproduce an ORDER BY the database
 * could equally have performed — notably the hybrid-search fusion fallback,
 * whose ranks and page boundary must match the single-statement SQL path row
 * for row. Everywhere else {@link compareStrings} is cheaper and sufficient.
 */
export function compareCodePoints(left: string, right: string): number {
  if (left === right) return 0;
  // Walks by code point, stepping over the low surrogate of an astral pair.
  // `codePointAt` at a valid index always yields a number.
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftPoint = requireDefined(left.codePointAt(leftIndex));
    const rightPoint = requireDefined(right.codePointAt(rightIndex));
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
    leftIndex += leftPoint > 0xff_ff ? 2 : 1;
    rightIndex += rightPoint > 0xff_ff ? 2 : 1;
  }
  const leftExhausted = leftIndex >= left.length;
  const rightExhausted = rightIndex >= right.length;
  if (leftExhausted && rightExhausted) return 0;
  return leftExhausted ? -1 : 1;
}
